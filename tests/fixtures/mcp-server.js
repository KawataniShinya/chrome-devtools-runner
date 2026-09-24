// Minimal stdio MCP fixture: deliberately echoes inputs through every output channel.
const readline=require('node:readline');
let value='';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.id===undefined)return;
 let result={};
 if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'fixture',version:'1'}};
 if(message.method==='tools/list')result={tools:['type_text','evaluate_script','take_snapshot'].map(name=>({name,inputSchema:{type:'object',properties:{}}}))};
 if(message.method==='tools/call'){
  if(message.params.name==='type_text'){value=message.params.arguments.text;process.stderr.write(value);}
  const text=message.params.name==='evaluate_script'?JSON.stringify({url:'https://fixture.invalid/',title:'Fixture',text:value}):value;
  result=process.argv.includes('--fail') && message.params.name==='evaluate_script' ? {isError:true,content:[{type:'text',text:value}]} : {content:[{type:'text',text}]};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
});
