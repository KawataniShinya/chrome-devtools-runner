const test = require('node:test');
const assert = require('node:assert/strict');
const {parseArgs, buildServerCommand, ChromeMcpCli} = require('../scripts/chrome-devtools-runner');

test('default and isolated modes launch a fresh Chrome; existing mode is explicit', () => {
    assert.equal(parseArgs(['list tabs']).browserMode, 'isolated');
    const defaultCommand = buildServerCommand(parseArgs(['list tabs']));
    assert.match(defaultCommand, / --isolated$/);
    assert.doesNotMatch(defaultCommand, /autoConnect|browserUrl|wsEndpoint/);
    assert.match(buildServerCommand(parseArgs(['--existing', 'list tabs'])), / --autoConnect$/);
    const isolated = buildServerCommand(parseArgs(['--isolated', 'list tabs']));
    assert.match(isolated, / --isolated$/);
    assert.doesNotMatch(isolated, /autoConnect|browserUrl/);
    const explicit = buildServerCommand(parseArgs(['--browser-url', 'http://127.0.0.1:9222', 'list tabs']));
    assert.match(explicit, /--browserUrl/);
    assert.doesNotMatch(explicit, /autoConnect|isolated/);
    assert.equal(parseArgs(['--ensure-cdp', 'list tabs']).browserMode, 'ensure-cdp');
    assert.equal(parseArgs(['--server-command', 'mock', 'list tabs']).browserMode, 'custom');
});
for (const args of [
    ['--existing', '--isolated'], ['--existing', '--ensure-cdp'],
    ['--isolated', '--ensure-cdp'], ['--isolated', '--browser-url', 'http://localhost:9222'],
    ['--existing', '--server-command', 'mock'], ['--isolated', '--server-command', 'mock'],
    ['--existing', '--chrome-user-data-dir', '/tmp/profile'], ['--isolated', '--reuse-chrome-profile'],
]) {
    test(`conflicting connection options fail: ${args.join(' ')}`, () => assert.throws(() => parseArgs(args)));
}
function existingCli() {
    const calls = [];
    const cli = new ChromeMcpCli({tools: [], callTool: async () => {}}, {requireExplicitTab: true});
    cli.listPages = async () => [{pageId: 1, index: 1, selected: true, title: 'One', url: 'https://example.test/one'}, {pageId: 2, index: 2, title: 'Two', url: 'https://example.test/two'}];
    cli.selectPage = async page => { calls.push(page); cli.currentPageId = page.pageId; };
    cli.waitForSelectedPage = async () => {};
    return {cli, calls};
}
test('connection lists tabs without automatically selecting one', async () => {
    const {cli, calls} = existingCli();
    assert.match(await cli.initializeSession(), /One/);
    assert.deepEqual(calls, []);
    assert.equal(cli.currentPageId, null);
});
test('unselected existing browser rejects reads and mutations before any diagnostic calls', async () => {
    const {cli, calls} = existingCli();
    cli.enrichError = () => assert.fail('must not inspect an unselected page');
    for (const type of ['read-page', 'click', 'submit', 'open', 'close-tab', 'eval', 'dialog']) {
        await assert.rejects(cli.executeAction({type}), /explicitly selected tab/);
    }
    assert.deepEqual(calls, []);
});
test('exact URL selects a target, duplicate URLs and positional aliases do not', async () => {
    const {cli, calls} = existingCli();
    for (const target of ['current', 'first', 'last', 'example.test']) await assert.rejects(cli.switchTab(target));
    assert.deepEqual(calls, []);
    await cli.switchTab('https://example.test/one');
    assert.equal(cli.explicitTabSelected, true);
    assert.equal(cli.currentPageId, 1);
    cli.listPages = async () => [{pageId: 1, url: 'https://example.test/duplicate'}, {pageId: 2, url: 'https://example.test/duplicate'}];
    await assert.rejects(cli.switchTab('https://example.test/duplicate'), /Multiple tabs/);
    assert.equal(calls.length, 1);
});
test('failed navigation in an existing browser never retries on another tab', async () => {
    const {cli} = existingCli();
    cli.explicitTabSelected = true;
    cli.currentPageId = 1;
    cli.ensureSelectedPageContext = async () => {};
    cli.requireTool = () => 'navigate_page';
    let calls = 0;
    cli.callTool = async () => { calls++; throw new Error('navigation failed'); };
    await assert.rejects(cli.openPage('https://example.test/next'), /navigation failed/);
    assert.equal(calls, 1);
    assert.equal(cli.currentPageId, 1);
});

test('new tab in an existing browser requires a fresh explicit selection', async () => {
    const {cli} = existingCli();
    cli.explicitTabSelected = true;
    cli.currentPageId = 1;
    cli.requireTool = () => 'new_page';
    const calls = [];
    cli.callTool = async (name, args) => { calls.push({name, args}); };
    cli.autoSelectPageContext = () => assert.fail('must not auto-select');
    await cli.openNewTab('https://example.test/new');
    assert.equal(cli.explicitTabSelected, false);
    assert.equal(cli.currentPageId, null);
    assert.deepEqual(calls, [{name: 'new_page', args: {url: 'https://example.test/new'}}]);
    await assert.rejects(cli.executeAction({type: 'title'}), /explicitly selected tab/);
});
test('failed tab selection does not read diagnostics from an unselected page', async () => {
    const {cli} = existingCli();
    cli.enrichError = () => assert.fail('must not inspect another page');
    await assert.rejects(cli.executeAction({type: 'switch-tab', target: 'current'}), /exact URL or ID/);
});

for (const [status, body, expected] of [
    [200, {webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/browser/test'}, 'http'],
    [404, '', 'approval'],
    [200, {}, 'autoConnect'],
]) {
    test(`existing mode discovers ${expected} without starting Chrome`, async () => {
        const http = require('node:http');
        const {prepareRuntime} = require('../scripts/chrome-devtools-runner');
        const server = http.createServer((req, res) => { res.writeHead(status); res.end(JSON.stringify(body)); });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const port = server.address().port;
            const runtime = await prepareRuntime(parseArgs(['--existing', '--cdp-port', String(port), 'list tabs']));
            if (expected === 'http') {
                assert.equal(runtime.browserUrl, `http://127.0.0.1:${port}`);
                assert.match(runtime.serverCommand, /--browserUrl/);
                assert.doesNotMatch(runtime.serverCommand, /--autoConnect|--wsEndpoint/);
            } else if (expected === 'approval') {
                assert.equal(runtime.wsEndpoint, `ws://127.0.0.1:${port}/devtools/browser`);
                assert.match(runtime.serverCommand, /--wsEndpoint/);
                assert.doesNotMatch(runtime.serverCommand, /--autoConnect|--browserUrl/);
            } else {
                assert.match(runtime.serverCommand, /--autoConnect/);
            }
            assert.equal(runtime.ensureCdp, false);
        } finally { await new Promise(resolve => server.close(resolve)); }
    });
}
test('explicit websocket bypasses detection and conflicting launch modes fail', async () => {
    const {prepareRuntime} = require('../scripts/chrome-devtools-runner');
    const endpoint = 'ws://127.0.0.1:9222/devtools/browser';
    const runtime = await prepareRuntime(parseArgs(['--ws-endpoint', endpoint, 'list tabs']));
    assert.equal(runtime.browserMode, 'existing');
    assert.match(runtime.serverCommand, /--wsEndpoint/);
    assert.doesNotMatch(runtime.serverCommand, /--autoConnect|--browserUrl/);
    for (const flags of [['--isolated'], ['--ensure-cdp'], ['--browser-url', 'http://localhost:9222'], ['--server-command', 'mock']]) {
        assert.throws(() => parseArgs(['--ws-endpoint', endpoint, ...flags]));
    }
    assert.throws(() => parseArgs(['--ws-endpoint', 'https://example.test']));
});
