const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {buildServerCommand} = require('../scripts/chrome-devtools-runner');

test('manifest and lock agree on an exact MCP version and integrity', () => {
    const manifest = require('../package.json');
    const lock = require('../package-lock.json');
    const version = manifest.dependencies['chrome-devtools-mcp'];
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(lock.packages[''].dependencies['chrome-devtools-mcp'], version);
    assert.equal(lock.packages['node_modules/chrome-devtools-mcp'].version, version);
    assert.match(lock.packages['node_modules/chrome-devtools-mcp'].integrity, /^sha512-/);
});
test('explicit server override works without default dependency lookup', () => {
    assert.equal(buildServerCommand({serverCommand: 'mock-server', browserUrl: 'http://127.0.0.1:9222'}), "mock-server --browserUrl 'http://127.0.0.1:9222'");
});
for (const installedVersion of [null, '0.0.0']) {
    test(`missing or mismatched installation fails before browser startup: ${installedVersion}`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-version-'));
        try {
            fs.mkdirSync(path.join(root, 'scripts'));
            fs.copyFileSync(path.resolve(__dirname, '../scripts/chrome-devtools-runner.js'), path.join(root, 'scripts/runner.js'));
            fs.copyFileSync(path.resolve(__dirname, '../package.json'), path.join(root, 'package.json'));
            if (installedVersion) {
                const dependency = path.join(root, 'node_modules/chrome-devtools-mcp');
                fs.mkdirSync(dependency, {recursive: true});
                fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({version: installedVersion}));
            }
            const result = spawnSync(process.execPath, [path.join(root, 'scripts/runner.js'), '--ensure-cdp', 'title'], {
                encoding: 'utf8', env: {...process.env, MCP_SERVER_COMMAND: ''}, timeout: 5000,
            });
            assert.equal(result.status, 1);
            assert.match(result.stderr, /npm ci --ignore-scripts/);
            assert.doesNotMatch(result.stderr, /Starting Chrome|CDP endpoint/);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });
}

for (const hasPageId of [true, false]) {
    test(`page routing follows advertised schema: ${hasPageId}`, async () => {
        const {ChromeMcpCli} = require('../scripts/chrome-devtools-runner');
        const received = [];
        const cli = new ChromeMcpCli({
            tools: [{name: 'take_snapshot', inputSchema: hasPageId
                ? {properties: {pageId: {type: 'number'}}, required: ['pageId']}
                : {properties: {}}}],
            callTool: async (name, args) => { received.push(args); return {}; },
        });
        if (hasPageId) {
            await assert.rejects(cli.callTool('take_snapshot'), /No selected page/);
            assert.equal(received.length, 0);
        }
        cli.currentPageId = 7;
        await cli.callTool('take_snapshot');
        assert.deepEqual(received[0], hasPageId ? {pageId: 7} : {});
        await cli.callTool('take_snapshot', {pageId: 8});
        assert.deepEqual(received[1], {pageId: 8});
    });
}

// The skill owns its module boundary, independently of the host project.
test('runner starts inside an ESM host project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-esm-'));
    try {
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({type: 'module'}));
        const skill = path.join(root, '.codex/skills/chrome-devtools-runner');
        fs.mkdirSync(path.join(skill, 'scripts'), {recursive: true});
        fs.copyFileSync(path.resolve(__dirname, '../package.json'), path.join(skill, 'package.json'));
        fs.copyFileSync(path.resolve(__dirname, '../scripts/chrome-devtools-runner.js'), path.join(skill, 'scripts/chrome-devtools-runner.js'));
        const result = spawnSync(process.execPath, [
            path.join(skill, 'scripts/chrome-devtools-runner.js'),
        ], {cwd: root, encoding: 'utf8', timeout: 5000});
        // No instruction prints usage without launching Chrome or MCP.
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Usage:/i);
        assert.doesNotMatch(result.stderr, /require is not defined|MODULE_TYPELESS_PACKAGE_JSON/);
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});
