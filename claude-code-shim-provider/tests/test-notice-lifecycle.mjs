import {mock} from 'bun:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const temp=mkdtempSync(join(tmpdir(),'claude-notice-test-'));
const listener=Bun.listen({hostname:'127.0.0.1',port:0,socket:{data(){}}});const port=listener.port;listener.stop(true);
process.env.SHIM_PORT=String(port);process.env.SHIM_SESSIONS_DIR=temp;process.env.SHIM_NOTICE_FMT='tool';process.env.SHIM_TOOL_MODE='mcp';process.env.SHIM_MAX_LIVE='1';
let queries=0,inputs=[],options=[];
mock.module('@anthropic-ai/claude-agent-sdk',()=>({
 createSdkMcpServer:()=>({}),tool:(name,description,schema,handler)=>({name,handler}),
 query:({prompt,options:opts})=>{
  const n=++queries;options.push(opts);let closed=false;
  const stream=(async function*(){yield {type:'system',subtype:'init',session_id:opts.resume||'sess-'+n};
   for await(const msg of prompt){if(closed)break;inputs.push(msg.message.content);
    yield {type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'fake reasoning'}}};
    yield {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'OK'}}};
    yield {type:'result',subtype:'success',session_id:opts.resume||'sess-'+n,usage:{input_tokens:4,output_tokens:2}};
   }}());
  return Object.assign(stream,{close(){closed=true;},async setModel(){},async setMcpServers(){return{};},async applyFlagSettings(){}});
 }
}));
await import('../scripts/server-v3.js');
const tools=[{type:'function',function:{name:'echo',parameters:{type:'object',properties:{text:{type:'string'}}}}}];
const make=(key,messages)=>({model:'claude-sonnet',prompt_cache_key:key,tools,messages});
const user=t=>({role:'user',content:t});
async function run(body){let labels=[],last='',rounds=0;
 for(;rounds<10;rounds++){
  const r=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(r.status,200);last=await r.text();
  const chunks=last.split('\n').filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));
  const calls=chunks.flatMap(x=>x.choices||[]).flatMap(x=>x.delta?.tool_calls||[]);
  if(!calls.length)break;
  assert.equal(calls.length,1);assert.equal(calls[0].function.name,'__shim_notice__');assert(!last.includes('fake reasoning'));
  labels.push(JSON.parse(calls[0].function.arguments).activity);
  body.messages.push({role:'assistant',content:'---',tool_calls:calls},{role:'tool',tool_call_id:calls[0].id,content:'Unknown tool'});
 }
 assert(rounds<10);assert(last.includes('OK'));return labels;
}
try{
 const b=make('one',[user('hello')]);const labels=await run(b);
 assert(labels.some(x=>x.includes('] Старт: sonnet')&&x.includes('с нуля')));assert.equal(queries,1);assert.equal(inputs.length,1);console.log('PASS Claude fresh startup isolated');
 b.messages.push({role:'assistant',content:'OK'},user('second'));const next=await run(b);
 assert.equal(queries,1);assert.equal(inputs.length,2);assert(!inputs[1].includes('Unknown tool'));assert(!inputs[1].includes('hello'));assert(!next.some(x=>x.includes('] Старт: ')));console.log('PASS Claude continuation filters diagnostics');
 const nine=await run(make('nine',Array.from({length:9},(_,i)=>user('new-'+i))));assert(nine.some(x=>x.includes('+9 блоков')));console.log('PASS Claude >8 threshold');
 const resumed=await run({...b,messages:[...b.messages,{role:'assistant',content:'OK'},user('third')]});
 assert(resumed.some(x=>x.includes('CLI завершён')&&x.includes('evict')));assert(resumed.some(x=>x.includes('из файла')));assert(options.at(-1).resume);console.log('PASS Claude eviction + disk resume');
 const eight=await run(make('eight',Array.from({length:8},(_,i)=>user('eight-'+i))));assert(!eight.some(x=>x.includes('Большой контекст')));console.log('PASS Claude exactly 8 is not large');
 const once=await run({...make('router-oneuse-test',[user('oneuse')]),tools:[]});assert.equal(once.length,0);console.log('PASS Claude oneuse is log-only');
 console.log('6 Claude lifecycle tests passed; 0 real model calls.');process.exit(0);
}catch(e){console.error(e);process.exit(1);}
