#!/usr/bin/env node

/**
 * Generic MCP client for chrome-devtools-mcp over stdio.
 *
 * Usage:
 *   node chrome-devtools-runner.js "open https://example.com"
 *   node chrome-devtools-runner.js "click #login"
 *   node chrome-devtools-runner.js "type #email test@example.com"
 *   node chrome-devtools-runner.js --debug "open https://example.com then title"
 *   node chrome-devtools-runner.js --ensure-cdp "open http://localhost:3000"
 *   node chrome-devtools-runner.js --browser-url http://127.0.0.1:9222 "title"
 *
 * Notes:
 * - stdio MCP requires the client to own the server process. This script starts
 *   the server command locally and talks JSON-RPC over stdio.
 * - By default, chrome-devtools-mcp starts and manages Chrome itself.
 * - Use --browser-url to connect to a running Chrome DevTools Protocol endpoint.
 * - Use --ensure-cdp to start Chrome with CDP when the endpoint is not running.
 * - Override the server command with MCP_SERVER_COMMAND if needed.
 *   Default: npx -y chrome-devtools-mcp@latest
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const BASE_SERVER_COMMAND = 'npx -y chrome-devtools-mcp@latest';
const DEFAULT_SERVER_COMMAND = process.env.MCP_SERVER_COMMAND || BASE_SERVER_COMMAND;
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_WAIT_TIMEOUT_MS = 10000;
const DEFAULT_CDP_HOST = '127.0.0.1';
const DEFAULT_CDP_PORT = 9222;
const DEFAULT_CDP_STARTUP_TIMEOUT_MS = 10000;
const DEFAULT_CHROME_LOG_FILE = path.join(os.tmpdir(), 'chrome-devtools-runner.chrome.log');

function parseArgs(argv) {
    const args = [...argv];
    let debug = false;
    let showTools = false;
    let showToolSchemas = false;
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    let serverCommand = process.env.MCP_SERVER_COMMAND || null;
    let browserUrl = null;
    let ensureCdp = false;
    let cdpHost = DEFAULT_CDP_HOST;
    let cdpPort = DEFAULT_CDP_PORT;
    let cdpStartupTimeoutMs = DEFAULT_CDP_STARTUP_TIMEOUT_MS;
    let chromePath = process.env.CHROME_PATH || null;
    let chromeUserDataDir = process.env.CHROME_USER_DATA_DIR || null;
    let chromeLogFile = process.env.CHROME_LOG_FILE || DEFAULT_CHROME_LOG_FILE;
    let reuseChromeProfile = false;
    const instructionParts = [];

    while (args.length > 0) {
        const rawValue = args.shift();
        const {name: value, inlineValue} = splitOption(rawValue);

        if (value === '--debug') {
            debug = true;
            continue;
        }

        if (value === '--show-tools') {
            showTools = true;
            continue;
        }

        if (value === '--show-tool-schemas') {
            showToolSchemas = true;
            continue;
        }

        if (value === '--timeout' && hasOptionValue(inlineValue, args)) {
            timeoutMs = Number(takeOptionValue(inlineValue, args));
            continue;
        }

        if (value === '--server-command' && hasOptionValue(inlineValue, args)) {
            serverCommand = takeOptionValue(inlineValue, args);
            continue;
        }

        if ((value === '--browser-url' || value === '--browserUrl') && hasOptionValue(inlineValue, args)) {
            browserUrl = takeOptionValue(inlineValue, args);
            continue;
        }

        if (value === '--ensure-cdp') {
            ensureCdp = true;
            continue;
        }

        if (value === '--cdp-host' && hasOptionValue(inlineValue, args)) {
            cdpHost = takeOptionValue(inlineValue, args);
            continue;
        }

        if (value === '--cdp-port' && hasOptionValue(inlineValue, args)) {
            cdpPort = Number(takeOptionValue(inlineValue, args));
            continue;
        }

        if (value === '--cdp-startup-timeout' && hasOptionValue(inlineValue, args)) {
            cdpStartupTimeoutMs = Number(takeOptionValue(inlineValue, args));
            continue;
        }

        if (value === '--chrome-path' && hasOptionValue(inlineValue, args)) {
            chromePath = takeOptionValue(inlineValue, args);
            continue;
        }

        if (value === '--chrome-user-data-dir' && hasOptionValue(inlineValue, args)) {
            chromeUserDataDir = takeOptionValue(inlineValue, args);
            continue;
        }

        if (value === '--chrome-log-file' && hasOptionValue(inlineValue, args)) {
            chromeLogFile = takeOptionValue(inlineValue, args);
            continue;
        }

        if (value === '--reuse-chrome-profile') {
            reuseChromeProfile = true;
            continue;
        }

        instructionParts.push(rawValue);
    }

    return {
        debug,
        showTools,
        showToolSchemas,
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
        cdpPort: Number.isFinite(cdpPort) && cdpPort > 0 ? cdpPort : DEFAULT_CDP_PORT,
        cdpStartupTimeoutMs: Number.isFinite(cdpStartupTimeoutMs) && cdpStartupTimeoutMs > 0
            ? cdpStartupTimeoutMs
            : DEFAULT_CDP_STARTUP_TIMEOUT_MS,
        serverCommand,
        browserUrl,
        ensureCdp,
        cdpHost,
        chromePath,
        chromeUserDataDir,
        chromeLogFile,
        reuseChromeProfile,
        instruction: instructionParts.join(' ').trim(),
    };
}

function splitOption(value) {
    if (!value.startsWith('--')) {
        return {name: value, inlineValue: null};
    }

    const equalsIndex = value.indexOf('=');
    if (equalsIndex === -1) {
        return {name: value, inlineValue: null};
    }

    return {
        name: value.slice(0, equalsIndex),
        inlineValue: value.slice(equalsIndex + 1),
    };
}

function hasOptionValue(inlineValue, args) {
    return inlineValue !== null || args.length > 0;
}

function takeOptionValue(inlineValue, args) {
    return inlineValue !== null ? inlineValue : args.shift();
}

class McpStdioClient {
    constructor(options = {}) {
        this.command = options.command || DEFAULT_SERVER_COMMAND;
        this.debug = Boolean(options.debug);
        this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
        this.child = null;
        this.buffer = '';
        this.nextId = 1;
        this.pending = new Map();
        this.exitPromise = null;
        this.serverInfo = null;
        this.serverCapabilities = {};
        this.tools = [];
    }

    logDebug(...args) {
        if (this.debug) {
            console.error('[debug]', ...args);
        }
    }

    async start() {
        this.logDebug('starting MCP server:', this.command);
        this.child = spawn(this.command, {
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.env,
        });

        this.child.stdout.on('data', chunk => {
            this.buffer += chunk.toString('utf8');
            this.consumeMessages();
        });

        this.child.stderr.on('data', chunk => {
            const text = chunk.toString('utf8').trim();
            if (text) {
                console.error('[mcp-server]', text);
            }
        });

        this.exitPromise = new Promise((resolve, reject) => {
            this.child.once('error', reject);
            this.child.once('exit', (code, signal) => resolve({code, signal}));
        });

        await this.initialize();
        this.tools = await this.listTools();
        return this;
    }

    consumeMessages() {
        while (true) {
            if (this.buffer.startsWith('Content-Length:')) {
                const separatorIndex = this.buffer.indexOf('\r\n\r\n');
                if (separatorIndex === -1) {
                    return;
                }

                const headerText = this.buffer.slice(0, separatorIndex);
                const contentLengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
                if (!contentLengthMatch) {
                    throw new Error(`Missing Content-Length header: ${headerText}`);
                }

                const contentLength = Number(contentLengthMatch[1]);
                const messageStart = separatorIndex + 4;
                const messageEnd = messageStart + contentLength;

                if (this.buffer.length < messageEnd) {
                    return;
                }

                const payload = this.buffer.slice(messageStart, messageEnd);
                this.buffer = this.buffer.slice(messageEnd);
                this.dispatchPayload(payload);
                continue;
            }

            const newlineIndex = this.buffer.indexOf('\n');
            if (newlineIndex === -1) {
                return;
            }

            const payload = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);

            if (!payload) {
                continue;
            }

            this.dispatchPayload(payload);
        }
    }

    dispatchPayload(payload) {
        let message;
        try {
            message = JSON.parse(payload);
        } catch (error) {
            this.logDebug('failed to parse message:', payload);
            throw error;
        }

        this.handleMessage(message);
    }

    handleMessage(message) {
        this.logDebug('recv', JSON.stringify(message));

        if (Object.prototype.hasOwnProperty.call(message, 'id') && this.pending.has(message.id)) {
            const pending = this.pending.get(message.id);
            clearTimeout(pending.timer);
            this.pending.delete(message.id);

            if (message.error) {
                const error = new Error(message.error.message || 'Unknown MCP error');
                error.code = message.error.code;
                error.data = message.error.data;
                pending.reject(error);
                return;
            }

            pending.resolve(message.result);
            return;
        }

        if (message.method === 'ping') {
            this.sendResponse(message.id, {});
            return;
        }

        if (Object.prototype.hasOwnProperty.call(message, 'id')) {
            this.sendError(message.id, -32601, `Unsupported client method: ${message.method}`);
            return;
        }

        this.logDebug('notification', message.method || 'unknown');
    }

    writeMessage(message) {
        const json = JSON.stringify(message);
        this.logDebug('send', json);
        this.child.stdin.write(`${json}\n`);
    }

    sendResponse(id, result) {
        if (typeof id === 'undefined' || id === null) {
            return;
        }

        this.writeMessage({
            jsonrpc: '2.0',
            id,
            result,
        });
    }

    sendError(id, code, message, data) {
        if (typeof id === 'undefined' || id === null) {
            return;
        }

        this.writeMessage({
            jsonrpc: '2.0',
            id,
            error: {
                code,
                message,
                data,
            },
        });
    }

    sendNotification(method, params) {
        const message = {
            jsonrpc: '2.0',
            method,
        };

        if (typeof params !== 'undefined') {
            message.params = params;
        }

        this.writeMessage(message);
    }

    sendRequest(method, params, timeoutMs = this.timeoutMs) {
        const id = this.nextId++;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP request timed out: ${method}`));
            }, timeoutMs);

            this.pending.set(id, {resolve, reject, timer});
            this.writeMessage({
                jsonrpc: '2.0',
                id,
                method,
                params,
            });
        });
    }

    async initialize() {
        const result = await this.sendRequest('initialize', {
            protocolVersion: DEFAULT_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
                name: 'chrome-mcp-client',
                version: '1.0.0',
            },
        });

        this.serverInfo = result.serverInfo || null;
        this.serverCapabilities = result.capabilities || {};

        this.sendNotification('notifications/initialized');
        return result;
    }

    async listTools() {
        const tools = [];
        let cursor;

        while (true) {
            const params = {};
            if (cursor) {
                params.cursor = cursor;
            }

            const result = await this.sendRequest('tools/list', Object.keys(params).length > 0 ? params : undefined);
            tools.push(...(result.tools || []));

            if (!result.nextCursor) {
                break;
            }

            cursor = result.nextCursor;
        }

        return tools;
    }

    async callTool(name, args = {}) {
        return this.sendRequest('tools/call', {
            name,
            arguments: args,
        });
    }

    async close() {
        if (!this.child) {
            return;
        }

        this.child.stdin.end();

        const timeout = setTimeout(() => {
            if (this.child && !this.child.killed) {
                this.child.kill('SIGTERM');
            }
        }, 1000);

        try {
            await this.exitPromise;
        } finally {
            clearTimeout(timeout);
        }
    }
}

class ChromeMcpCli {
    constructor(client, options = {}) {
        this.client = client;
        this.debug = Boolean(options.debug);
        this.browserUrl = options.browserUrl || null;
        this.toolsByName = new Map();
        this.latestSnapshot = null;
        this.currentPageId = null;
        this.currentPageIndex = null;

        for (const tool of client.tools) {
            this.toolsByName.set(tool.name, tool);
        }
    }

    logDebug(...args) {
        if (this.debug) {
            console.error('[debug]', ...args);
        }
    }

    hasTool(...names) {
        return names.some(name => this.toolsByName.has(name));
    }

    async initializeSession() {
        await this.autoSelectPageContext().catch(error => {
            this.logDebug('failed to auto-select page context:', error.message);
        });
    }

    requireTool(...names) {
        for (const name of names) {
            if (this.toolsByName.has(name)) {
                return name;
            }
        }

        throw new Error(`Required tool is not available. Tried: ${names.join(', ')}`);
    }

    parseInstruction(input) {
        const normalized = input.trim();

        if (!normalized) {
            throw new Error('Instruction is required.');
        }

        const segments = normalized
            .split(/\s+(?:then|and)\s+|[\n、]+/i)
            .map(segment => segment.trim())
            .filter(Boolean);

        const actions = [];
        for (const segment of segments) {
            actions.push(this.parseSegment(segment));
        }

        return actions;
    }

    parseSegment(segment) {
        const titlePattern = /^(?:get\s+)?title$/i;
        if (titlePattern.test(segment) || /タイトル/.test(segment)) {
            return {type: 'title'};
        }

        const readPageMatch = segment.match(/^(?:read(?:-page)?|inspect(?:-page)?|page-info|read\s+page)$/i);
        if (readPageMatch) {
            return {type: 'read-page'};
        }

        const readPageJaMatch = segment.match(/^(?:ページ|画面|ブラウザ)(?:を)?(?:確認して|確認|見て|読んで)$/);
        if (readPageJaMatch) {
            return {type: 'read-page'};
        }

        const listTabsMatch = segment.match(/^(?:list(?:-tabs|\s+tabs)|tabs)$/i);
        if (listTabsMatch) {
            return {type: 'list-tabs'};
        }

        const listTabsJaMatch = segment.match(/^タブ(?:一覧)?(?:を)?(?:確認して|表示して|見せて)?$/);
        if (listTabsJaMatch) {
            return {type: 'list-tabs'};
        }

        const newTabMatch = segment.match(/^(?:new-tab|new\s+tab)\s+(.+)$/i);
        if (newTabMatch) {
            return {type: 'new-tab', url: normalizeUrl(newTabMatch[1])};
        }

        const newTabJaMatch = segment.match(/^(.+?)\s*(?:を)?新しいタブで(?:開いて|表示して)$/);
        if (newTabJaMatch && looksLikeUrlOrPath(newTabJaMatch[1])) {
            return {type: 'new-tab', url: normalizeUrl(newTabJaMatch[1])};
        }

        const switchTabMatch = segment.match(/^(?:switch-tab|switch\s+tab|select-tab|select\s+tab)\s+(.+)$/i);
        if (switchTabMatch) {
            return {type: 'switch-tab', target: stripWrappingQuotes(switchTabMatch[1].trim())};
        }

        const switchTabJaMatch = segment.match(/^(.+?)\s*(?:タブ)?に切り替えて$/);
        if (switchTabJaMatch) {
            return {type: 'switch-tab', target: stripWrappingQuotes(switchTabJaMatch[1].trim())};
        }

        const closeTabMatch = segment.match(/^(?:close-tab|close\s+tab)(?:\s+(.+))?$/i);
        if (closeTabMatch) {
            return {type: 'close-tab', target: closeTabMatch[1] ? stripWrappingQuotes(closeTabMatch[1].trim()) : 'current'};
        }

        const closeTabJaMatch = segment.match(/^(?:(.+?)\s*(?:タブ)?を)?閉じて$/);
        if (closeTabJaMatch) {
            return {type: 'close-tab', target: closeTabJaMatch[1] ? stripWrappingQuotes(closeTabJaMatch[1].trim()) : 'current'};
        }

        const openMatch = segment.match(/^(?:open|goto|go\s+to|navigate|navigate\s+to|visit)\s+(.+)$/i);
        if (openMatch) {
            return {type: 'open', url: normalizeUrl(openMatch[1])};
        }

        const openJaMatch = segment.match(/^(.+?)\s*(?:を)?(?:開く|開いて|表示して|に移動して)$/);
        if (openJaMatch && looksLikeUrlOrPath(openJaMatch[1])) {
            return {type: 'open', url: normalizeUrl(openJaMatch[1])};
        }

        const pressMatch = segment.match(/^(?:press|key)\s+(.+)$/i);
        if (pressMatch) {
            return {type: 'press', key: stripWrappingQuotes(pressMatch[1].trim())};
        }

        const clickMatch = segment.match(/^(?:click|tap)\s+(.+)$/i);
        if (clickMatch) {
            return {type: 'click', selector: clickMatch[1].trim()};
        }

        const clickJaMatch = segment.match(/^(.+?)\s*(?:を)?(?:クリック|押して)$/);
        if (clickJaMatch) {
            return {type: 'click', selector: clickJaMatch[1].trim()};
        }

        const waitMatch = segment.match(/^wait(?:\s+for)?\s+(.+)$/i);
        if (waitMatch) {
            const rawTarget = waitMatch[1].trim();
            if (!/^(?:url\b|text\s+(?:gone|to\s+disappear)\b)/i.test(rawTarget)) {
                return {type: 'wait', text: stripWrappingQuotes(rawTarget)};
            }
        }

        const waitJaMatch = segment.match(/^(.+?)\s*(?:が表示されるまで待って|を待って)$/);
        if (waitJaMatch) {
            return {type: 'wait', text: stripWrappingQuotes(waitJaMatch[1].trim())};
        }

        const waitUrlMatch = segment.match(/^wait(?:\s+for)?\s+url\s+(.+)$/i);
        if (waitUrlMatch) {
            return {type: 'wait-url', value: stripWrappingQuotes(waitUrlMatch[1].trim())};
        }

        const waitUrlJaMatch = segment.match(/^url\s+(.+?)\s+になるまで待って$/i);
        if (waitUrlJaMatch) {
            return {type: 'wait-url', value: stripWrappingQuotes(waitUrlJaMatch[1].trim())};
        }

        const waitTextGoneMatch = segment.match(/^wait(?:\s+for)?\s+text(?:\s+gone|\s+to\s+disappear)\s+(.+)$/i);
        if (waitTextGoneMatch) {
            return {type: 'wait-text-gone', text: stripWrappingQuotes(waitTextGoneMatch[1].trim())};
        }

        const waitGoneLooseMatch = segment.match(/^wait(?:\s+for)?\s+(.+?)\s+(?:to\s+disappear|to\s+go\s+away)$/i);
        if (waitGoneLooseMatch) {
            return {type: 'wait-text-gone', text: stripWrappingQuotes(waitGoneLooseMatch[1].trim())};
        }

        const waitGoneJaMatch = segment.match(/^(.+?)\s*(?:が)?消えるまで待って$/);
        if (waitGoneJaMatch) {
            return {type: 'wait-text-gone', text: stripWrappingQuotes(waitGoneJaMatch[1].trim())};
        }

        const expectTitleMatch = segment.match(/^expect\s+title\s+(.+)$/i);
        if (expectTitleMatch) {
            return {type: 'expect-title', value: stripWrappingQuotes(expectTitleMatch[1].trim())};
        }

        const expectUrlMatch = segment.match(/^expect\s+url\s+(.+)$/i);
        if (expectUrlMatch) {
            return {type: 'expect-url', value: stripWrappingQuotes(expectUrlMatch[1].trim())};
        }

        const expectTextMatch = segment.match(/^expect\s+text\s+(.+)$/i);
        if (expectTextMatch) {
            return {type: 'expect-text', value: stripWrappingQuotes(expectTextMatch[1].trim())};
        }

        const snapshotMatch = segment.match(/^(?:snapshot|take\s+snapshot)$/i);
        if (snapshotMatch) {
            return {type: 'snapshot'};
        }

        const evalMatch = segment.match(/^(?:eval|evaluate|js)\s+([\s\S]+)$/i);
        if (evalMatch) {
            return {type: 'eval', script: stripWrappingQuotes(evalMatch[1].trim())};
        }

        const typeMatch = segment.match(/^(?:type|fill|input|enter)\s+(.+)$/i);
        if (typeMatch) {
            return parseTypePayload(typeMatch[1]);
        }

        const typeJaFullMatch = segment.match(/^(.+?)\s+に\s+(.+?)\s+を入力(?:して)?$/);
        if (typeJaFullMatch) {
            return {
                type: 'type',
                selector: typeJaFullMatch[1].trim(),
                text: stripWrappingQuotes(typeJaFullMatch[2].trim()),
            };
        }

        const typeJaActiveMatch = segment.match(/^(.+?)\s+を入力(?:して)?$/);
        if (typeJaActiveMatch) {
            return {
                type: 'type-active',
                text: stripWrappingQuotes(typeJaActiveMatch[1].trim()),
            };
        }

        throw new Error(`Unsupported instruction segment: "${segment}"`);
    }

    async executeInstruction(instruction) {
        const actions = this.parseInstruction(instruction);
        const outputs = [];

        for (const action of actions) {
            outputs.push(await this.executeAction(action));
        }

        return outputs;
    }

    async executeAction(action) {
        try {
            if (!['open', 'new-tab', 'switch-tab', 'close-tab', 'list-tabs'].includes(action.type)) {
                await this.ensureSelectedPageContext();
            }

            switch (action.type) {
            case 'read-page':
                return this.readPage();
            case 'list-tabs':
                return this.listTabs();
            case 'new-tab':
                return this.openNewTab(action.url);
            case 'switch-tab':
                return this.switchTab(action.target);
            case 'close-tab':
                return this.closeTab(action.target);
            case 'open':
                return this.openPage(action.url);
            case 'click':
                return this.clickSelector(action.selector);
            case 'type':
                return this.typeIntoSelector(action.selector, action.text);
            case 'type-active':
                return this.typeIntoActiveElement(action.text);
            case 'title':
                return this.getTitle();
            case 'wait':
                return this.waitForText(action.text);
            case 'wait-url':
                return this.waitForUrl(action.value);
            case 'wait-text-gone':
                return this.waitForTextGone(action.text);
            case 'expect-title':
                return this.expectTitle(action.value);
            case 'expect-url':
                return this.expectUrl(action.value);
            case 'expect-text':
                return this.expectText(action.value);
            case 'snapshot':
                return this.snapshotSummary();
            case 'eval':
                return this.evaluateScript(action.script);
            case 'press':
                return this.pressKey(action.key);
            default:
                throw new Error(`Unknown action type: ${action.type}`);
            }
        } catch (error) {
            throw await this.enrichError(action, error);
        }
    }

    async openPage(url) {
        const listPagesTool = this.hasTool('list_pages') ? 'list_pages' : null;
        const navigateTool = this.hasTool('navigate_page') ? 'navigate_page' : null;
        const selectPageTool = this.hasTool('select_page') ? 'select_page' : null;
        const newPageTool = this.requireTool('new_page');

        if (navigateTool && selectPageTool && this.currentPageId !== null) {
            try {
                await this.selectPage(this.currentPageId);
                await this.client.callTool(navigateTool, {
                    type: 'url',
                    url,
                });
                this.latestSnapshot = null;
                await this.syncCurrentPageId(url, {preferSelected: true});
                return `Opened ${url}`;
            } catch (error) {
                this.logDebug('navigate_page on current tab failed, attempting fallback:', error.message);
            }
        }

        if (listPagesTool && navigateTool && selectPageTool) {
            const pages = await this.listPages();
            const reusablePage = chooseReusablePage(pages, {
                targetUrl: url,
                excludePageIds: this.currentPageId !== null ? [this.currentPageId] : [],
            });

            if (reusablePage) {
                try {
                    await this.selectPage(reusablePage.pageId);
                    await this.client.callTool(navigateTool, {
                        type: 'url',
                        url,
                    });
                    this.latestSnapshot = null;
                    await this.syncCurrentPageId(url, {preferSelected: true});
                    return `Opened ${url}`;
                } catch (error) {
                    this.logDebug('navigate_page on reusable tab failed, falling back:', error.message);
                }
            }
        }

        if (navigateTool) {
            try {
                await this.client.callTool(navigateTool, {
                    type: 'url',
                    url,
                });
                this.latestSnapshot = null;
                await this.syncCurrentPageId(url, {preferSelected: true});
                return `Opened ${url}`;
            } catch (error) {
                this.logDebug('navigate_page without explicit tab selection failed, falling back to new_page:', error.message);
            }
        }

        await this.client.callTool(newPageTool, {url});
        this.latestSnapshot = null;

        if (listPagesTool && selectPageTool) {
            const pages = await this.listPages();
            const openedPage = chooseReusablePage(pages, {targetUrl: url});
            if (openedPage) {
                await this.selectPage(openedPage.pageId).catch(error => {
                    this.logDebug('failed to select newly opened page:', error.message);
                });
            }
        }

        await this.syncCurrentPageId(url, {preferSelected: true});
        return `Opened ${url}`;
    }

    async openNewTab(url) {
        const tool = this.requireTool('new_page');
        const previousPages = this.hasTool('list_pages') ? await this.listPages().catch(() => []) : [];
        await this.client.callTool(tool, {url});
        this.latestSnapshot = null;
        await this.syncCurrentPageId(url, {preferSelected: true, previousPages});
        return `Opened new tab ${url}`;
    }

    async clickSelector(selector) {
        const resolved = await this.resolveSnapshotTarget(selector, {mode: 'click'});
        if (resolved) {
            const tool = this.requireTool('click');
            await this.client.callTool(tool, {
                uid: resolved.uid,
                includeSnapshot: true,
            });
            await this.refreshSnapshot();
            return `Clicked ${resolved.description}`;
        }

        const fallback = await this.clickSelectorWithDom(selector);
        return `Clicked ${fallback}`;
    }

    async typeIntoSelector(selector, text) {
        const resolved = await this.resolveSnapshotTarget(selector, {mode: 'fill'});
        if (resolved && this.hasTool('fill')) {
            await this.client.callTool('fill', {
                uid: resolved.uid,
                value: text,
                includeSnapshot: true,
            });
            await this.refreshSnapshot();
            return `Filled ${resolved.description}: ${maskValueForLog(selector, text)}`;
        }

        const fallback = await this.typeIntoSelectorWithDom(selector, text);
        return `Typed into ${fallback}: ${maskValueForLog(selector, text)}`;
    }

    async typeIntoActiveElement(text) {
        if (this.hasTool('type_text')) {
            await this.client.callTool('type_text', {text});
            this.latestSnapshot = null;
            return `Typed into active element: ${maskValueForLog('active-element', text)}`;
        }

        const tool = this.requireTool('evaluate_script');
        const textLiteral = JSON.stringify(text);
        const result = await this.client.callTool(tool, {
            function: `() => {
                const value = ${textLiteral};
                const element = document.activeElement;
                if (!element || element === document.body) {
                    return { ok: false, error: 'No active editable element' };
                }

                if ('value' in element) {
                    element.value = value;
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    return { ok: true, mode: 'value' };
                }

                if (element.isContentEditable) {
                    element.textContent = value;
                    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
                    return { ok: true, mode: 'contenteditable' };
                }

                return { ok: false, error: 'Active element is not editable' };
            }`,
        });

        const payload = unwrapToolResult(result);
        if (!payload || payload.ok !== true) {
            throw new Error('Type into active element failed');
        }

        this.latestSnapshot = null;
        return `Typed into active element: ${maskValueForLog('active-element', text)}`;
    }

    async getTitle() {
        const tool = this.requireTool('evaluate_script');
        const result = await this.client.callTool(tool, {
            function: '() => document.title',
        });

        const payload = unwrapToolResult(result);
        return `Title: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`;
    }

    async evaluateScript(script) {
        const tool = this.requireTool('evaluate_script');
        const result = await this.client.callTool(tool, {
            function: script,
        });

        const payload = unwrapToolResult(result);
        return `Eval: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`;
    }

    async pressKey(key) {
        const tool = this.requireTool('press_key');
        await this.client.callTool(tool, {key});
        this.latestSnapshot = null;
        return `Pressed ${key}`;
    }

    async waitForText(text, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
        if (this.hasTool('wait_for')) {
            await this.client.callTool('wait_for', {
                text: [text],
                timeout: timeoutMs,
            });
            return `Waited for text: ${text}`;
        }

        await this.waitForCondition(timeoutMs, async () => {
            const page = await this.getCurrentPageState();
            return page.text.includes(text);
        }, `Timed out waiting for text "${text}"`);

        return `Waited for text: ${text}`;
    }

    async waitForTextGone(text, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
        await this.waitForCondition(timeoutMs, async () => {
            const page = await this.getCurrentPageState();
            return !page.text.includes(text);
        }, `Timed out waiting for text to disappear "${text}"`);

        return `Waited for text to disappear: ${text}`;
    }

    async waitForUrl(value, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
        await this.waitForCondition(timeoutMs, async () => {
            const page = await this.getCurrentPageState();
            return page.url.includes(value);
        }, `Timed out waiting for URL to include "${value}"`);

        return `Waited for URL: ${value}`;
    }

    async expectText(text) {
        const page = await this.getCurrentPageState();
        if (!page.text.includes(text)) {
            throw new Error(`Expected page text to include "${text}"`);
        }
        return `Verified text: ${text}`;
    }

    async expectUrl(value) {
        const page = await this.getCurrentPageState();
        if (!page.url.includes(value)) {
            throw new Error(`Expected URL to include "${value}" but got "${page.url}"`);
        }
        return `Verified URL includes: ${value}`;
    }

    async expectTitle(value) {
        const page = await this.getCurrentPageState();
        if (!page.title.includes(value)) {
            throw new Error(`Expected title to include "${value}" but got "${page.title}"`);
        }
        return `Verified title includes: ${value}`;
    }

    async snapshotSummary() {
        const snapshot = await this.refreshSnapshot();
        const elements = parseSnapshotElements(snapshot.text);
        return `Snapshot: ${elements.length} interactive-ish nodes\n${renderElementSummary(elements.slice(0, 20))}`;
    }

    async readPage() {
        const page = await this.getCurrentPageState();
        const snapshot = await this.safeRefreshSnapshot();
        const elements = snapshot.elements || parseSnapshotElements(snapshot.text || '');
        const textPreview = normalizeText(page.text).slice(0, 400);

        return [
            `Page: ${page.title || '(no title)'}`,
            `URL: ${page.url || '(unknown)'}`,
            `Text: ${textPreview || '(empty)'}`,
            `Elements: ${elements.length}`,
            renderElementSummary(elements.slice(0, 12)) || '(no snapshot elements)',
        ].join('\n');
    }

    async getCurrentPageState() {
        const tool = this.requireTool('evaluate_script');
        const result = await this.client.callTool(tool, {
            function: `() => ({
                url: location.href,
                title: document.title,
                text: (document.body && document.body.innerText ? document.body.innerText : '').replace(/\\s+/g, ' ').trim(),
            })`,
        });

        const payload = unwrapToolResult(result);
        return payload && typeof payload === 'object'
            ? payload
            : {url: '', title: '', text: ''};
    }

    async refreshSnapshot(verbose = false) {
        if (!this.hasTool('take_snapshot')) {
            return {text: '', elements: []};
        }

        const result = await this.client.callTool('take_snapshot', {verbose});
        const text = extractPlainText(result);
        const elements = parseSnapshotElements(text);
        this.latestSnapshot = {text, elements};
        return this.latestSnapshot;
    }

    async getSnapshot() {
        return this.refreshSnapshot();
    }

    async resolveSnapshotTarget(target, options = {}) {
        if (!this.hasTool('take_snapshot')) {
            return null;
        }

        const snapshot = await this.getSnapshot();
        const matches = findSnapshotMatches(snapshot.elements, target, options);
        if (matches.length === 0) {
            return null;
        }

        if (matches.length > 1 && matches[0].score === matches[1].score) {
            this.logDebug('snapshot target is ambiguous, falling back to DOM resolution:', target);
            return null;
        }

        const best = matches[0].element;
        return {
            uid: best.uid,
            description: describeSnapshotElement(best),
            strategy: 'snapshot',
        };
    }

    async clickSelectorWithDom(selector) {
        const tool = this.requireTool('evaluate_script');
        const selectorLiteral = JSON.stringify(selector);
        const result = await this.client.callTool(tool, {
            function: `() => {
                const selector = ${selectorLiteral};
                const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
                let element = null;

                try {
                    element = document.querySelector(selector);
                } catch (_) {
                    element = null;
                }

                if (!element) {
                    const targetText = normalize(selector);
                    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]'));
                    element = candidates.find((candidate) => {
                        const text = candidate.tagName === 'INPUT'
                            ? normalize(candidate.value)
                            : normalize(candidate.textContent);
                        return text === targetText;
                    }) || null;
                }

                if (!element) {
                    return { ok: false, error: 'Element not found', selector };
                }

                element.click();
                return { ok: true, selector, tagName: element.tagName };
            }`,
        });

        const payload = unwrapToolResult(result);
        if (!payload || payload.ok !== true) {
            throw new Error(`Click failed for selector "${selector}"`);
        }

        return selector;
    }

    async typeIntoSelectorWithDom(selector, text) {
        const tool = this.requireTool('evaluate_script');
        const selectorLiteral = JSON.stringify(selector);
        const result = await this.client.callTool(tool, {
            function: `() => {
                const selector = ${selectorLiteral};
                const element = document.querySelector(selector);
                if (!element) {
                    return { ok: false, error: 'Element not found', selector };
                }

                element.focus();

                if ('value' in element) {
                    element.value = '';
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    return { ok: true, selector };
                }

                if (element.isContentEditable) {
                    element.textContent = '';
                    return { ok: true, selector };
                }

                return { ok: false, error: 'Element is not text-editable', selector };
            }`,
        });

        const payload = unwrapToolResult(result);
        if (!payload || payload.ok !== true) {
            throw new Error(`Type failed for selector "${selector}"`);
        }

        if (this.hasTool('type_text')) {
            await this.client.callTool('type_text', {text});
            return selector;
        }

        const fallbackTextLiteral = JSON.stringify(text);
        const applyResult = await this.client.callTool(tool, {
            function: `() => {
                const selector = ${selectorLiteral};
                const value = ${fallbackTextLiteral};
                const element = document.querySelector(selector);
                if (!element) {
                    return { ok: false, error: 'Element not found', selector };
                }

                if ('value' in element) {
                    element.value = value;
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    return { ok: true, selector };
                }

                if (element.isContentEditable) {
                    element.textContent = value;
                    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
                    return { ok: true, selector };
                }

                return { ok: false, error: 'Element is not text-editable', selector };
            }`,
        });

        const applyPayload = unwrapToolResult(applyResult);
        if (!applyPayload || applyPayload.ok !== true) {
            throw new Error(`Type failed for selector "${selector}"`);
        }

        return selector;
    }

    async listConsoleErrors() {
        if (!this.hasTool('list_console_messages')) {
            return [];
        }

        try {
            const result = await this.client.callTool('list_console_messages', {
                types: ['error'],
                pageSize: 10,
            });
            const messages = extractStructuredData(result);
            return Array.isArray(messages) ? messages : [];
        } catch (_) {
            return [];
        }
    }

    async enrichError(action, error) {
        const enriched = new Error(error.message);
        enriched.code = error.code;
        const page = await this.safeGetCurrentPageState();
        const snapshot = await this.safeRefreshSnapshot();
        const consoleErrors = await this.listConsoleErrors();

        enriched.data = {
            ...(error.data ? {cause: error.data} : {}),
            action,
            page,
            snapshotPreview: snapshot.text ? snapshot.text.split(/\r?\n/).slice(0, 40).join('\n') : '',
            snapshotMatches: action.selector
                ? findSnapshotMatches(snapshot.elements, action.selector, inferTargetOptions(action)).slice(0, 5).map(match => ({
                    score: match.score,
                    uid: match.element.uid,
                    role: match.element.role,
                    name: match.element.name,
                    line: match.element.line,
                }))
                : [],
            consoleErrors,
        };
        return enriched;
    }

    async safeGetCurrentPageState() {
        try {
            return await this.getCurrentPageState();
        } catch (_) {
            return {url: '', title: '', text: ''};
        }
    }

    async safeRefreshSnapshot() {
        try {
            return await this.refreshSnapshot();
        } catch (_) {
            return this.latestSnapshot || {text: '', elements: []};
        }
    }

    async waitForCondition(timeoutMs, predicate, message) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            if (await predicate()) {
                return;
            }

            await delay(250);
        }

        throw new Error(message);
    }

    async listPages() {
        const tool = this.requireTool('list_pages');
        const result = await this.client.callTool(tool, {});
        const structuredPages = normalizePageEntries(extractStructuredData(result));
        if (structuredPages.length > 0) {
            return structuredPages;
        }

        const text = extractPlainText(result);
        const parsedPages = parsePageEntriesFromText(text);
        if (parsedPages.length > 0) {
            return parsedPages;
        }

        return Object.assign([], {rawText: text});
    }

    async listTabs() {
        const pages = await this.listPages();
        if (Array.isArray(pages) && pages.length === 0 && pages.rawText) {
            return `Tabs (raw):\n${pages.rawText}`;
        }

        if (pages.length === 0) {
            return 'Tabs: none';
        }

        const hasSelectedPage = pages.some(page => page.selected);
        return `Tabs:\n${pages.map(page => {
            const isCurrent = hasSelectedPage
                ? Boolean(page.selected)
                : this.currentPageId !== null
                    ? this.currentPageId === page.pageId
                    : this.currentPageIndex !== null
                        ? this.currentPageIndex === page.index
                        : false;
            const marker = isCurrent ? '*' : '-';
            const index = Number.isInteger(page.index) ? `#${page.index}` : `id=${page.pageId}`;
            return `${marker} ${index} ${page.title || '(no title)'} <${page.url || ''}>`;
        }).join('\n')}`;
    }

    async selectPage(target, bringToFront = true) {
        const tool = this.requireTool('select_page');
        const payload = {bringToFront};

        if (target && typeof target === 'object') {
            if (typeof target.pageId !== 'undefined' && target.pageId !== null) {
                payload.pageId = target.pageId;
            }
        } else if (typeof target !== 'undefined' && target !== null) {
            payload.pageId = target;
        }

        await this.client.callTool(tool, payload);
        this.currentPageId = payload.pageId ?? null;
        this.currentPageIndex = target && typeof target === 'object' && Number.isInteger(target.index) ? target.index : null;
    }

    async switchTab(target) {
        const pages = await this.listPages();
        const page = findPageByTarget(pages, target, this.currentPageId, this.currentPageIndex);
        if (!page) {
            throw new Error(`Tab not found: ${target}`);
        }

        await this.selectPage(page, true);
        await this.waitForSelectedPage(page).catch(error => {
            this.logDebug('selected tab verification failed:', error.message);
        });
        this.latestSnapshot = null;
        return `Switched to tab ${formatPageRef(page)}`;
    }

    async closeTab(target = 'current') {
        const tool = this.requireTool('close_page');
        const pages = await this.listPages();
        const page = findPageByTarget(pages, target, this.currentPageId, this.currentPageIndex);
        if (!page) {
            throw new Error(`Tab not found: ${target}`);
        }

        if (!Number.isInteger(page.index)) {
            throw new Error(`Tab index is unavailable for ${formatPageRef(page)}`);
        }

        await this.client.callTool(tool, {pageId: page.pageId});
        this.latestSnapshot = null;

        const remainingPages = await this.waitForPageClose(pages, page);
        const fallbackPage = remainingPages.find(candidate => candidate.pageId !== page.pageId)
            || null;

        if (fallbackPage && this.hasTool('select_page')) {
            await this.selectPage(fallbackPage, false);
        } else if (!fallbackPage) {
            this.currentPageId = null;
            this.currentPageIndex = null;
        }

        return `Closed tab ${formatPageRef(page)}`;
    }

    async autoSelectPageContext() {
        if (!this.hasTool('list_pages', 'select_page')) {
            return;
        }

        const pages = await this.listPages();
        const selectedPage = pages.find(page => page.selected);
        if (selectedPage) {
            await this.selectPage(selectedPage, false);
            return;
        }

        const reusablePage = chooseReusablePage(pages, {});
        if (!reusablePage) {
            return;
        }

        await this.selectPage(reusablePage, false);
    }

    async ensureSelectedPageContext() {
        if (!this.hasTool('select_page')) {
            return;
        }

        if (this.currentPageId === null && this.currentPageIndex === null) {
            await this.autoSelectPageContext();
            return;
        }

        await this.selectPage({
            pageId: this.currentPageId,
            index: this.currentPageIndex,
        }, false);
    }

    async syncCurrentPageId(targetUrl, options = {}) {
        if (!this.hasTool('list_pages')) {
            return;
        }

        const pages = options.previousPages
            ? await this.waitForPageSelectionChange(options.previousPages, targetUrl).catch(() => this.listPages())
            : await this.listPages();

        const selectedPage = pages.find(page => page.selected);
        if (selectedPage && options.preferSelected) {
            this.currentPageId = selectedPage.pageId;
            this.currentPageIndex = Number.isInteger(selectedPage.index) ? selectedPage.index : null;
            return;
        }

        const selectedExactMatch = pages.find(page => page.selected && normalizeText(page.url) === normalizeText(targetUrl));
        if (selectedExactMatch) {
            this.currentPageId = selectedExactMatch.pageId;
            this.currentPageIndex = Number.isInteger(selectedExactMatch.index) ? selectedExactMatch.index : null;
            return;
        }

        if (selectedPage && (!targetUrl || normalizeText(selectedPage.url).includes(normalizeText(targetUrl)))) {
            this.currentPageId = selectedPage.pageId;
            this.currentPageIndex = Number.isInteger(selectedPage.index) ? selectedPage.index : null;
            return;
        }

        const exactMatch = findBestPageMatch(pages, targetUrl);
        if (exactMatch) {
            this.currentPageId = exactMatch.pageId;
            this.currentPageIndex = Number.isInteger(exactMatch.index) ? exactMatch.index : null;
        }
    }

    async waitForPageSelectionChange(previousPages, targetUrl = null, timeoutMs = 3000) {
        const previousSelectedPage = previousPages.find(page => page.selected) || null;
        let latestPages = [];
        await this.waitForCondition(timeoutMs, async () => {
            latestPages = await this.listPages();
            const selectedPage = latestPages.find(page => page.selected);
            if (!selectedPage) {
                return false;
            }

            if (!previousSelectedPage) {
                return true;
            }

            if (!samePageRef(selectedPage, previousSelectedPage)) {
                return true;
            }

            if (latestPages.length > previousPages.length) {
                return true;
            }

            if (targetUrl && normalizeText(selectedPage.url).includes(normalizeText(targetUrl))) {
                return true;
            }

            return false;
        }, 'Timed out waiting for page selection to change');

        return latestPages;
    }

    async waitForSelectedPage(page, timeoutMs = 3000) {
        await this.waitForCondition(timeoutMs, async () => {
            const pages = await this.listPages();
            const selectedPage = pages.find(candidate => candidate.selected);
            return selectedPage ? samePageRef(selectedPage, page) : false;
        }, `Timed out waiting for selected tab ${formatPageRef(page)}`);
    }

    async waitForPageClose(previousPages, closedPage, timeoutMs = 3000) {
        let latestPages = previousPages;
        const previousSameUrlCount = previousPages.filter(page => page.url === closedPage.url).length;

        await this.waitForCondition(timeoutMs, async () => {
            latestPages = await this.listPages();
            if (latestPages.length >= previousPages.length) {
                return false;
            }

            if (!closedPage.url) {
                return true;
            }

            const sameUrlCount = latestPages.filter(page => page.url === closedPage.url).length;
            return sameUrlCount < previousSameUrlCount;
        }, `Timed out waiting for tab to close ${formatPageRef(closedPage)}`);

        return latestPages;
    }
}

function parseTypePayload(payload) {
    const trimmed = payload.trim();

    const selectorAndQuotedText = trimmed.match(/^(\S+)\s+(".*"|'[^']*')$/);
    if (selectorAndQuotedText) {
        return {
            type: 'type',
            selector: selectorAndQuotedText[1],
            text: stripWrappingQuotes(selectorAndQuotedText[2]),
        };
    }

    const selectorAndText = trimmed.match(/^(\S+)\s+(.+)$/);
    if (selectorAndText) {
        return {
            type: 'type',
            selector: selectorAndText[1],
            text: stripWrappingQuotes(selectorAndText[2].trim()),
        };
    }

    return {
        type: 'type-active',
        text: stripWrappingQuotes(trimmed),
    };
}

function stripWrappingQuotes(value) {
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith('\'') && value.endsWith('\''))
    ) {
        return value.slice(1, -1);
    }

    return value;
}

function normalizeUrl(value) {
    const trimmed = stripWrappingQuotes(value.trim());

    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) {
        return trimmed;
    }

    if (trimmed.startsWith('about:') || trimmed.startsWith('chrome:')) {
        return trimmed;
    }

    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) {
        return `https://${trimmed}`;
    }

    return trimmed;
}

function looksLikeUrlOrPath(value) {
    return /https?:\/\//i.test(value) || /^[\w.-]+\.[a-z]{2,}/i.test(value) || value.startsWith('/');
}

function extractStructuredData(result) {
    if (result && typeof result.structuredContent !== 'undefined') {
        return result.structuredContent;
    }

    if (!result || !Array.isArray(result.content)) {
        return null;
    }

    for (const block of result.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
            try {
                return JSON.parse(block.text);
            } catch (_) {
                continue;
            }
        }
    }

    return null;
}

function unwrapToolResult(result) {
    const structured = extractStructuredData(result);
    if (structured !== null) {
        return structured;
    }

    if (!result || !Array.isArray(result.content)) {
        return null;
    }

    if (result.content.length === 1 && result.content[0].type === 'text') {
        const text = result.content[0].text;
        const fencedJsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
        if (fencedJsonMatch) {
            try {
                return JSON.parse(fencedJsonMatch[1]);
            } catch (_) {
                return fencedJsonMatch[1].trim();
            }
        }
        try {
            return JSON.parse(text);
        } catch (_) {
            return text;
        }
    }

    return result.content;
}

function extractPlainText(result) {
    if (!result || !Array.isArray(result.content)) {
        return '';
    }

    return result.content
        .filter(block => block && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
        .trim();
}

function parseSnapshotElements(text) {
    const lines = text.split(/\r?\n/);
    const elements = [];

    for (const rawLine of lines) {
        const uid = extractSnapshotUid(rawLine);
        if (!uid) {
            continue;
        }

        const line = rawLine.trim();
        const lineWithoutUid = stripUidMarkers(line).trim();
        const quotedTexts = Array.from(line.matchAll(/"([^"]*)"/g)).map(match => match[1]).filter(Boolean);
        const normalizedLine = normalizeText(line);
        const roleMatch = lineWithoutUid.replace(/^[\s>*-]+/, '').match(/^([A-Za-z][\w-]*)/);
        const role = roleMatch ? roleMatch[1].toLowerCase() : '';
        const name = quotedTexts[0] || inferNameFromSnapshotLine(lineWithoutUid, role);

        elements.push({
            uid,
            role,
            name,
            quotedTexts,
            line,
            normalizedLine,
        });
    }

    return elements;
}

function extractSnapshotUid(line) {
    const patterns = [
        /\[uid=([^[\]]+)\]/i,
        /\[([^[\]]+)\]\s*$/,
        /\buid=([^\s\]]+)/i,
    ];

    for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
            return match[1];
        }
    }

    return null;
}

function inferNameFromSnapshotLine(line, role) {
    const stripped = stripUidMarkers(line).trim();

    if (!stripped) {
        return '';
    }

    if (role && stripped.toLowerCase().startsWith(role)) {
        return stripped.slice(role.length).trim();
    }

    return stripped;
}

function stripUidMarkers(line) {
    return line
        .replace(/\[uid=[^[\]]+\]/gi, '')
        .replace(/\[[^[\]]+\]\s*$/, '')
        .replace(/\buid=[^\s\]]+/gi, '')
        .replace(/\buid\b[:=]?/gi, '')
        .trim();
}

function findSnapshotMatches(elements, target, options = {}) {
    const normalizedTarget = normalizeText(target);
    const targetHints = parseTargetHints(target);
    const matches = [];

    for (const element of elements) {
        const score = scoreSnapshotElement(element, normalizedTarget, targetHints, options);
        if (score > 0) {
            matches.push({element, score});
        }
    }

    return matches.sort((left, right) => right.score - left.score);
}

function scoreSnapshotElement(element, normalizedTarget, targetHints, options) {
    if (!normalizedTarget) {
        return 0;
    }

    if (targetHints.uid && element.uid === targetHints.uid) {
        return 1000;
    }

    if (options.mode === 'click' && !isLikelyClickable(element.role)) {
        return 0;
    }

    if (options.mode === 'fill' && !isLikelyEditable(element.role, element.line)) {
        return 0;
    }

    let score = 0;
    const normalizedName = normalizeText(element.name);
    const quoted = element.quotedTexts.map(normalizeText);

    if (targetHints.role && element.role === targetHints.role) {
        score += 100;
    }

    if (targetHints.name && normalizedName === targetHints.name) {
        score += 850;
    } else if (normalizedName === normalizedTarget) {
        score += 800;
    } else if (quoted.includes(normalizedTarget)) {
        score += 760;
    } else if (element.normalizedLine === normalizedTarget) {
        score += 720;
    } else if (normalizedName && normalizedName.includes(normalizedTarget)) {
        score += 560;
    } else if (element.normalizedLine.includes(normalizedTarget)) {
        score += 500;
    }

    if (targetHints.role && element.role !== targetHints.role) {
        score -= 150;
    }

    return Math.max(score, 0);
}

function parseTargetHints(target) {
    const raw = stripWrappingQuotes(String(target).trim());
    const normalized = normalizeText(raw);
    const uidMatch = raw.match(/^uid:(.+)$/i);
    const roleNameMatch = raw.match(/^([a-z][\w-]*)\s+(.+)$/i);

    return {
        uid: uidMatch ? uidMatch[1].trim() : null,
        role: roleNameMatch ? roleNameMatch[1].toLowerCase() : null,
        name: roleNameMatch ? normalizeText(roleNameMatch[2]) : null,
        normalized,
    };
}

function isLikelyClickable(role) {
    return ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'switch'].includes(role);
}

function isLikelyEditable(role, line) {
    if (['textbox', 'searchbox', 'combobox', 'textarea', 'spinbutton'].includes(role)) {
        return true;
    }

    return /\b(textbox|searchbox|combobox|textarea|input)\b/i.test(line);
}

function describeSnapshotElement(element) {
    if (element.name) {
        return `${element.role || 'element'} "${element.name}" [uid=${element.uid}]`;
    }

    return `${element.role || 'element'} [uid=${element.uid}]`;
}

function createAmbiguousTargetError(target, matches) {
    const error = new Error(`Target "${target}" matched multiple elements`);
    error.data = {
        target,
        matches: matches.map(match => ({
            uid: match.element.uid,
            role: match.element.role,
            name: match.element.name,
            line: match.element.line,
            score: match.score,
        })),
    };
    return error;
}

function renderElementSummary(elements) {
    return elements
        .map(element => `- ${describeSnapshotElement(element)}`)
        .join('\n');
}

function normalizeText(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function inferTargetOptions(action) {
    if (action.type === 'click') {
        return {mode: 'click'};
    }

    if (action.type === 'type') {
        return {mode: 'fill'};
    }

    return {};
}

function maskValueForLog(selector, value) {
    return isSensitiveTarget(selector) ? '*'.repeat(Math.max(String(value).length, 8)) : value;
}

function isSensitiveTarget(target) {
    return /password|passcode|secret|token/i.test(String(target || ''));
}

function normalizePageEntries(value) {
    if (value && !Array.isArray(value) && Array.isArray(value.pages)) {
        value = value.pages;
    }

    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map(page => {
            if (!page || typeof page !== 'object') {
                return null;
            }

            const rawPageId = page.pageId ?? page.id ?? page.targetId ?? page.target_id;
            if (typeof rawPageId === 'undefined' || rawPageId === null || rawPageId === '') {
                return null;
            }

            const pageId = rawPageId;

            const index = Number.isInteger(page.pageIdx)
                ? page.pageIdx
                : Number.isInteger(page.index)
                    ? page.index
                    : Number.isInteger(page.idx)
                        ? page.idx
                        : null;

            return {
                pageId,
                index,
                selected: Boolean(page.selected),
                title: String(page.title || ''),
                url: String(page.url || ''),
            };
        })
        .filter(Boolean);
}

function parsePageEntriesFromText(text) {
    const lines = String(text || '').split(/\r?\n/);
    const pages = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const simpleMatch = trimmed.match(/^(\d+):\s+(\S+?)(?:\s+(\[selected\]))?$/i);
        if (simpleMatch) {
            const index = Number(simpleMatch[1]);
            pages.push({
                pageId: index,
                index,
                selected: Boolean(simpleMatch[3]),
                title: '',
                url: String(simpleMatch[2] || '').trim(),
            });
            continue;
        }

        const match = trimmed.match(/^(?:\[)?(\d+)(?:\])?\s*[:.-]\s*(.*?)\s*(?:<([^>]+)>|-\s*(https?:\/\/\S+|about:\S+|chrome:\/\/\S+))$/i);
        if (!match) {
            continue;
        }

        pages.push({
            pageId: Number(match[1]),
            index: Number(match[1]),
            selected: /\[selected\]/i.test(trimmed),
            title: String(match[2] || '').trim(),
            url: String(match[3] || match[4] || '').trim(),
        });
    }

    return pages;
}

function findPageByTarget(pages, target, currentPageId = null, currentPageIndex = null) {
    if (!Array.isArray(pages) || pages.length === 0) {
        return null;
    }

    const normalizedTarget = String(target || 'current').trim();
    if (!normalizedTarget || /^current$/i.test(normalizedTarget)) {
        return pages.find(page => page.pageId === currentPageId)
            || pages.find(page => Number.isInteger(currentPageIndex) && page.index === currentPageIndex)
            || pages.find(page => page.selected)
            || pages[0];
    }

    if (/^last$/i.test(normalizedTarget)) {
        return pages[pages.length - 1];
    }

    if (/^first$/i.test(normalizedTarget)) {
        return pages[0];
    }

    if (/^\d+$/.test(normalizedTarget)) {
        const numericTarget = Number(normalizedTarget);
        return pages.find(page => page.index === numericTarget)
            || pages.find(page => page.pageId === numericTarget)
            || null;
    }

    const needle = normalizeText(normalizedTarget);
    return pages.find(page => normalizeText(page.title).includes(needle))
        || pages.find(page => normalizeText(page.url).includes(needle))
        || null;
}

function samePageRef(left, right) {
    if (!left || !right) {
        return false;
    }

    if (typeof left.pageId !== 'undefined' && typeof right.pageId !== 'undefined' && left.pageId === right.pageId) {
        return true;
    }

    return Number.isInteger(left.index) && Number.isInteger(right.index) && left.index === right.index;
}

function formatPageRef(page) {
    const index = Number.isInteger(page.index) ? `#${page.index}` : `id=${page.pageId}`;
    return `${index} ${page.title || '(no title)'} <${page.url || ''}>`;
}

function chooseReusablePage(pages, options = {}) {
    const excluded = new Set(options.excludePageIds || []);
    const candidates = pages
        .filter(page => !excluded.has(page.pageId))
        .filter(page => isReusablePageUrl(page.url))
        .map(page => ({
            page,
            score: scoreReusablePage(page, options.targetUrl || null),
        }))
        .sort((left, right) => right.score - left.score);

    return candidates.length > 0 ? candidates[0].page : null;
}

function findBestPageMatch(pages, targetUrl) {
    const target = safeParseUrl(targetUrl);
    if (!target) {
        return null;
    }

    const candidates = pages
        .filter(page => isReusablePageUrl(page.url))
        .map(page => ({
            page,
            score: scoreExactPageMatch(page, target),
        }))
        .filter(candidate => candidate.score > 0)
        .sort((left, right) => right.score - left.score);

    return candidates.length > 0 ? candidates[0].page : null;
}

function scoreReusablePage(page, targetUrl) {
    let score = 0;
    const pageUrl = safeParseUrl(page.url);
    const target = targetUrl ? safeParseUrl(targetUrl) : null;

    score += 100;

    if (pageUrl && target) {
        if (pageUrl.origin === target.origin) {
            score += 200;
        }

        if (pageUrl.pathname === target.pathname) {
            score += 80;
        } else if (pageUrl.pathname.startsWith('/watch/') && target.pathname.startsWith('/watch/')) {
            score += 40;
        }
    }

    if (pageUrl && isApplicationLikePage(pageUrl)) {
        score += 25;
    }

    return score;
}

function scoreExactPageMatch(page, target) {
    const pageUrl = safeParseUrl(page.url);
    if (!pageUrl) {
        return 0;
    }

    let score = 0;
    if (pageUrl.origin === target.origin) {
        score += 100;
    } else {
        return 0;
    }

    if (pageUrl.pathname === target.pathname) {
        score += 300;
    } else if (pageUrl.pathname.startsWith(target.pathname) || target.pathname.startsWith(pageUrl.pathname)) {
        score += 100;
    }

    if (pageUrl.search === target.search) {
        score += 20;
    }

    return score;
}

function isReusablePageUrl(url) {
    const parsed = safeParseUrl(url);
    if (!parsed) {
        return false;
    }

    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

function isApplicationLikePage(url) {
    return !/newtab|blank/i.test(url.pathname + url.hostname);
}

function safeParseUrl(value) {
    try {
        return new URL(value);
    } catch (_) {
        return null;
    }
}

function renderToolNames(tools) {
    return tools
        .map(tool => {
            const description = tool.description ? ` - ${tool.description}` : '';
            return `${tool.name}${description}`;
        })
        .join('\n');
}

function renderToolSchemas(tools) {
    return JSON.stringify(tools.map(tool => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema || null,
    })), null, 2);
}

async function prepareRuntime(options) {
    const runtime = {...options};

    if (runtime.ensureCdp && !runtime.browserUrl) {
        runtime.browserUrl = `http://${runtime.cdpHost}:${runtime.cdpPort}`;
    }

    if (runtime.browserUrl) {
        runtime.browserUrl = normalizeBrowserUrl(runtime.browserUrl);
    }

    if (runtime.ensureCdp) {
        runtime.chromeUserDataDir = resolveChromeUserDataDir(runtime);
    }

    if (runtime.ensureCdp) {
        await ensureCdp(runtime);
    }

    runtime.serverCommand = buildServerCommand(runtime);
    return runtime;
}

function resolveChromeUserDataDir(options) {
    if (options.chromeUserDataDir && options.reuseChromeProfile) {
        return options.chromeUserDataDir;
    }

    if (options.chromeUserDataDir && options.chromeUserDataDir !== process.env.CHROME_USER_DATA_DIR && options.chromeUserDataDir !== '') {
        return options.chromeUserDataDir;
    }

    return fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-devtools-runner-'));
}

function buildServerCommand(options) {
    let command = options.serverCommand || BASE_SERVER_COMMAND;

    if (options.browserUrl && !/\s--browser-?url(?:=|\s)|\s--browserUrl(?:=|\s)/.test(` ${command} `)) {
        command += ` --browserUrl ${quoteShellArg(options.browserUrl)}`;
    }

    return command;
}

function normalizeBrowserUrl(value) {
    const trimmed = stripWrappingQuotes(String(value).trim());
    if (!trimmed) {
        throw new Error('CDP browser URL must not be empty.');
    }

    const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
        ? trimmed
        : `http://${trimmed}`;

    return withProtocol.replace(/\/+$/, '');
}

async function ensureCdp(options) {
    if (await isCdpAvailable(options.browserUrl)) {
        return;
    }

    const chromePath = options.chromePath || defaultChromePath();
    if (!chromePath) {
        throw new Error('Chrome executable path is required. Pass --chrome-path or set CHROME_PATH.');
    }

    const cdpPort = browserUrlPort(options.browserUrl) || options.cdpPort;
    try {
        const child = launchChromeForCdp({
            chromePath,
            cdpPort,
            userDataDir: options.chromeUserDataDir,
            logFile: options.chromeLogFile,
        });

        console.error(`[cdp] starting Chrome pid=${child.pid} port=${cdpPort} userDataDir=${options.chromeUserDataDir}`);
        await waitForCdp(options.browserUrl, options.cdpStartupTimeoutMs, child, options.chromeLogFile);
    } catch (error) {
        if (process.platform !== 'darwin') {
            throw error;
        }

        console.error('[cdp] direct Chrome launch failed, retrying via open -n -a Google Chrome');
        const fallbackChild = launchChromeForCdpViaOpen({
            cdpPort,
            userDataDir: options.chromeUserDataDir,
            logFile: options.chromeLogFile,
        });
        await waitForCdp(options.browserUrl, options.cdpStartupTimeoutMs, fallbackChild, options.chromeLogFile);
    }
}

function launchChromeForCdp(options) {
    const args = buildChromeLaunchArgs(options);
    const stdio = buildChromeStdio(options.logFile);
    const child = spawn(options.chromePath, args, {
        detached: true,
        stdio,
    });

    child.unref();
    return child;
}

function launchChromeForCdpViaOpen(options) {
    const args = [
        '-n',
        '-a',
        'Google Chrome',
        '--args',
        ...buildChromeLaunchArgs(options),
    ];
    const stdio = buildChromeStdio(options.logFile);
    const child = spawn('open', args, {
        detached: true,
        stdio,
    });

    child.unref();
    return child;
}

function buildChromeLaunchArgs(options) {
    return [
        `--remote-debugging-port=${options.cdpPort}`,
        `--user-data-dir=${options.userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-search-engine-choice-screen',
        'about:blank',
    ];
}

function buildChromeStdio(logFile) {
    if (!logFile) {
        return 'ignore';
    }

    ensureParentDir(path.dirname(logFile));
    const fd = fs.openSync(logFile, 'a');
    return ['ignore', fd, fd];
}

async function waitForCdp(browserUrl, timeoutMs, child = null, logFile = null) {
    const startedAt = Date.now();
    let lastError = null;
    let launchExit = null;

    if (child) {
        child.once('exit', (code, signal) => {
            launchExit = {code, signal};
        });
    }

    while (Date.now() - startedAt < timeoutMs) {
        try {
            await getCdpVersion(browserUrl);
            return;
        } catch (error) {
            lastError = error;
            if (launchExit) {
                const logHint = logFile ? ` See ${logFile}` : '';
                throw new Error(`Chrome exited before CDP became available (code=${launchExit.code}, signal=${launchExit.signal}).${logHint}`);
            }
            await delay(250);
        }
    }

    const logHint = logFile ? ` See ${logFile}` : '';
    throw new Error(`Timed out waiting for Chrome DevTools Protocol at ${browserUrl}: ${lastError ? lastError.message : 'not available'}.${logHint}`);
}

async function isCdpAvailable(browserUrl) {
    try {
        await getCdpVersion(browserUrl);
        return true;
    } catch (_) {
        return false;
    }
}

async function getCdpVersion(browserUrl) {
    const body = await httpGetText(cdpVersionUrl(browserUrl), 1000);
    return JSON.parse(body);
}

function httpGetText(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, response => {
            let body = '';

            response.setEncoding('utf8');
            response.on('data', chunk => {
                body += chunk;
            });
            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(`HTTP ${response.statusCode}`));
                    return;
                }

                resolve(body);
            });
        });

        request.on('error', reject);
        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms`));
        });
    });
}

function cdpVersionUrl(browserUrl) {
    const url = new URL(browserUrl);

    if (url.protocol !== 'http:') {
        throw new Error(`CDP browser URL must use http: ${browserUrl}`);
    }

    url.pathname = '/json/version';
    url.search = '';
    url.hash = '';
    return url.toString();
}

function browserUrlPort(browserUrl) {
    const url = new URL(browserUrl);
    return Number(url.port) || null;
}

function defaultChromePath() {
    if (process.platform === 'darwin') {
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    }

    if (process.platform === 'linux') {
        return process.env.CHROME_BIN || '/usr/bin/google-chrome';
    }

    if (process.platform === 'win32') {
        return process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    }

    return null;
}

function ensureParentDir(directory) {
    fs.mkdirSync(directory, {recursive: true});
}

function quoteShellArg(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function renderUsage() {
    return [
        'Usage: node chrome-devtools-runner.js [options] "<instruction>"',
        '',
        'Default mode: let chrome-devtools-mcp start/manage Chrome.',
        '  node chrome-devtools-runner.js "open https://example.com then title"',
        '',
        'CDP mode: connect to an existing Chrome DevTools Protocol endpoint.',
        '  node chrome-devtools-runner.js --browser-url http://127.0.0.1:9222 "title"',
        '',
        'Managed CDP mode: start Chrome with CDP if the endpoint is not running.',
        '  node chrome-devtools-runner.js --ensure-cdp "open http://localhost:3000"',
        '',
        'Options:',
        '  --debug',
        '  --show-tools',
        '  --show-tool-schemas',
        '  --timeout <ms>',
        '  --server-command <command>',
        '  --browser-url <url>',
        '  --ensure-cdp',
        '  --cdp-host <host>                 default: 127.0.0.1',
        '  --cdp-port <port>                 default: 9222',
        '  --cdp-startup-timeout <ms>        default: 10000',
        '  --chrome-path <path>              default: CHROME_PATH or platform default',
        '  --chrome-user-data-dir <path>     default: auto-created temp profile',
        '  --reuse-chrome-profile            reuse the specified --chrome-user-data-dir',
        `  --chrome-log-file <path>          default: ${DEFAULT_CHROME_LOG_FILE}`,
    ].join('\n');
}

async function main() {
    const options = parseArgs(process.argv.slice(2));

    if (!options.instruction && !options.showTools && !options.showToolSchemas) {
        console.error(renderUsage());
        process.exitCode = 1;
        return;
    }

    let client = null;

    try {
        const runtime = await prepareRuntime(options);

        client = new McpStdioClient({
            command: runtime.serverCommand,
            debug: runtime.debug,
            timeoutMs: runtime.timeoutMs,
        });

        await client.start();

        if (options.showTools || options.showToolSchemas) {
            console.log(options.showToolSchemas ? renderToolSchemas(client.tools) : renderToolNames(client.tools));
            return;
        }

        const cli = new ChromeMcpCli(client, {
            debug: options.debug,
            browserUrl: runtime.browserUrl,
        });
        await cli.initializeSession();
        const outputs = await cli.executeInstruction(options.instruction);
        console.log(outputs.join('\n'));
    } catch (error) {
        console.error('[error]', error.message);
        if (error.code) {
            console.error('[error] code:', error.code);
        }
        if (error.data) {
            console.error('[error] data:', JSON.stringify(error.data, null, 2));
        }
        process.exitCode = 1;
    } finally {
        if (client) {
            await client.close().catch(closeError => {
                console.error('[error] failed to close MCP client:', closeError.message);
            });
        }
    }
}

main();
