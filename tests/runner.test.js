const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {ChromeMcpCli, McpStdioClient, rememberInput, redactOutput} = require('../scripts/chrome-devtools-runner');
const runner = path.resolve(__dirname, '../scripts/chrome-devtools-runner.js');
const parse = text => new ChromeMcpCli({tools: []}).parseInstruction(text);

for (const value of ['bread and butter', '東京、大阪', 'first then second', 'line1\nline2']) {
    test(`quoted input survives command splitting: ${JSON.stringify(value)}`, () => {
        assert.deepEqual(parse(`type "Login ID" "${value}" then expect text タイトル`), [
            {type: 'type', selector: 'Login ID', text: value},
            {type: 'expect-text', value: 'タイトル'},
        ]);
    });
}
test('escaped quotes and backslashes survive', () => {
    assert.equal(parse(String.raw`type #memo "say \"yes and no\" C:\\tmp"`)[0].text, 'say "yes and no" C:\\tmp');
});
test('English commands take precedence over Japanese suffixes', () => {
    assert.deepEqual(parse('expect text 押して'), [{type: 'expect-text', value: '押して'}]);
    assert.deepEqual(parse('type #memo クリック'), [{type: 'type', selector: '#memo', text: 'クリック'}]);
    assert.deepEqual(parse('submit form #target'), [{type: 'submit', target: '#target'}]);
});
test('legacy Japanese commands and quoted active input work', () => {
    assert.deepEqual(parse('タイトルを教えて、画面を確認して'), [{type:'title'}, {type:'read-page'}]);
    assert.deepEqual(parse('type "hello and goodbye"'), [{type:'type-active', text:'hello and goodbye'}]);
});
test('malformed instructions fail without echoing input', () => {
    for (const value of ['type #x "DUMMY_PRIVATE', 'type #x [DUMMY_PRIVATE', 'unknown DUMMY_PRIVATE']) {
        assert.throws(() => parse(value), e => !e.message.includes('DUMMY_PRIVATE'));
    }
});

function domRunner(document) {
    const cli = new ChromeMcpCli({tools: [{name:'evaluate_script',inputSchema:{}}]});
    cli.callTool = async (name, args) => ({structuredContent: vm.runInNewContext(`(${args.function})()`, {
        document, location:{href:'https://fixture.invalid/'}, Event:class {}, InputEvent:class {},
    })});
    return cli;
}
function button(onClick) {
    return {tagName:'BUTTON',textContent:'保存',click:onClick,getAttribute:()=>null,getClientRects:()=>[{}]};
}
for (const css of [true, false]) {
    test(`duplicate ${css ? 'CSS' : 'label'} matches do not click`, async () => {
        let clicks = 0;
        const buttons = [button(()=>clicks++),button(()=>clicks++)];
        const cli = domRunner({querySelectorAll: selector => css || selector.includes('button,') ? buttons : []});
        await assert.rejects(cli.clickSelectorWithDom(css ? '.save' : '保存'), /Ambiguous/);
        assert.equal(clicks,0);
    });
}
test('unique visible target clicks once; disabled/hidden target never clicks', async () => {
    let clicks = 0;
    const target=button(()=>clicks++);
    const cli=domRunner({querySelectorAll:()=>[target]});
    await cli.clickSelectorWithDom('#save');
    assert.equal(clicks,1);
    target.disabled=true;
    await assert.rejects(cli.clickSelectorWithDom('#save'), /disabled/);
    target.disabled=false;target.getClientRects=()=>[];
    await assert.rejects(cli.clickSelectorWithDom('#save'), /visible/);
    assert.equal(clicks,1);
});
test('snapshot ambiguity fails before DOM fallback', async () => {
    const cli = new ChromeMcpCli({tools:[{name:'take_snapshot'}]});
    cli.getSnapshot=async()=>({elements:['1','2'].map(uid=>({uid,role:'button',name:'保存',quotedTexts:['保存'],normalizedLine:'button 保存'}))});
    cli.clickSelectorWithDom=async()=>assert.fail('must not fall back');
    await assert.rejects(cli.clickSelector('保存'), /multiple elements/);
    assert.equal((await cli.resolveSnapshotTarget('uid=1',{mode:'click'})).uid,'1');
    await assert.rejects(cli.resolveSnapshotTarget('uid=unknown',{mode:'click'}),/UID not found/);
});
test('duplicate input selector never focuses or clears input', async () => {
    let focused=0;
    const target={value:'keep',focus:()=>focused++};
    const cli=domRunner({querySelectorAll:()=>[target,target]});
    await assert.rejects(cli.typeIntoSelectorWithDom('.field','dummy'),/exactly one/);
    assert.equal(focused,0);assert.equal(target.value,'keep');
});
for (const mode of ['missing','duplicate','outside','invalid','current-multiple','invalid-form']) {
    test(`form ${mode} does not submit another form`, async () => {
        let submissions=0;
        const form={tagName:'FORM',action:'/',checkValidity:()=>mode!=='invalid-form',requestSubmit:()=>submissions++};
        const document={activeElement:null,querySelectorAll:selector=>{
            if(selector==='form') return mode==='current-multiple'?[form,form]:[form];
            if(mode==='invalid') throw new Error('Invalid selector');
            return mode==='missing'?[]:mode==='duplicate'?[form,form]:mode==='outside'?[{tagName:'DIV',closest:()=>null}]:[form];
        }};
        await assert.rejects(domRunner(document).submitForm(mode==='current-multiple'?'current':'#target'));
        assert.equal(submissions,0);
    });
}
test('explicit and focused form submit exactly once each', async () => {
    let submissions=0;
    const form={tagName:'FORM',action:'/',checkValidity:()=>true,requestSubmit:()=>submissions++};
    const cli=domRunner({activeElement:{closest:()=>form},querySelectorAll:()=>[form]});
    await cli.submitForm('#target');await cli.submitForm();
    assert.equal(submissions,2);
});
test('input summaries hide values for Japanese, UID and active targets', async () => {
    const cli=new ChromeMcpCli({tools:[{name:'fill'},{name:'type_text'}]});
    cli.resolveSnapshotTarget=async()=>({uid:'1',description:'textbox'});
    cli.callTool=async()=>({});cli.refreshSnapshot=async()=>({});
    for(const selector of ['パスワード','uid=1','Email']) {
        assert.match(await cli.typeIntoSelector(selector,'PRIVATE_TEST_VALUE'),/REDACTED/);
    }
    assert.match(await cli.typeIntoActiveElement('PRIVATE_TEST_VALUE'),/REDACTED/);
    assert.equal(redactOutput('echo PRIVATE_TEST_VALUE'),'echo [REDACTED]');
});
test('MCP debug output never dumps request or response payloads', () => {
    const output=[]; const original=console.error;
    console.error=(...args)=>output.push(args.join(' '));
    try {
        const client=new McpStdioClient({debug:true});
        client.child={stdin:{write:()=>{}}};
        client.writeMessage({id:1,method:'tools/call',params:{name:'fill',arguments:{value:'UNREGISTERED_SECRET'}}});
        client.handleMessage({id:99,result:{content:[{type:'text',text:'UNREGISTERED_SECRET'}]}});
    } finally {console.error=original;}
    assert.ok(output.length>0);
    assert.ok(!output.join('\n').includes('UNREGISTERED_SECRET'));
});
for (const failure of [false,true]) {
    test(`CLI stdin and debug redact echoed inputs on ${failure?'failure':'success'}`, () => {
        const secret='CLI_PRIVATE_92x';
        const instruction=`type "${secret}"${failure?' then expect text missing':' then read page'}`;
        const fakeServer=path.resolve(__dirname,'fixtures/mcp-server.js');
        const result=spawnSync(process.execPath,[runner,'--debug','--stdin','--server-command',`"${process.execPath}" "${fakeServer}"${failure?" --fail":""}`],{input:instruction,encoding:'utf8',timeout:15000});
        assert.equal(result.status,failure?1:0,result.stderr);
        assert.ok(!(result.stdout+result.stderr).includes(secret));
        assert.match(result.stdout+result.stderr,/REDACTED/);
    });
}

test('disabled or read-only DOM input is not changed', async () => {
    let focused=0;
    const target={value:'keep',disabled:true,focus:()=>focused++,getClientRects:()=>[{}]};
    const cli=domRunner({querySelectorAll:()=>[target]});
    await assert.rejects(cli.typeIntoSelectorWithDom('#field','next'),/disabled/);
    target.disabled=false;target.readOnly=true;
    await assert.rejects(cli.typeIntoSelectorWithDom('#field','next'),/read-only/);
    assert.equal(focused,0);assert.equal(target.value,'keep');
});
test('page preview masks long inputs before truncation', async () => {
    const secret='LONG_PRIVATE_VALUE'.repeat(40);
    rememberInput(secret);
    const cli=new ChromeMcpCli({tools:[]});
    cli.getCurrentPageState=async()=>({text:secret,title:'test',url:'https://fixture.invalid/'});
    cli.refreshSnapshot=async()=>({elements:[]});
    const result=await cli.readPage();
    assert.match(result,/REDACTED/);
    assert.ok(!result.includes('long_private_value'));
});
test('invalid stdin instructions fail before starting MCP without echoing data', () => {
    const result=spawnSync(process.execPath,[runner,'--stdin','--debug','--server-command','SHOULD_NOT_RUN'],{
        input:'type #field "PRIVATE_UNFINISHED',encoding:'utf8',timeout:5000,
    });
    assert.equal(result.status,1);
    assert.ok(!result.stderr.includes('PRIVATE_UNFINISHED'));
    assert.ok(!result.stderr.includes('starting MCP'));
});
test('stdin and positional instruction cannot be combined', () => {
    const result=spawnSync(process.execPath,[runner,'--stdin','read page'],{input:'read page',encoding:'utf8',timeout:5000});
    assert.equal(result.status,1);
    assert.match(result.stderr,/either --stdin/);
});
