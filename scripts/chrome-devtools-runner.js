#!/usr/bin/env node

/**
 * Generic MCP client for chrome-devtools-mcp over stdio.
 *
 * Usage:
 *   node chrome-devtools-runner.js --isolated "open https://example.com"
 *   node chrome-devtools-runner.js --existing "list tabs then switch tab 1 then click Login"
 *   node chrome-devtools-runner.js --existing "switch tab 1 then type Email test@example.com"
 *   node chrome-devtools-runner.js --existing "switch tab 1 then submit"
 *   node chrome-devtools-runner.js --isolated --debug "open https://example.com then title"
 *   node chrome-devtools-runner.js --ensure-cdp "open http://localhost:3000 then click Dashboard then back then forward"
 *   node chrome-devtools-runner.js --browser-url http://127.0.0.1:9222 "list tabs then switch tab 1 then title"
 *
 * Notes:
 * - stdio MCP requires the client to own the server process. This script starts
 *   the server command locally and talks JSON-RPC over stdio.
 * - By default, launch an independent Chrome with a temporary profile.
 * - Use --isolated to launch Chrome with a fresh temporary profile.
 * - Use --browser-url to connect to a running Chrome DevTools Protocol endpoint.
 * - Use --ensure-cdp to start Chrome with CDP when the endpoint is not running.
 * - Override the server command with MCP_SERVER_COMMAND if needed.
 *   Default: locally installed, package-lock.json-pinned chrome-devtools-mcp
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_WAIT_TIMEOUT_MS = 10000;
const DEFAULT_CDP_HOST = '127.0.0.1';
const DEFAULT_CDP_PORT = 9222;
const DEFAULT_CDP_STARTUP_TIMEOUT_MS = 10000;
const DEFAULT_CHROME_LOG_FILE = path.join(os.tmpdir(), 'chrome-devtools-runner.chrome.log');

const privateInputs = new Set();

function rememberInput(value) {
    if (typeof value !== 'string' || value.length === 0) return;
    for (const variant of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), value.toLowerCase(), value.replace(/\s+/g, ' ').trim().toLowerCase()]) {
        if (variant) privateInputs.add(variant);
    }
}

function redactOutput(value) {
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) return '';
    for (const secret of [...privateInputs].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
    return text;
}

function writeOutput(level, ...values) {
    console[level](...values.map(redactOutput));
}

function sanitizeReport(value) {
    if (typeof value === 'string') return redactOutput(value);
    if (Array.isArray(value)) return value.map(sanitizeReport);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeReport(item)]));
    return value;
}

function describeAction(action) {
    const description = {...action};
    if (['type', 'type-active'].includes(action.type)) description.text = '[REDACTED]';
    if (action.type === 'eval') description.script = '[OMITTED]';
    return sanitizeReport(description);
}

function parseArgs(argv) {
    const args = [...argv];
    let debug = false;
    let stdin = false;
    const view = {full: false, offset: 0, limit: null, textLimit: 400, filter: ""};
    let outputPath = null;
    let showTools = false;
    let showToolSchemas = false;
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    let serverCommand = process.env.MCP_SERVER_COMMAND || null;
    let browserUrl = null;
    let wsEndpoint = null;
    let ensureCdp = false;
    let browserMode = null;
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

        if (value === '--existing' || value === '--isolated') {
            const mode = value === '--existing' ? 'existing' : 'isolated';
            if (browserMode && browserMode !== mode) throw new Error('Choose either --existing or --isolated.');
            if (inlineValue !== null) throw new Error(`${value} does not take a value.`);
            browserMode = mode;
            continue;
        }

        if (value === '--full') {
            view.full = true;
            continue;
        }
        if (['--offset', '--limit', '--text-limit', '--filter', '--output'].includes(value)) {
            if (!hasOptionValue(inlineValue, args)) throw new Error(`Missing value for ${value}`);
            const argument = takeOptionValue(inlineValue, args);
            if (value === '--output') outputPath = argument;
            else if (value === '--filter') view.filter = argument;
            else {
                const number = Number(argument);
                if (!/^\d+$/.test(argument) || !Number.isSafeInteger(number) || (value === '--limit' && number === 0)) {
                    throw new Error(`Invalid non-negative integer for ${value}`);
                }
                view[{'--offset':'offset', '--limit':'limit', '--text-limit':'textLimit'}[value]] = number;
            }
            continue;
        }

        if (value === '--stdin') {
            stdin = true;
            continue;
        }

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

        if (value === '--ws-endpoint') {
            if (!hasOptionValue(inlineValue, args)) throw new Error('Missing value for --ws-endpoint');
            wsEndpoint = takeOptionValue(inlineValue, args);
            const endpoint = new URL(wsEndpoint);
            if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error('--ws-endpoint must use ws: or wss:');
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

    if (wsEndpoint && (browserUrl || ensureCdp || browserMode === 'isolated' || serverCommand)) throw new Error('--ws-endpoint cannot be combined with --browser-url, --ensure-cdp, --isolated or a custom server.');
    if (browserMode && ensureCdp) throw new Error('--ensure-cdp cannot be combined with --existing or --isolated.');
    if (browserMode === 'isolated' && browserUrl) throw new Error('--isolated cannot be combined with --browser-url.');
    if (browserMode && (chromeUserDataDir || reuseChromeProfile)) throw new Error('Explicit browser modes cannot use --chrome-user-data-dir or --reuse-chrome-profile.');
    if (browserMode && serverCommand) throw new Error('Explicit browser modes cannot be combined with a custom MCP server command.');
    browserMode ||= ensureCdp ? 'ensure-cdp' : (browserUrl || wsEndpoint) ? 'existing' : serverCommand ? 'custom' : 'isolated';
    if (browserMode === 'isolated' && (chromeUserDataDir || reuseChromeProfile)) throw new Error('Isolated mode uses a temporary profile. Use --ensure-cdp for a persistent profile.');
    if (browserMode === 'existing' && (chromePath || chromeUserDataDir || reuseChromeProfile)) throw new Error('Existing mode does not launch Chrome. Use --ensure-cdp for launch/profile options.');

    return {
        browserMode,
        debug,
        stdin,
        view,
        outputPath,
        showTools,
        showToolSchemas,
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
        cdpPort: Number.isFinite(cdpPort) && cdpPort > 0 ? cdpPort : DEFAULT_CDP_PORT,
        cdpStartupTimeoutMs: Number.isFinite(cdpStartupTimeoutMs) && cdpStartupTimeoutMs > 0
            ? cdpStartupTimeoutMs
            : DEFAULT_CDP_STARTUP_TIMEOUT_MS,
        serverCommand,
        browserUrl,
        wsEndpoint,
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
        this.command = options.command || process.env.MCP_SERVER_COMMAND || null;
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
            writeOutput('error', '[debug]', ...args);
        }
    }

    async start() {
        this.command ||= buildServerCommand({});
        this.logDebug('starting MCP server');
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
                this.logDebug('MCP server stderr received (content omitted)');
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
            this.logDebug('failed to parse MCP message (payload omitted)');
            throw new Error('Invalid JSON response from MCP server (payload omitted)');
        }

        this.handleMessage(message);
    }

    handleMessage(message) {
        this.logDebug('recv', {id: message.id, method: message.method, isError: Boolean(message.error || message.result?.isError)});

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
        this.logDebug('send', {id: message.id, method: message.method, tool: message.params?.name});
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

    async callTool(name, args = {}, timeoutMs = this.timeoutMs) {
        const result = await this.sendRequest('tools/call', {
            name,
            arguments: args,
        }, timeoutMs);
        if (result?.isError) {
            throw new Error(`MCP tool ${name} failed: ${extractPlainText(result) || 'Unknown tool error'}`);
        }
        return result;
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
        this.requireExplicitTab = Boolean(options.requireExplicitTab);
        this.explicitTabSelected = false;
        this.currentViewport = null;
        this.view = {full: false, offset: 0, limit: null, textLimit: 400, filter: '', ...options.view};
        this.onResult = options.onResult || null;
        this.results = [];
        this.diagnosticTimeoutMs = options.diagnosticTimeoutMs ?? 1500;
        this.requestTimeoutMs = undefined;

        for (const tool of client.tools) {
            this.toolsByName.set(tool.name, tool);
        }
    }

    logDebug(...args) {
        if (this.debug) {
            writeOutput('error', '[debug]', ...args);
        }
    }

    hasTool(...names) {
        return names.some(name => this.toolsByName.has(name));
    }

    async callTool(name, args = {}) {
        const schema = this.toolsByName.get(name)?.inputSchema;
        if (schema?.properties?.pageId && args.pageId === undefined) {
            if (this.currentPageId !== null) {
                args = {...args, pageId: this.currentPageId};
            } else if (schema.required?.includes('pageId')) {
                throw new Error(`No selected page for MCP tool ${name}. Use list tabs and switch tab first.`);
            }
        }
        return this.client.callTool(name, args, this.requestTimeoutMs);
    }

    async initializeSession() {
        if (this.requireExplicitTab) {
            // list_pages verifies the browser connection without selecting a user's tab.
            return await this.listTabs();
        }
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

        const segments = splitInstructions(normalized);

        const actions = [];
        for (const segment of segments) {
            actions.push(this.parseSegment(segment));
        }

        return actions;
    }

    parseSegment(segment) {
        const titlePattern = /^(?:get\s+)?title$/i;
        if (titlePattern.test(segment) || /^タイトル(?:を)?(?:取得して|教えて|表示して|確認して)?$/.test(segment)) {
            return {type: 'title'};
        }

        const readPageMatch = segment.match(/^(?:read(?:-page)?|inspect(?:-page)?|page-info|read\s+page)$/i);
        if (readPageMatch) {
            return {type: 'read-page'};
        }

        const listTabsMatch = segment.match(/^(?:list(?:-tabs|\s+tabs)|tabs)$/i);
        if (listTabsMatch) {
            return {type: 'list-tabs'};
        }

        const newTabMatch = segment.match(/^(?:new-tab|new\s+tab)\s+(.+)$/i);
        if (newTabMatch) {
            return {type: 'new-tab', url: normalizeUrl(newTabMatch[1])};
        }

        const switchTabMatch = segment.match(/^(?:switch-tab|switch\s+tab|select-tab|select\s+tab)\s+(.+)$/i);
        if (switchTabMatch) {
            return {type: 'switch-tab', target: stripWrappingQuotes(switchTabMatch[1].trim())};
        }

        const closeTabMatch = segment.match(/^(?:close-tab|close\s+tab)(?:\s+(.+))?$/i);
        if (closeTabMatch) {
            return {type: 'close-tab', target: closeTabMatch[1] ? stripWrappingQuotes(closeTabMatch[1].trim()) : 'current'};
        }

        const openMatch = segment.match(/^(?:open|goto|go\s+to|navigate|navigate\s+to|visit)\s+(.+)$/i);
        if (openMatch) {
            return {type: 'open', url: normalizeUrl(openMatch[1])};
        }

        const backMatch = segment.match(/^(?:back|go\s+back|history\s+back|navigate\s+back)$/i);
        if (backMatch || /^(?:戻る|戻って|前のページへ|前のページに戻って)$/i.test(segment)) {
            return {type: 'history-back'};
        }

        const forwardMatch = segment.match(/^(?:forward|go\s+forward|history\s+forward|navigate\s+forward)$/i);
        if (forwardMatch || /^(?:進む|進んで|次のページへ|次のページに進んで)$/i.test(segment)) {
            return {type: 'history-forward'};
        }

        const reloadMatch = segment.match(/^(?:reload|refresh|reload\s+page|refresh\s+page)$/i);
        if (reloadMatch || /^(?:再読み込み|更新|再読み込みして|更新して)$/i.test(segment)) {
            return {type: 'reload'};
        }

        const submitMatch = segment.match(/^(?:submit\s+form|form\s+submit|submit)(?:\s+(.+))?$/i);
        if (submitMatch) {
            return {
                type: 'submit',
                target: submitMatch[1] ? stripWrappingQuotes(submitMatch[1].trim()) : 'current',
            };
        }

        const pressMatch = segment.match(/^(?:press|key)\s+(.+)$/i);
        if (pressMatch) {
            return {type: 'press', key: stripWrappingQuotes(pressMatch[1].trim())};
        }

        const clickMatch = segment.match(/^(?:click|tap)\s+(.+)$/i);
        if (clickMatch) {
            return {type: 'click', selector: stripWrappingQuotes(clickMatch[1].trim())};
        }

        const acceptDialogMatch = segment.match(/^(?:accept\s+dialog|confirm\s+dialog|dialog\s+accept)$/i);
        if (acceptDialogMatch) {
            return {type: 'dialog', action: 'accept'};
        }

        const dismissDialogMatch = segment.match(/^(?:dismiss\s+dialog|cancel\s+dialog|dialog\s+dismiss)$/i);
        if (dismissDialogMatch) {
            return {type: 'dialog', action: 'dismiss'};
        }

        const waitMatch = segment.match(/^wait(?:\s+for)?\s+(.+)$/i);
        if (waitMatch) {
            const rawTarget = waitMatch[1].trim();
            if (!/^(?:url\b|text\s+(?:gone|to\s+disappear)\b)/i.test(rawTarget)) {
                return {type: 'wait', text: stripWrappingQuotes(rawTarget)};
            }
        }

        const waitUrlMatch = segment.match(/^wait(?:\s+for)?\s+url\s+(.+)$/i);
        if (waitUrlMatch) {
            return {type: 'wait-url', value: stripWrappingQuotes(waitUrlMatch[1].trim())};
        }

        const waitTextGoneMatch = segment.match(/^wait(?:\s+for)?\s+text(?:\s+gone|\s+to\s+disappear)\s+(.+)$/i);
        if (waitTextGoneMatch) {
            return {type: 'wait-text-gone', text: stripWrappingQuotes(waitTextGoneMatch[1].trim())};
        }

        const waitGoneLooseMatch = segment.match(/^wait(?:\s+for)?\s+(.+?)\s+(?:to\s+disappear|to\s+go\s+away)$/i);
        if (waitGoneLooseMatch) {
            return {type: 'wait-text-gone', text: stripWrappingQuotes(waitGoneLooseMatch[1].trim())};
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

        const readViewportMatch = segment.match(/^(?:read\s+viewport|viewport\s+info|show\s+viewport)$/i);
        if (readViewportMatch || /^(?:viewport|画面幅|画面サイズ)(?:を)?(?:確認して|見て|表示して)$/i.test(segment)) {
            return {type: 'read-viewport'};
        }

        const viewportMatch = segment.match(/^(?:set\s+viewport|viewport|set\s+screen|screen)\s+(.+)$/i);
        if (viewportMatch) {
            return {type: 'set-viewport', value: stripWrappingQuotes(viewportMatch[1].trim())};
        }

        const evalMatch = segment.match(/^(?:eval|evaluate|js)\s+([\s\S]+)$/i);
        if (evalMatch) {
            return {type: 'eval', script: stripWrappingQuotes(evalMatch[1].trim())};
        }

        const typeMatch = segment.match(/^(?:type|fill|input|enter)\s+([\s\S]+)$/i);
        if (typeMatch) {
            return parseTypePayload(typeMatch[1]);
        }

        const readPageJaMatch = segment.match(/^(?:ページ|画面|ブラウザ)(?:を)?(?:確認して|確認|見て|読んで)$/);
        if (readPageJaMatch) {
            return {type: 'read-page'};
        }

        const listTabsJaMatch = segment.match(/^タブ(?:一覧)?(?:を)?(?:確認して|表示して|見せて)?$/);
        if (listTabsJaMatch) {
            return {type: 'list-tabs'};
        }

        const newTabJaMatch = segment.match(/^(.+?)\s*(?:を)?新しいタブで(?:開いて|表示して)$/);
        if (newTabJaMatch && looksLikeUrlOrPath(newTabJaMatch[1])) {
            return {type: 'new-tab', url: normalizeUrl(newTabJaMatch[1])};
        }

        const switchTabJaMatch = segment.match(/^(.+?)\s*(?:タブ)?に切り替えて$/);
        if (switchTabJaMatch) {
            return {type: 'switch-tab', target: stripWrappingQuotes(switchTabJaMatch[1].trim())};
        }

        const closeTabJaMatch = segment.match(/^(?:(.+?)\s*(?:タブ)?を)?閉じて$/);
        if (closeTabJaMatch) {
            return {type: 'close-tab', target: closeTabJaMatch[1] ? stripWrappingQuotes(closeTabJaMatch[1].trim()) : 'current'};
        }

        const openJaMatch = segment.match(/^(.+?)\s*(?:を)?(?:開く|開いて|表示して|に移動して)$/);
        if (openJaMatch && looksLikeUrlOrPath(openJaMatch[1])) {
            return {type: 'open', url: normalizeUrl(openJaMatch[1])};
        }

        const submitJaMatch = segment.match(/^(?:(.+?)\s*)?(?:を)?(?:送信|送信して|フォーム送信)$/i);
        if (submitJaMatch) {
            return {
                type: 'submit',
                target: submitJaMatch[1] ? stripWrappingQuotes(submitJaMatch[1].trim()) : 'current',
            };
        }

        const clickJaMatch = segment.match(/^(.+?)\s*(?:を)?(?:クリック|押して)$/);
        if (clickJaMatch) {
            return {type: 'click', selector: stripWrappingQuotes(clickJaMatch[1].trim())};
        }

        const acceptDialogJaMatch = segment.match(/^(?:ダイアログを)?(?:承認|許可|確認して|受け入れて|OKして|受け入れる)$/i);
        if (acceptDialogJaMatch) {
            return {type: 'dialog', action: 'accept'};
        }

        const dismissDialogJaMatch = segment.match(/^(?:ダイアログを)?(?:閉じて|キャンセルして|拒否して|却下して|取り消して|キャンセル)$/i);
        if (dismissDialogJaMatch) {
            return {type: 'dialog', action: 'dismiss'};
        }

        const waitJaMatch = segment.match(/^(.+?)\s*(?:が表示されるまで待って|を待って)$/);
        if (waitJaMatch) {
            return {type: 'wait', text: stripWrappingQuotes(waitJaMatch[1].trim())};
        }

        const waitUrlJaMatch = segment.match(/^url\s+(.+?)\s+になるまで待って$/i);
        if (waitUrlJaMatch) {
            return {type: 'wait-url', value: stripWrappingQuotes(waitUrlJaMatch[1].trim())};
        }

        const waitGoneJaMatch = segment.match(/^(.+?)\s*(?:が)?消えるまで待って$/);
        if (waitGoneJaMatch) {
            return {type: 'wait-text-gone', text: stripWrappingQuotes(waitGoneJaMatch[1].trim())};
        }

        const viewportJaMatch = segment.match(/^(?:画面幅|画面サイズ|viewport)\s*(.+?)\s*(?:に|へ)?(?:設定して|切り替えて|して)$/i);
        if (viewportJaMatch) {
            return {type: 'set-viewport', value: stripWrappingQuotes(viewportJaMatch[1].trim())};
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

        throw new Error('Unsupported instruction segment. Check command syntax; input omitted.');
    }

    async executeInstruction(instruction) {
        const actions = this.parseInstruction(instruction);
        for (const action of actions) {
            if (['type', 'type-active'].includes(action.type)) rememberInput(action.text);
        }
        const outputs = [];
        this.results = [];
        for (let i = 0; i < actions.length; i += 1) {
            const action = {...actions[i]};
            const step = i + 1;
            if (['click', 'eval'].includes(action.type) && actions[i + 1]?.type === 'dialog') {
                action.dialogAction = actions[++i].action;
            }
            const startedAt = Date.now();
            let output;
            let failure;
            try {
                output = await this.executeAction(action);
            } catch (error) {
                failure = error;
            }
            const record = sanitizeReport({
                step,
                throughStep: i + 1,
                total: actions.length,
                action: describeAction(action),
                status: failure ? 'failed' : 'succeeded',
                durationMs: Date.now() - startedAt,
                ...(failure ? {error: {message: failure.message, code: failure.code, context: failure.data}} : {output}),
            });
            this.results.push(record);
            if (this.onResult) await this.onResult(record);
            if (failure) throw failure;
            outputs.push(output);
        }
        return outputs;
    }

    async executeAction(action) {
        if (this.requireExplicitTab && !this.explicitTabSelected && !['list-tabs', 'switch-tab', 'new-tab'].includes(action.type)) {
            throw new Error('No explicitly selected tab. Use list tabs then switch tab <exact URL or ID> before reading or operating an existing browser.');
        }
        try {
            if (!['open', 'new-tab', 'switch-tab', 'close-tab', 'list-tabs', 'dialog'].includes(action.type)) {
                await this.ensureSelectedPageContext();
            }

            switch (action.type) {
            case 'read-page':
                return await this.readPage();
            case 'list-tabs':
                return await this.listTabs();
            case 'new-tab':
                return await this.openNewTab(action.url);
            case 'switch-tab':
                return await this.switchTab(action.target);
            case 'close-tab':
                return await this.closeTab(action.target);
            case 'open':
                return await this.openPage(action.url);
            case 'history-back':
                return await this.navigateHistory('back');
            case 'history-forward':
                return await this.navigateHistory('forward');
            case 'reload':
                return await this.reloadPage();
            case 'click':
                return await this.clickSelector(action.selector, {dialogAction: action.dialogAction});
            case 'type':
                return await this.typeIntoSelector(action.selector, action.text);
            case 'type-active':
                return await this.typeIntoActiveElement(action.text);
            case 'submit':
                return await this.submitForm(action.target);
            case 'title':
                return await this.getTitle();
            case 'wait':
                return await this.waitForText(action.text);
            case 'wait-url':
                return await this.waitForUrl(action.value);
            case 'wait-text-gone':
                return await this.waitForTextGone(action.text);
            case 'expect-title':
                return await this.expectTitle(action.value);
            case 'expect-url':
                return await this.expectUrl(action.value);
            case 'expect-text':
                return await this.expectText(action.value);
            case 'snapshot':
                return await this.snapshotSummary();
            case 'set-viewport':
                return await this.setViewport(action.value);
            case 'read-viewport':
                return await this.readViewport();
            case 'eval':
                return await this.evaluateScript(action.script, action.dialogAction);
            case 'press':
                return await this.pressKey(action.key);
            case 'dialog':
                return await this.handleDialog(action.action);
            default:
                throw new Error(`Unknown action type: ${action.type}`);
            }
        } catch (error) {
            if (this.requireExplicitTab && !this.explicitTabSelected) throw error;
            throw await this.enrichError(action, error);
        }
    }

    async openPage(url) {
        if (this.requireExplicitTab) {
            await this.ensureSelectedPageContext();
            await this.callTool(this.requireTool('navigate_page'), {type: 'url', url});
            this.latestSnapshot = null;
            return `Opened ${url}`;
        }
        const listPagesTool = this.hasTool('list_pages') ? 'list_pages' : null;
        const navigateTool = this.hasTool('navigate_page') ? 'navigate_page' : null;
        const selectPageTool = this.hasTool('select_page') ? 'select_page' : null;
        const evalTool = this.hasTool('evaluate_script') ? 'evaluate_script' : null;

        if (navigateTool && selectPageTool && this.currentPageId !== null) {
            try {
                await this.selectPage(this.currentPageId);
                await this.callTool(navigateTool, {
                    type: 'url',
                    url,
                });
                this.latestSnapshot = null;
                await this.syncCurrentPageId(url, {preferSelected: true});
                await this.autoSelectPageContext().catch(error => {
                    this.logDebug('failed to auto-select page after navigation:', error.message);
                });
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
                    await this.callTool(navigateTool, {
                        type: 'url',
                        url,
                    });
                    this.latestSnapshot = null;
                    await this.syncCurrentPageId(url, {preferSelected: true});
                    await this.autoSelectPageContext().catch(error => {
                        this.logDebug('failed to auto-select page after reusable navigation:', error.message);
                    });
                    return `Opened ${url}`;
                } catch (error) {
                    this.logDebug('navigate_page on reusable tab failed, falling back:', error.message);
                }
            }
        }

        if (navigateTool) {
            try {
                await this.callTool(navigateTool, {
                    type: 'url',
                    url,
                });
                this.latestSnapshot = null;
                await this.syncCurrentPageId(url, {preferSelected: true});
                await this.autoSelectPageContext().catch(error => {
                    this.logDebug('failed to auto-select page after direct navigation:', error.message);
                });
                return `Opened ${url}`;
            } catch (error) {
                this.logDebug('navigate_page without explicit tab selection failed, attempting in-page navigation:', error.message);
            }
        }

        if (evalTool) {
            try {
                await this.ensureSelectedPageContext();
                await this.callTool(evalTool, {
                    function: `() => { location.href = ${JSON.stringify(url)}; return location.href; }`,
                });
                this.latestSnapshot = null;
                await this.syncCurrentPageId(url, {preferSelected: true});
                await this.autoSelectPageContext().catch(error => {
                    this.logDebug('failed to auto-select page after eval navigation:', error.message);
                });
                return `Opened ${url}`;
            } catch (error) {
                this.logDebug('in-page navigation failed:', error.message);
            }
        }

        throw new Error(`Unable to open ${url} in the current tab. No safe navigation path was available.`);
    }

    async navigateHistory(direction) {
        const tool = this.requireTool('evaluate_script');
        const before = await this.safeGetCurrentPageState();
        const script = direction === 'back'
            ? '() => { history.back(); return location.href; }'
            : '() => { history.forward(); return location.href; }';

        await this.callTool(tool, {function: script});
        this.latestSnapshot = null;

        try {
            await this.waitForCondition(2000, async () => {
                const page = await this.safeGetCurrentPageState();
                return page.url && before.url && page.url !== before.url;
            }, `Timed out waiting for history ${direction}.`);
        } catch (_) {
            // History navigation can keep the same URL on some apps. Treat the request as successful.
        }

        return `History ${direction} requested`;
    }

    async reloadPage() {
        const tool = this.requireTool('evaluate_script');
        await this.callTool(tool, {
            function: '() => { location.reload(); return location.href; }',
        });
        this.latestSnapshot = null;
        return 'Reloaded current page';
    }

    async openNewTab(url) {
        if (this.requireExplicitTab) {
            this.explicitTabSelected = false;
            this.currentPageId = null;
            this.currentPageIndex = null;
            this.latestSnapshot = null;
            await this.callTool(this.requireTool('new_page'), {url});
            return `Opened new tab ${url}. Use list tabs then switch tab <exact URL or ID> to select it.`;
        }
        const tool = this.requireTool('new_page');
        const previousPages = this.hasTool('list_pages') ? await this.listPages().catch(() => []) : [];
        await this.callTool(tool, {url});
        this.latestSnapshot = null;
        await this.syncCurrentPageId(url, {preferSelected: true, previousPages});
        await this.autoSelectPageContext().catch(error => {
            this.logDebug('failed to auto-select page after opening new tab:', error.message);
        });
        return `Opened new tab ${url}`;
    }

    async clickSelector(selector, options = {}) {
        const dialogAction = options.dialogAction || null;

        if (dialogAction) {
            return this.clickSelectorWithDom(selector, {dialogAction});
        }

        const resolved = await this.resolveSnapshotTarget(selector, {mode: 'click'});
        if (resolved) {
            const tool = this.requireTool('click');
            await this.callTool(tool, {
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
        rememberInput(text);
        const resolved = await this.resolveSnapshotTarget(selector, {mode: 'fill'});
        if (resolved && this.hasTool('fill')) {
            await this.callTool('fill', {
                uid: resolved.uid,
                value: text,
                includeSnapshot: true,
            });
            await this.refreshSnapshot();
            return `Filled ${resolved.description}: [REDACTED]`;
        }

        const fallback = await this.typeIntoSelectorWithDom(selector, text);
        return `Typed into ${fallback}: [REDACTED]`;
    }

    async typeIntoActiveElement(text) {
        rememberInput(text);
        if (this.hasTool('type_text')) {
            await this.callTool('type_text', {text});
            this.latestSnapshot = null;
            return `Typed into active element: [REDACTED]`;
        }

        const tool = this.requireTool('evaluate_script');
        const textLiteral = JSON.stringify(text);
        const result = await this.callTool(tool, {
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
        return `Typed into active element: [REDACTED]`;
    }

    async submitForm(target = 'current') {
        const tool = this.requireTool('evaluate_script');
        const targetLiteral = JSON.stringify(String(target || 'current'));
        const result = await this.callTool(tool, {
            function: `() => {
                const target = ${targetLiteral};
                const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
                let form = null;

                if (!/^current$/i.test(target)) {
                    let elements;
                    try {
                        elements = Array.from(document.querySelectorAll(target));
                    } catch (_) {
                        return {ok: false, error: 'Invalid form selector'};
                    }
                    if (elements.length !== 1) return {ok: false, error: 'Expected exactly one form target'};
                    const element = elements[0];
                    form = element.tagName === 'FORM' ? element : element.closest('form');
                    if (!form) return {ok: false, error: 'Target does not belong to a form'};
                } else {
                    const active = document.activeElement;
                    form = active?.closest('form') || null;
                    if (!form) {
                        const forms = Array.from(document.querySelectorAll('form'));
                        if (forms.length !== 1) return {ok: false, error: 'Specify a unique form target'};
                        form = forms[0];
                    }
                }
                if (!form.checkValidity()) return {ok: false, error: 'Form validation failed'};

                if (typeof form.requestSubmit === 'function') {
                    form.requestSubmit();
                } else {
                    return {ok: false, error: 'requestSubmit is unavailable; click the submit button explicitly'};
                }

                return { ok: true, target, formTag: form.tagName, action: normalize(form.action || location.href) };
            }`,
        });

        this.latestSnapshot = null;
        const payload = unwrapToolResult(result);
        if (!payload || payload.ok !== true) {
            throw new Error(`Submit failed for target "${target}": ${payload?.error || "Unknown error"}`);
        }

        const formTag = payload.formTag || 'FORM';
        return `Submitted ${formTag}${target && !/^current$/i.test(String(target)) ? ` (${target})` : ''}`;
    }

    async getTitle() {
        const tool = this.requireTool('evaluate_script');
        const result = await this.callTool(tool, {
            function: '() => document.title',
        });

        const payload = unwrapToolResult(result);
        return `Title: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`;
    }

    async evaluateScript(script, dialogAction = null) {
        const tool = this.requireTool('evaluate_script');
        const request = {
            function: script,
        };

        if (dialogAction) {
            request.dialogAction = dialogAction;
        }

        const result = await this.callTool(tool, request);

        const response = unwrapToolResult(result);
        return `Eval: ${typeof response === 'string' ? response : JSON.stringify(response)}`;
    }

    async handleDialog(action = 'accept', promptText = null) {
        const tool = this.requireTool('handle_dialog');
        const payload = {action};

        if (promptText !== null && promptText !== undefined && String(promptText).length > 0) {
            payload.promptText = String(promptText);
        }

        await this.callTool(tool, payload);
        this.latestSnapshot = null;
        return `Dialog ${action}ed`;
    }

    async pressKey(key) {
        const tool = this.requireTool('press_key');
        await this.callTool(tool, {key});
        this.latestSnapshot = null;
        return `Pressed ${key}`;
    }

    async waitForText(text, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
        if (this.hasTool('wait_for')) {
            await this.callTool('wait_for', {
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
        return this.formatElements(snapshot.elements || parseSnapshotElements(snapshot.text), 20);
    }

    formatElements(elements, defaultLimit) {
        const filtered = this.view.filter
            ? elements.filter(element => normalizeText(element.line || `${element.role} ${element.name}`).includes(normalizeText(this.view.filter)))
            : elements;
        const offset = Math.min(this.view.offset, filtered.length);
        const limit = this.view.limit ?? (this.view.full ? filtered.length : defaultLimit);
        const shown = filtered.slice(offset, offset + limit);
        return [
            `Elements: total=${elements.length}, matched=${filtered.length}, shown=${shown.length}, offset=${offset}, omitted=${filtered.length - shown.length}`,
            renderElementSummary(shown) || '(no matching snapshot elements)',
        ].join('\n');
    }

    async setViewport(value) {
        const viewport = parseViewportSpec(value);
        const toolName = this.hasTool('emulate') ? 'emulate' : null;
        const resizeTool = this.hasTool('resize_page') ? 'resize_page' : null;

        if (toolName) {
            const payload = {};
            if (viewport.emulateValue) {
                payload.viewport = viewport.emulateValue;
            }
            if (viewport.userAgent) {
                payload.userAgent = viewport.userAgent;
            }
            if (viewport.colorScheme) {
                payload.colorScheme = viewport.colorScheme;
            }
            if (viewport.networkConditions) {
                payload.networkConditions = viewport.networkConditions;
            }
            await this.callTool(toolName, payload);
            this.currentViewport = viewport;
            this.latestSnapshot = null;
            return `Viewport set to ${viewport.label}`;
        }

        if (resizeTool) {
            await this.callTool(resizeTool, {
                width: viewport.width,
                height: viewport.height,
            });
            this.currentViewport = viewport;
            this.latestSnapshot = null;
            return `Viewport resized to ${viewport.width}x${viewport.height}`;
        }

        throw new Error('Viewport tools are unavailable.');
    }

    async reapplyViewportPreference() {
        if (!this.currentViewport) {
            return;
        }

        const viewport = this.currentViewport;
        const toolName = this.hasTool('emulate') ? 'emulate' : null;
        const resizeTool = this.hasTool('resize_page') ? 'resize_page' : null;

        if (toolName) {
            const payload = {};
            if (viewport.emulateValue) {
                payload.viewport = viewport.emulateValue;
            }
            if (viewport.userAgent) {
                payload.userAgent = viewport.userAgent;
            }
            if (viewport.colorScheme) {
                payload.colorScheme = viewport.colorScheme;
            }
            if (viewport.networkConditions) {
                payload.networkConditions = viewport.networkConditions;
            }

            await this.callTool(toolName, payload);
            return;
        }

        if (resizeTool) {
            await this.callTool(resizeTool, {
                width: viewport.width,
                height: viewport.height,
            });
        }
    }

    async readViewport() {
        const page = await this.getCurrentPageState();
        const tool = this.requireTool('evaluate_script');
        const result = await this.callTool(tool, {
            function: '() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight, devicePixelRatio: window.devicePixelRatio, userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints || 0, hoverNone: window.matchMedia(\'(hover: none)\').matches, pointerCoarse: window.matchMedia(\'(pointer: coarse)\').matches })',
        });
        const info = unwrapToolResult(result) || {};

        return `Viewport: ${JSON.stringify({
            url: page.url || '(unknown)',
            width: info.innerWidth ?? null,
            height: info.innerHeight ?? null,
            outerWidth: info.outerWidth ?? null,
            outerHeight: info.outerHeight ?? null,
            devicePixelRatio: info.devicePixelRatio ?? null,
            maxTouchPoints: info.maxTouchPoints ?? null,
            hoverNone: info.hoverNone ?? null,
            pointerCoarse: info.pointerCoarse ?? null,
        })}`;
    }

    async readPage() {
        const page = await this.getCurrentPageState();
        const snapshot = await this.refreshSnapshot();
        const elements = snapshot.elements || parseSnapshotElements(snapshot.text || '');
        const text = redactOutput(page.text);
        const preview = this.view.full ? text : text.slice(0, this.view.textLimit);
        return [
            `Page: ${page.title || '(no title)'}`,
            `URL: ${page.url || '(unknown)'}`,
            `Text: ${preview || (text ? '(omitted)' : '(empty)')}`,
            `Text characters: shown=${preview.length}, omitted=${text.length - preview.length}`,
            this.formatElements(elements, 12),
        ].join('\n');
    }

    async getCurrentPageState() {
        const tool = this.requireTool('evaluate_script');
        const result = await this.callTool(tool, {
            function: `() => ({
                url: location.href,
                title: document.title,
                text: (document.body && document.body.innerText ? document.body.innerText : '').replace(/\\s+/g, ' ').trim(),
            })`,
        });

        const payload = unwrapToolResult(result);
        if (!payload || typeof payload.url !== 'string' || typeof payload.title !== 'string' || typeof payload.text !== 'string') {
            throw new Error('Invalid page state response from MCP');
        }
        return payload;
    }

    async refreshSnapshot(verbose = false) {
        if (!this.hasTool('take_snapshot')) throw new Error('take_snapshot is unavailable');

        const result = await this.callTool('take_snapshot', {verbose});
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
            if (parseTargetHints(target).uid) throw new Error('Snapshot UID not found; refresh the snapshot.');
            return null;
        }

        if (matches.length > 1 && matches[0].score === matches[1].score) {
            throw createAmbiguousTargetError(target, matches.filter(match => match.score === matches[0].score));
        }

        const best = matches[0].element;
        return {
            uid: best.uid,
            description: describeSnapshotElement(best),
            strategy: 'snapshot',
        };
    }

    async clickSelectorWithDom(selector, options = {}) {
        const tool = this.requireTool('evaluate_script');
        const selectorLiteral = JSON.stringify(selector);
        const toolPayload = {
            function: `() => {
                const selector = ${selectorLiteral};
                const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
                let element = null;

                try {
                    const cssMatches = Array.from(document.querySelectorAll(selector));
                    if (cssMatches.length > 1) return {ok: false, error: 'Ambiguous selector; use a unique selector or UID'};
                    element = cssMatches[0] || null;
                } catch (_) {
                    element = null;
                }

                if (!element) {
                    const targetText = normalize(selector);
                    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]'));
                    const matches = candidates.filter((candidate) => {
                        const text = candidate.tagName === 'INPUT'
                            ? normalize(candidate.value)
                            : normalize(candidate.textContent);
                        return text === targetText;
                    });
                    if (matches.length > 1) return {ok: false, error: 'Ambiguous label; use a unique selector or UID'};
                    element = matches[0] || null;
                }

                if (!element) {
                    return { ok: false, error: 'Element not found', selector };
                }

                if (element.disabled || element.getAttribute('aria-disabled') === 'true' || element.getClientRects().length === 0) {
                    return {ok: false, error: 'Target is disabled or not visible'};
                }
                element.click();
                return { ok: true, selector, tagName: element.tagName };
            }`,
        };

        if (options.dialogAction) {
            toolPayload.dialogAction = options.dialogAction;
        }

        const result = await this.callTool(tool, toolPayload);

        const payload = unwrapToolResult(result);
        if (!payload || payload.ok !== true) {
            throw new Error(`Click failed for selector "${selector}": ${payload?.error || "Unknown error"}`);
        }

        return selector;
    }

    async typeIntoSelectorWithDom(selector, text) {
        rememberInput(text);
        const tool = this.requireTool('evaluate_script');
        const selectorLiteral = JSON.stringify(selector);
        const result = await this.callTool(tool, {
            function: `() => {
                const selector = ${selectorLiteral};
                const matches = Array.from(document.querySelectorAll(selector));
                if (matches.length !== 1) return {ok: false, error: 'Expected exactly one editable target'};
                const element = matches[0];
                if (!element) {
                    return { ok: false, error: 'Element not found', selector };
                }

                if (element.disabled || element.readOnly || element.getClientRects().length === 0) {
                    return {ok: false, error: 'Target is disabled, read-only or not visible'};
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
            throw new Error(`Type failed for selector "${selector}": ${payload?.error || "Unknown error"}`);
        }

        if (this.hasTool('type_text')) {
            await this.callTool('type_text', {text});
            return selector;
        }

        const fallbackTextLiteral = JSON.stringify(text);
        const applyResult = await this.callTool(tool, {
            function: `() => {
                const selector = ${selectorLiteral};
                const value = ${fallbackTextLiteral};
                const matches = Array.from(document.querySelectorAll(selector));
                if (matches.length !== 1) return {ok: false, error: 'Expected exactly one editable target'};
                const element = matches[0];
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
            throw new Error(`Type failed for selector "${selector}": ${applyPayload?.error || "Unknown error"}`);
        }

        return selector;
    }

    async listConsoleErrors() {
        const result = await this.callTool(this.requireTool('list_console_messages'), {
            types: ['error'], pageSize: 10,
        });
        return extractStructuredData(result) ?? extractPlainText(result);
    }

    async enrichError(action, error) {
        const enriched = new Error(error.message);
        enriched.code = error.code;
        const diagnostics = {};
        const previousTimeout = this.requestTimeoutMs;
        this.requestTimeoutMs = this.diagnosticTimeoutMs;
        try {
            // Diagnose read-only state; never retry the failed action.
            for (const [name, tool, read] of [
                ['page', 'evaluate_script', () => this.getCurrentPageState()],
                ['snapshot', 'take_snapshot', () => this.refreshSnapshot()],
                ['console', 'list_console_messages', () => this.listConsoleErrors()],
            ]) {
                if (!this.hasTool(tool)) {
                    diagnostics[name] = {status: 'unavailable'};
                    continue;
                }
                try {
                    let value = sanitizeReport(await read());
                    if (name === 'page') {
                        const text = value.text;
                        value = {...value, text: text.slice(0, 1000), omittedCharacters: Math.max(0, text.length - 1000)};
                    } else if (name === 'snapshot') {
                        const lines = value.text.split(/\r?\n/);
                        value = {text: lines.slice(0, 40).join('\n'), count: value.elements.length, omittedLines: Math.max(0, lines.length - 40)};
                    } else if (typeof value === 'string') {
                        value = {text: value.slice(0, 4000), omittedCharacters: Math.max(0, value.length - 4000)};
                    }
                    diagnostics[name] = {status: 'ok', value};
                } catch (diagnosticError) {
                    diagnostics[name] = {status: 'failed', message: diagnosticError.message};
                }
            }
        } finally {
            this.requestTimeoutMs = previousTimeout;
        }
        enriched.data = sanitizeReport({
            ...(error.data ? {cause: error.data} : {}),
            action: describeAction(action),
            pageId: this.currentPageId,
            diagnostics,
        });
        return enriched;
    }

    async safeGetCurrentPageState() {
        try {
            return await this.getCurrentPageState();
        } catch (_) {
            return {url: '', title: '', text: ''};
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
        const result = await this.callTool(tool, {});
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

        await this.callTool(tool, payload);
        this.currentPageId = payload.pageId ?? null;
        this.currentPageIndex = target && typeof target === 'object' && Number.isInteger(target.index) ? target.index : null;
        await this.reapplyViewportPreference().catch(error => {
            this.logDebug('failed to reapply viewport preference:', error.message);
        });
    }

    async switchTab(target) {
        if (this.requireExplicitTab && /^(current|first|last)$/i.test(String(target))) {
            throw new Error('Select an existing tab by exact URL or ID, not current/first/last.');
        }
        const pages = await this.listPages();
        if (this.requireExplicitTab && !/^\d+$/.test(String(target)) && !pages.some(page => page.url === target)) {
            throw new Error('Existing mode requires an exact tab URL or numeric ID. Use list tabs.');
        }
        const page = findPageByTarget(pages, target, this.currentPageId, this.currentPageIndex);
        if (!page) {
            throw new Error(`Tab not found: ${target}`);
        }

        await this.selectPage(page, true);
        this.explicitTabSelected = true;
        await this.waitForSelectedPage(page).catch(error => {
            this.logDebug('selected tab verification failed:', error.message);
        });
        this.latestSnapshot = null;
        return `Switched to tab ${formatPageRef(page)}`;
    }

    async closeTab(target = 'current') {
        this.explicitTabSelected = false;
        const tool = this.requireTool('close_page');
        const pages = await this.listPages();
        const page = findPageByTarget(pages, target, this.currentPageId, this.currentPageIndex);
        if (!page) {
            throw new Error(`Tab not found: ${target}`);
        }

        if (!Number.isInteger(page.index)) {
            throw new Error(`Tab index is unavailable for ${formatPageRef(page)}`);
        }

        await this.callTool(tool, {pageId: page.pageId});
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

// Delimiters inside quoted strings or bracketed expressions are data, not commands.
function splitInstructions(input) {
    const segments = [];
    let buffer = '';
    let quote = null;
    let escaped = false;
    const brackets = [];
    for (let i = 0; i < input.length; i += 1) {
        const char = input[i];
        if (escaped) {
            buffer += char;
            escaped = false;
            continue;
        }
        if (char === '\\') {
            buffer += char;
            escaped = true;
            continue;
        }
        if (quote) {
            buffer += char;
            if (char === quote) quote = null;
            continue;
        }
        if ('"\'`'.includes(char) && (i === 0 || /[\s=([{,:]/.test(input[i - 1]))) {
            quote = char;
            buffer += char;
            continue;
        }
        if ('([{'.includes(char)) brackets.push(char);
        if (')]}'.includes(char)) {
            const opening = brackets.pop();
            if (char !== {'(': ')', '[': ']', '{': '}'}[opening]) {
                throw new Error('Unbalanced brackets in instruction; input omitted.');
            }
        }
        const separator = brackets.length === 0 ? input.slice(i).match(/^(?:\s+(?:then|and)\s+|[\n、]+)/i) : null;
        if (separator) {
            if (buffer.trim()) segments.push(buffer.trim());
            buffer = '';
            i += separator[0].length - 1;
        } else {
            buffer += char;
        }
    }
    if (quote || escaped || brackets.length) throw new Error('Unterminated quote, escape or bracket; input omitted.');
    if (buffer.trim()) segments.push(buffer.trim());
    return segments;
}

function parseTypePayload(payload) {
    const match = payload.trim().match(/^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)(?:\s+([\s\S]+))?$/);
    if (!match) throw new Error('Invalid type syntax; quote the selector and value separately.');
    if (match[2] === undefined) return {type: 'type-active', text: stripWrappingQuotes(match[1])};
    return {type: 'type', selector: stripWrappingQuotes(match[1]), text: stripWrappingQuotes(match[2])};
}

function stripWrappingQuotes(value) {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        const quote = value[0];
        return value.slice(1, -1).replace(/\\([\\"'])/g, (match, char) => char === quote || char === '\\' ? char : match);
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

    if (targetHints.uid) {
        return element.uid === targetHints.uid ? 1000 : 0;
    }
    if (targetHints.role && element.role !== targetHints.role) {
        return 0;
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

    if (score > 0 && targetHints.role) {
        score += 100;
    }

    return Math.max(score, 0);
}

function parseTargetHints(target) {
    const raw = stripWrappingQuotes(String(target).trim());
    const normalized = normalizeText(raw);
    const uidMatch = raw.match(/^uid[:=](.+)$/i);
    const roleNameMatch = raw.match(/^(button|link|textbox|combobox|checkbox|radio|tab|menuitem|switch|searchbox)\s+(.+)$/i);

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

        // Current MCP versions include the title before the parenthesized URL.
        const titledMatch = trimmed.match(/^(\d+):\s+(.*?)\s+\((\S+)\)(?:\s+(\[selected\]))?$/i);
        if (titledMatch) {
            const pageId = Number(titledMatch[1]);
            pages.push({
                pageId,
                index: pageId,
                selected: Boolean(titledMatch[4]),
                title: titledMatch[2],
                url: titledMatch[3],
            });
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

    const exact = pages.filter(page => page.url === normalizedTarget || page.title === normalizedTarget);
    const needle = normalizeText(normalizedTarget);
    const matches = exact.length ? exact : pages.filter(page => normalizeText(page.title).includes(needle) || normalizeText(page.url).includes(needle));
    if (matches.length > 1) throw new Error('Multiple tabs match. Use list tabs and select a unique tab ID.');
    return matches[0] || null;
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

    // Resolve the pinned dependency before probing the browser or launching processes.
    buildServerCommand(runtime);
    if (runtime.browserMode === 'existing' && !runtime.browserUrl && !runtime.wsEndpoint) {
        const candidate = `http://${runtime.cdpHost}:${runtime.cdpPort}`;
        try {
            const version = await getCdpVersion(candidate);
            if (typeof version.webSocketDebuggerUrl === 'string') runtime.browserUrl = candidate;
        } catch (error) {
            // Chrome approval mode hides HTTP discovery but exposes the consent-gated
            // /devtools/browser WebSocket. Never retry after consent is denied.
            if (error.message === 'HTTP 404' && ['127.0.0.1', 'localhost'].includes(runtime.cdpHost)) {
                runtime.wsEndpoint = `ws://${runtime.cdpHost}:${runtime.cdpPort}/devtools/browser`;
            }
        }
    }
    if (runtime.browserMode === 'isolated') {
        const chromePath = runtime.chromePath || defaultChromePath();
        ensureChromeExecutable(chromePath);
        runtime.chromeUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-devtools-runner-'));
        const child = launchChromeForCdp({chromePath, cdpPort: 0, userDataDir: runtime.chromeUserDataDir, logFile: runtime.chromeLogFile});
        runtime.chromePid = child.pid;
        let launchError;
        child.once('error', error => { launchError = error; });
        const deadline = Date.now() + runtime.cdpStartupTimeoutMs;
        try {
            while (Date.now() < deadline) {
                if (launchError) throw launchError;
                if (child.exitCode !== null || child.signalCode !== null) throw new Error('Chrome exited before CDP became available.');
                const activePort = path.join(runtime.chromeUserDataDir, 'DevToolsActivePort');
                if (fs.existsSync(activePort)) {
                    const port = Number(fs.readFileSync(activePort, 'utf8').split('\n')[0]);
                    if (Number.isInteger(port) && port > 0 && port <= 65535) {
                        runtime.browserUrl = `http://127.0.0.1:${port}`;
                        break;
                    }
                }
                await delay(100);
            }
            if (!runtime.browserUrl) throw new Error('Timed out waiting for the new Chrome debugging port.');
            await waitForCdp(runtime.browserUrl, runtime.cdpStartupTimeoutMs, child, runtime.chromeLogFile, chromePath);
        } catch (error) {
            if (child.pid) child.kill();
            throw error;
        }
        writeOutput('log', `[browser] New Chrome will remain open after this run. Reconnect with --browser-url ${runtime.browserUrl} and explicitly select a tab.`);
    }
    runtime.serverCommand = buildServerCommand(runtime);

    if (runtime.ensureCdp) {
        runtime.chromeUserDataDir = resolveChromeUserDataDir(runtime);
    }

    if (runtime.ensureCdp) {
        await ensureCdp(runtime);
    }

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

function buildServerCommand(options = {}) {
    let command = options.serverCommand || process.env.MCP_SERVER_COMMAND;
    if (!command) {
        const skillDirectory = path.resolve(__dirname, '..');
        const expectedVersion = require('../package.json').dependencies['chrome-devtools-mcp'];
        const packageDirectory = path.join(skillDirectory, 'node_modules', 'chrome-devtools-mcp');
        const entryPoint = path.join(packageDirectory, 'build/src/bin/chrome-devtools-mcp.js');
        let installedVersion;
        try {
            installedVersion = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8')).version;
        } catch {
            // Report a setup instruction rather than silently downloading a different version.
        }
        if (installedVersion !== expectedVersion || !fs.existsSync(entryPoint)) {
            throw new Error(`Pinned chrome-devtools-mcp ${expectedVersion} is not installed. Run npm ci --ignore-scripts in ${skillDirectory}.`);
        }
        command = `${quoteShellArg(process.execPath)} ${quoteShellArg(entryPoint)}`;
    }

    if (options.browserMode === 'existing' && !options.browserUrl && !options.wsEndpoint) command += ' --autoConnect';
    if (options.wsEndpoint) command += ` --wsEndpoint ${quoteShellArg(options.wsEndpoint)}`;
    if (options.browserMode === 'isolated' && !options.browserUrl) {
        command += ' --isolated';
        if (options.chromePath) command += ` --executablePath ${quoteShellArg(options.chromePath)}`;
    }

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

function parseViewportSpec(value) {
    const raw = stripWrappingQuotes(String(value || '').trim());
    if (!raw) {
        throw new Error('Viewport value must not be empty.');
    }

    const normalized = raw.toLowerCase().replace(/\s+/g, '');
    const presets = {
        mobile: {width: 390, height: 844, devicePixelRatio: 3, mobile: true, touch: true, label: 'mobile 390x844'},
        iphone: {width: 390, height: 844, devicePixelRatio: 3, mobile: true, touch: true, label: 'iphone 390x844'},
        tablet: {width: 768, height: 1024, devicePixelRatio: 2, mobile: true, touch: true, label: 'tablet 768x1024'},
        desktop: {width: 1440, height: 900, devicePixelRatio: 1, mobile: false, touch: false, label: 'desktop 1440x900'},
    };

    if (presets[normalized]) {
        const preset = presets[normalized];
        return {
            ...preset,
            emulateValue: `${preset.width}x${preset.height}x${preset.devicePixelRatio}${preset.mobile ? ',mobile' : ''}${preset.touch ? ',touch' : ''}`,
            userAgent: null,
            colorScheme: null,
            networkConditions: null,
        };
    }

    const match = raw.match(/^(\d+)\s*[x×]\s*(\d+)(?:\s*[x×]\s*(\d+(?:\.\d+)?))?(?:\s*,\s*(.*))?$/i);
    if (!match) {
        throw new Error(`Unsupported viewport value "${value}". Use mobile, tablet, desktop, or WIDTHxHEIGHT[xDPR][,mobile][,touch][,landscape].`);
    }

    const width = Number(match[1]);
    const height = Number(match[2]);
    const dpr = typeof match[3] !== 'undefined' ? Number(match[3]) : 1;
    const flags = String(match[4] || '').split(/\s*,\s*/).map(flag => flag.trim().toLowerCase()).filter(Boolean);
    const mobile = flags.includes('mobile');
    const touch = flags.includes('touch') || mobile;
    const landscape = flags.includes('landscape');
    const finalWidth = landscape ? height : width;
    const finalHeight = landscape ? width : height;

    return {
        width: finalWidth,
        height: finalHeight,
        devicePixelRatio: dpr,
        mobile,
        touch,
        label: raw,
        emulateValue: `${finalWidth}x${finalHeight}x${dpr}${mobile ? ',mobile' : ''}${touch ? ',touch' : ''}${landscape ? ',landscape' : ''}`,
        userAgent: null,
        colorScheme: null,
        networkConditions: null,
    };
}

async function ensureCdp(options) {
    if (await isCdpAvailable(options.browserUrl)) {
        return;
    }

    const chromePath = options.chromePath || defaultChromePath();
    if (!chromePath) {
        throw new Error('Chrome executable path is required. Pass --chrome-path or set CHROME_PATH.');
    }
    ensureChromeExecutable(chromePath);

    const cdpPort = browserUrlPort(options.browserUrl) || options.cdpPort;
    const child = launchChromeForCdp({
        chromePath,
        cdpPort,
        userDataDir: options.chromeUserDataDir,
        logFile: options.chromeLogFile,
    });

    writeOutput('error', `[cdp] starting Chrome pid=${child.pid} port=${cdpPort} userDataDir=${options.chromeUserDataDir}`);
    await waitForCdp(options.browserUrl, options.cdpStartupTimeoutMs, child, options.chromeLogFile, chromePath);
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

async function waitForCdp(browserUrl, timeoutMs, child = null, logFile = null, chromePath = null) {
    const startedAt = Date.now();
    let lastError = null;
    let launchExit = null;
    let stableSince = null;

    if (child) {
        child.once('exit', (code, signal) => {
            launchExit = {code, signal};
        });
    }

    while (Date.now() - startedAt < timeoutMs) {
        try {
            const version = await getCdpVersion(browserUrl);
            if (!stableSince) {
                stableSince = Date.now();
                await delay(250);
                continue;
            }

            if (Date.now() - stableSince >= 250) {
                if (!version || typeof version !== 'object' || !version.webSocketDebuggerUrl) {
                    throw new Error('CDP version response missing webSocketDebuggerUrl');
                }
                return;
            }
        } catch (error) {
            lastError = error;
            stableSince = null;
            if (launchExit) {
                throw new Error(formatChromeStartupFailure({
                    code: launchExit.code,
                    signal: launchExit.signal,
                    logFile,
                    chromePath,
                }));
            }
            await delay(200);
        }
    }

    const logHint = logFile ? ` See ${logFile}` : '';
    throw new Error(`Timed out waiting for Chrome DevTools Protocol at ${browserUrl}: ${lastError ? lastError.message : 'not available'}.${logHint}`);
}

function formatChromeStartupFailure({code, signal, logFile, chromePath}) {
    const parts = [`Chrome exited before CDP became available (code=${code}, signal=${signal}).`];
    if (chromePath) {
        parts.push(`Chrome path: ${chromePath}.`);
    }
    if (logFile) {
        parts.push(`See ${logFile}.`);
    }
    parts.push('Verify that the Chrome binary is runnable and that no local Chrome profile, permission, or crash-reporting issue is preventing startup.');
    return parts.join(' ');
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

function ensureChromeExecutable(chromePath) {
    if (!fs.existsSync(chromePath)) {
        throw new Error(`Chrome executable was not found at ${chromePath}. Pass --chrome-path explicitly or set CHROME_PATH.`);
    }

    try {
        fs.accessSync(chromePath, fs.constants.X_OK);
    } catch {
        throw new Error(`Chrome executable is not runnable at ${chromePath}. Check file permissions or pass a different --chrome-path.`);
    }
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
        'Default mode: launch a fresh Chrome; use --existing only when explicitly requested.',
        '  node chrome-devtools-runner.js --isolated "open https://example.com then read page"',
        '',
        'CDP mode: connect to an existing Chrome DevTools Protocol endpoint.',
        '  node chrome-devtools-runner.js --browser-url http://127.0.0.1:9222 "list tabs then switch tab 1 then title"',
        '',
        'Managed CDP mode: start Chrome with CDP if the endpoint is not running.',
        '  node chrome-devtools-runner.js --ensure-cdp "open http://localhost:3000 then click Dashboard then reload then read page"',
        '',
        'Options:',
        '  --existing (connect to running Chrome; requires remote debugging and Chrome approval)',
        '  --isolated (default: launch an independent Chrome with a temporary profile)',
        '  --full / --offset N / --limit N / --text-limit N / --filter TEXT',
        '  --output PATH (save a redacted JSON report; existing files are never overwritten)',
        '  --stdin (read instructions from standard input; avoids input values in argv)',
        '  --debug',
        '  --show-tools',
        '  --show-tool-schemas',
        '  --timeout <ms>',
        '  --server-command <command>',
        '  --browser-url <url>',
        '  --ws-endpoint <ws://...> (explicit browser WebSocket; Chrome approval is preserved)',
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
    let options;
    let client = null;
    let reportFd = null;
    const report = {status: 'running', steps: []};
    const saveReport = () => {
        if (reportFd === null) return;
        const contents = JSON.stringify(sanitizeReport(report), null, 2) + '\n';
        fs.writeSync(reportFd, contents, 0, 'utf8');
        fs.ftruncateSync(reportFd, Buffer.byteLength(contents));
    };
    try {
        options = parseArgs(process.argv.slice(2));
        if (options.stdin) {
            if (options.instruction) throw new Error('Use either --stdin or an instruction argument, not both.');
            options.instruction = fs.readFileSync(0, 'utf8').trim();
        }
        if (!options.instruction && !options.showTools && !options.showToolSchemas) {
            writeOutput('error', renderUsage());
            process.exitCode = 1;
            return;
        }
        // Parse before launching Chrome/MCP and register every input before any output.
        if (options.instruction) {
            const parser = new ChromeMcpCli({tools: []});
            for (const action of parser.parseInstruction(options.instruction)) {
                if (['type', 'type-active'].includes(action.type)) rememberInput(action.text);
            }
        }
        if (options.outputPath !== null) {
            reportFd = fs.openSync(options.outputPath, 'wx', 0o600);
            saveReport();
        }
        const runtime = await prepareRuntime(options);
        const connection = {mode: runtime.browserMode, endpoint: runtime.wsEndpoint || runtime.browserUrl || (runtime.browserMode === 'existing' ? 'autoConnect (running Chrome stable)' : runtime.browserMode === 'isolated' ? 'new temporary Chrome profile' : runtime.browserMode)};
        report.connection = connection;
        saveReport();
        writeOutput('log', `[browser] mode=${connection.mode} target=${connection.endpoint}`);
        if (runtime.browserMode === 'existing') {
            writeOutput('log', '[browser] Chrome 144+: enable remote debugging at chrome://inspect/#remote-debugging and approve the Chrome connection prompt. No new Chrome will be launched.');
        }

        client = new McpStdioClient({
            command: runtime.serverCommand,
            debug: runtime.debug,
            timeoutMs: runtime.timeoutMs,
        });

        await client.start();

        if (options.showTools || options.showToolSchemas) {
            writeOutput('log', options.showToolSchemas ? renderToolSchemas(client.tools) : renderToolNames(client.tools));
            report.status = 'succeeded';
            saveReport();
            return;
        }

        const cli = new ChromeMcpCli(client, {
            debug: options.debug,
            browserUrl: runtime.browserUrl,
            view: options.view,
            requireExplicitTab: runtime.browserMode === 'existing',
            onResult: record => {
                report.steps.push(record);
                saveReport();
                const span = record.step === record.throughStep ? record.step : `${record.step}-${record.throughStep}`;
                writeOutput(record.status === 'failed' ? 'error' : 'log', `[${span}/${record.total}] ${record.status} ${record.action.type} (${record.durationMs} ms)`);
                if (record.output !== undefined) writeOutput('log', record.output);
            },
        });
        try {
            const tabs = await cli.initializeSession();
            if (runtime.browserMode === 'existing') {
                writeOutput('log', '[browser] Connected. Runner target: none (explicit selection required).');
                writeOutput('log', tabs);
            }
        } catch (error) {
            const hint = runtime.wsEndpoint
                ? 'Verify the WebSocket endpoint and approve the Chrome connection prompt.'
                : runtime.browserUrl
                ? 'Verify Chrome is running with CDP enabled and --browser-url points to its endpoint. For Chrome approval mode (HTTP 404), use --existing or --ws-endpoint ws://127.0.0.1:9222/devtools/browser.'
                : 'Use Chrome 144+ stable, enable chrome://inspect/#remote-debugging, and approve the Chrome prompt.';
            throw new Error(`Browser connection failed: ${error.message}. ${hint} To start an independent browser, use --isolated. No automatic fallback was attempted.`);
        }
        await cli.executeInstruction(options.instruction);
        report.status = 'succeeded';
        saveReport();
    } catch (error) {
        report.status = 'failed';
        report.error = {message: error.message, code: error.code, context: error.data};
        try { saveReport(); } catch (saveError) { writeOutput('error', 'Failed to save report:', saveError.message); }
        writeOutput('error', '[error]', error.message);
        if (error.code) {
            writeOutput('error', '[error] code:', error.code);
        }
        if (error.data) {
            writeOutput('error', '[error] data:', JSON.stringify(error.data, null, 2));
        }
        process.exitCode = 1;
    } finally {
        if (reportFd !== null) fs.closeSync(reportFd);
        if (client) {
            await client.close().catch(closeError => {
                writeOutput('error', '[error] failed to close MCP client:', closeError.message);
            });
        }
    }
}

if (require.main === module) main();

module.exports = {ChromeMcpCli, McpStdioClient, parseArgs, splitInstructions, redactOutput, rememberInput, buildServerCommand, prepareRuntime};
