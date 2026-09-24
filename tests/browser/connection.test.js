const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {setTimeout: delay} = require('node:timers/promises');
const runner = path.resolve(__dirname, '../../scripts/chrome-devtools-runner.js');

function run(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [runner, ...args], {env: {...process.env, MCP_SERVER_COMMAND: '', CHROME_USER_DATA_DIR: '', CHROME_PATH: ''}});
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => stdout += chunk);
        child.stderr.on('data', chunk => stderr += chunk);
        child.once('error', reject);
        child.once('close', code => resolve({code, stdout, stderr}));
    });
}

test('existing CDP reconnects without navigating another tab; missing target stops safely', {timeout: 90000}, async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-connect-test-'));
    const executable = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
    const fixture = pathToFileURL(path.resolve(__dirname, '../fixtures/browser.html')).href;
    const chrome = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', fixture], {stdio: 'ignore'});
    let launchError;
    chrome.on('error', error => { launchError = error; });
    const exited = new Promise(resolve => chrome.once('close', resolve));
    try {
        let port;
        for (let i = 0; i < 100; i++) {
            if (launchError) throw launchError;
            try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; }
            catch { await delay(100); }
        }
        assert.ok(port, 'Chrome startup timed out');
        const endpoint = `http://127.0.0.1:${port}`;
        const args = ['--browser-url', endpoint];
        const success = await run([...args, `list tabs then switch tab ${fixture} then expect text タイトル then title`]);
        assert.equal(success.code, 0, success.stderr);
        assert.match(success.stdout, /mode=existing/);
        assert.match(success.stdout, /Switched to tab/);
        assert.match(success.stdout, /Runner検証/);
        const unselected = await run([...args, 'open https://example.invalid']);
        assert.equal(unselected.code, 1);
        assert.match(unselected.stderr, /explicitly selected tab/);
        const tabs = await (await fetch(`${endpoint}/json/list`)).json();
        assert.equal(tabs.filter(tab => tab.type === 'page').length, 1);
        assert.equal(tabs.find(tab => tab.type === 'page').url, fixture);
        // Closing the MCP connection must not close the externally managed Chrome.
        chrome.kill('SIGTERM');
        await exited;
        const unavailable = await run([...args, '--timeout', '3000', 'list tabs']);
        assert.equal(unavailable.code, 1);
        assert.match(unavailable.stderr, /Browser connection failed/);
        assert.match(unavailable.stderr, /--browser-url/);
        assert.match(unavailable.stderr, /No automatic fallback/);
    } finally {
        if (chrome.exitCode === null && !launchError) chrome.kill('SIGTERM');
        await exited;
        fs.rmSync(profile, {recursive: true, force: true});
    }
});


test('default Chrome survives MCP disconnect and preserves its page', {timeout: 60000}, async () => {
    const {parseArgs, prepareRuntime, McpStdioClient, ChromeMcpCli} = require('../../scripts/chrome-devtools-runner');
    const runtime = await prepareRuntime(parseArgs(['title']));
    const client = new McpStdioClient({command: runtime.serverCommand});
    try {
        assert.equal(runtime.browserMode, 'isolated');
        assert.match(runtime.serverCommand, /--browserUrl/);
        assert.doesNotMatch(runtime.serverCommand, /--isolated/);
        await client.start();
        const cli = new ChromeMcpCli(client);
        await cli.initializeSession();
        const fixture = pathToFileURL(path.resolve(__dirname, '../fixtures/browser.html')).href;
        await cli.executeInstruction(`open ${fixture} then expect title Runner検証`);
        await client.close();
        const tabs = await (await fetch(`${runtime.browserUrl}/json/list`)).json();
        assert.ok(tabs.some(tab => tab.url === fixture));
        process.kill(runtime.chromePid, 0);
    } finally {
        await client.close();
        process.kill(runtime.chromePid, 'SIGTERM');
    }
});
