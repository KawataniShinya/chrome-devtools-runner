const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {ChromeMcpCli, McpStdioClient, buildServerCommand} = require('../../scripts/chrome-devtools-runner');
const version = require('../../package.json').dependencies['chrome-devtools-mcp'];

test('pinned MCP and isolated Chrome execute safe browser flows', {timeout: 90000}, async () => {
    assert.ok(!process.env.MCP_SERVER_COMMAND, 'Unset MCP_SERVER_COMMAND for the isolated browser test');
    const client = new McpStdioClient({command: `${buildServerCommand({serverCommand: ''})} --headless --isolated --no-usage-statistics --no-performance-crux`});
    try {
        await client.start();
        assert.equal(client.serverInfo.version, version);
        const cli = new ChromeMcpCli(client);
        await cli.initializeSession();
        const url = pathToFileURL(path.resolve(__dirname, '../fixtures/browser.html')).href;
        await cli.executeInstruction(`open ${url} then expect title Runner検証 then expect text タイトル`);
        await cli.executeInstruction('type "Login ID" "bread and butter、東京" then type #password "DUMMY_PASSWORD" then submit form #target');
        assert.match(await cli.evaluateScript('() => document.querySelector("#login").value'), /bread and butter、東京/);
        await assert.rejects(cli.executeInstruction('click 保存'), /multiple|Ambiguous/);
        await assert.rejects(cli.executeInstruction('submit form #missing'));
        const counters = await cli.evaluateScript('() => [window.clicks, window.submissions, window.otherSubmissions].join(",")');
        assert.match(counters, /0,1,0/);
        await cli.executeInstruction('set viewport mobile then read viewport then snapshot then read page');
        assert.ok(cli.results.every(result => result.status === 'succeeded'));
    } finally {
        await client.close();
    }
});
