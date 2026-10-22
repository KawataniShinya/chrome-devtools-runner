const test = require('node:test');
const assert = require('node:assert/strict');
const {ChromeMcpCli} = require('../scripts/chrome-devtools-runner');

test('successful click with dialog stops before following read, without retry or snapshot', async () => {
 const cli = new ChromeMcpCli({tools:[{name:'click'}]});
 cli.ensureSelectedPageContext = async () => {};
 cli.resolveSnapshotTarget = async () => ({uid:'1',description:'button Confirm'});
 let clicks=0;
 cli.callTool = async () => { clicks++; return {structuredContent:{dialog:{type:'confirm'}}}; };
 cli.refreshSnapshot = () => { throw new Error('must not snapshot'); };
 await cli.executeInstruction('click Confirm then read page');
 assert.equal(clicks,1);
 assert.equal(cli.results.length,1);
 assert.equal(cli.results[0].status,'awaiting-dialog');
});

test('snapshot dialog race retains successful click; unrelated errors still fail', async () => {
 for (const [message, expected] of [['# Open dialog\nconfirm: Continue?', 'awaiting-dialog'], ['snapshot transport failed','failed']]) {
  const cli = new ChromeMcpCli({tools:[{name:'click'}]});
  cli.ensureSelectedPageContext=async()=>{};
  cli.resolveSnapshotTarget=async()=>({uid:'1',description:'Confirm'});
  cli.callTool=async()=>({});
  cli.refreshSnapshot=async()=>{throw new Error(message);};
  cli.enrichError=async(a,e)=>e;
  await cli.executeInstruction('click Confirm').catch(()=>{});
  assert.equal(cli.results[0].status,expected);
 }
});

test('dialog response in the same session clears pending state without clicking again', async () => {
 const cli=new ChromeMcpCli({tools:[{name:'handle_dialog'}]});
 cli.pendingDialog=true;
 let calls=0;
 cli.callTool=async(name,args)=>{calls++;assert.equal(name,'handle_dialog');assert.equal(args.action,'dismiss');};
 await cli.executeInstruction('dismiss dialog');
 assert.equal(calls,1);
 assert.equal(cli.pendingDialog,false);
 assert.equal(cli.results[0].status,'succeeded');
});
