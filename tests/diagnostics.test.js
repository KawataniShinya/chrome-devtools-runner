const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {ChromeMcpCli, McpStdioClient, parseArgs} = require('../scripts/chrome-devtools-runner');
const runner = path.resolve(__dirname, '../scripts/chrome-devtools-runner.js');
const fake = path.resolve(__dirname, 'fixtures/mcp-server.js');

function clientWithPage(options = {}) {
    const cli = new ChromeMcpCli({tools:['evaluate_script','take_snapshot','list_console_messages'].map(name=>({name,inputSchema:{}}))},options);
    cli.ensureSelectedPageContext=async()=>{};
    cli.getCurrentPageState=async()=>({url:'https://fixture.invalid/',title:'Original CASE',text:'Visible TEXT '.repeat(80)});
    cli.refreshSnapshot=async()=>({text:'uid=1 button "保存"',elements:Array.from({length:35},(_,i)=>({uid:String(i),role:'button',name:`Item ${i}`,line:`button Item ${i}`}))});
    cli.listConsoleErrors=async()=> 'msgid=1 [error] Failed request';
    return cli;
}
test('async error is enriched; the failed action is never retried', async () => {
    const cli=clientWithPage();
    let calls=0;
    cli.clickSelector=async()=>{calls++;throw new Error('original failure');};
    await assert.rejects(cli.executeAction({type:'click',selector:'missing'}), error=>{
        assert.equal(error.message,'original failure');
        assert.equal(error.data.action.type,'click');
        assert.equal(error.data.diagnostics.page.value.url,'https://fixture.invalid/');
        assert.match(error.data.diagnostics.console.value.text,/Failed request/);
        return true;
    });
    assert.equal(calls,1);
});
test('diagnostic failures do not hide the original error or use a cached snapshot', async () => {
    const cli=clientWithPage();
    cli.latestSnapshot={text:'stale data',elements:[]};
    cli.getCurrentPageState=async()=>{throw new Error('page disconnected');};
    cli.refreshSnapshot=async()=>{throw new Error('snapshot disconnected');};
    cli.listConsoleErrors=async()=>{throw new Error('console disconnected');};
    const error=await cli.enrichError({type:'read-page'},new Error('original'));
    assert.equal(error.message,'original');
    for(const value of Object.values(error.data.diagnostics)) assert.equal(value.status,'failed');
    assert.ok(!JSON.stringify(error.data).includes('stale data'));
    assert.equal(cli.requestTimeoutMs,undefined);
});
test('missing diagnostic tools are marked unavailable', async () => {
    const cli=new ChromeMcpCli({tools:[]});
    const error=await cli.enrichError({type:'snapshot'},new Error('missing tool'));
    assert.equal(error.data.diagnostics.snapshot.status,'unavailable');
});
test('diagnostic requests have a short timeout and restore the normal timeout', async () => {
    const timeouts=[];
    const client={tools:['evaluate_script','take_snapshot','list_console_messages'].map(name=>({name,inputSchema:{}})),callTool:async(name,args,timeout)=>{
        timeouts.push(timeout); throw new Error('timeout');
    }};
    const cli=new ChromeMcpCli(client,{diagnosticTimeoutMs:25});
    await cli.enrichError({type:'read-page'},new Error('original'));
    assert.deepEqual(timeouts,[25,25,25]);
    await assert.rejects(cli.callTool('evaluate_script'));
    assert.equal(timeouts.at(-1),undefined);
});
test('MCP client forwards request timeout', async () => {
    let observed;
    await McpStdioClient.prototype.callTool.call({sendRequest:async(method,args,timeout)=>{observed=timeout;return {}; }},'take_snapshot',{},25);
    assert.equal(observed,25);
});
test('default page output reports omissions and preserves case', async () => {
    const output=await clientWithPage().readPage();
    assert.match(output,/Original CASE/);
    assert.match(output,/Visible TEXT/);
    assert.match(output,/shown=400, omitted=640/);
    assert.match(output,/total=35, matched=35, shown=12, offset=0, omitted=23/);
    assert.ok(!output.includes('Item 34'));
});
test('full page and snapshot contain the last element', async () => {
    const cli=clientWithPage({view:{full:true}});
    assert.match(await cli.readPage(),/Item 34/);
    assert.match(await cli.snapshotSummary(),/shown=35, offset=0, omitted=0/);
});
test('filter precedes element pagination and out-of-range offsets are explicit', async () => {
    const cli=clientWithPage({view:{filter:'Item 2',offset:1,limit:2}});
    const result=await cli.snapshotSummary();
    assert.match(result,/matched=11, shown=2, offset=1, omitted=9/);
    assert.match(result,/Item 20/);
    assert.match(result,/Item 21/);
    cli.view.offset=999;
    assert.match(await cli.snapshotSummary(),/shown=0, offset=11/);
});
test('invalid ranges fail before browser activity', () => {
    for(const argv of [['--limit','0'],['--offset','-1'],['--text-limit','NaN'],['--offset','1.5'],['--filter']]) {
        assert.throws(()=>parseArgs(argv));
    }
});
test('streaming preserves completed steps and stops after failure', async () => {
    const records=[];
    const cli=clientWithPage({onResult:record=>records.push(record)});
    let reads=0;
    cli.readPage=async()=>{reads++;return 'page output';};
    await assert.rejects(cli.executeInstruction('read page then expect text MISSING then read page'));
    assert.equal(reads,1);
    assert.deepEqual(records.map(r=>r.status),['succeeded','failed']);
    assert.equal(records[0].output,'page output');
    assert.equal(records[1].step,2);
    assert.equal(records[1].total,3);
    assert.ok(records[1].durationMs>=0);
});
test('dialog action pairs use normal context and diagnostic flow', async () => {
    const records=[];
    const cli=clientWithPage({onResult:r=>records.push(r)});
    let selected=0;
    cli.ensureSelectedPageContext=async()=>{selected++;};
    cli.clickSelector=async(selector,options)=>{assert.equal(options.dialogAction,'dismiss');throw new Error('click failure');};
    await assert.rejects(cli.executeInstruction('click 保存 then dismiss dialog'));
    assert.equal(selected,1);
    assert.equal(records[0].step,1);
    assert.equal(records[0].throughStep,2);
    assert.equal(records[0].error.context.action.dialogAction,'dismiss');
});
for(const failure of [false,true]) {
    test(`CLI writes redacted ${failure?'failed':'successful'} report with preceding results`, () => {
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'runner-report-'));
        try {
            const reportPath=path.join(dir,'result.json');
            const secret='REPORT_PRIVATE_43x';
            const result=spawnSync(process.execPath,[runner,'--stdin','--output',reportPath,'--server-command',`"${process.execPath}" "${fake}"`],{
                input:`type "${secret}" then read page${failure?' then expect text MISSING then read page':''}`,encoding:'utf8',timeout:15000,
            });
            assert.equal(result.status,failure?1:0,result.stderr);
            const raw=fs.readFileSync(reportPath,'utf8');
            const report=JSON.parse(raw);
            assert.equal(report.status,failure?'failed':'succeeded');
            assert.deepEqual(report.steps.map(s=>s.status),failure?['succeeded','succeeded','failed']:['succeeded','succeeded']);
            assert.match(result.stdout,/\[1\//);
            assert.match(result.stdout,/\[2\//);
            assert.ok(!(raw+result.stdout+result.stderr).includes(secret));
            assert.equal(fs.statSync(reportPath).mode & 0o777,0o600);
        } finally {fs.rmSync(dir,{recursive:true,force:true});}
    });
}
test('existing report is not overwritten and no browser is started', () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'runner-report-'));
    try {
        const file=path.join(dir,'existing.json');fs.writeFileSync(file,'keep');
        const r=spawnSync(process.execPath,[runner,'--debug','--output',file,'--server-command','SHOULD_NOT_RUN','read page'],{encoding:'utf8',timeout:5000});
        assert.equal(r.status,1);assert.equal(fs.readFileSync(file,'utf8'),'keep');
        assert.ok(!r.stderr.includes('starting MCP'));
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('MCP diagnostics time out even when the server never responds', async () => {
    const client=new McpStdioClient({timeoutMs:1000});
    client.child={stdin:{write:()=>{}}};
    await assert.rejects(client.callTool('take_snapshot',{},10),/timed out/);
    assert.equal(client.pending.size,0);
});
