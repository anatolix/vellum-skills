import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';

// The real server is loaded, but the SDK is entirely fake: this test never calls a model.
const temp=mkdtempSync(join(tmpdir(),'claude-notice-test-'));
const socketPath=join(temp,'ui.sock');
const ipcEvents=[];
const ipc=createServer(sock=>{let buf=Buffer.alloc(0);sock.on('data',chunk=>{buf=Buffer.concat([buf,chunk]);if(buf.length<4)return;const n=buf.readUInt32BE(0);if(buf.length<n+4)return;const req=JSON.parse(buf.subarray(4,4+n));ipcEvents.push(req.params.body.event.message);const out=Buffer.from(JSON.stringify({id:req.id,result:{}}));const h=Buffer.alloc(4);h.writeUInt32BE(out.length);sock.end(Buffer.concat([h,out]));});});
await new Promise(resolve=>ipc.listen(socketPath,resolve));
const listener=Bun.listen({hostname:'127.0.0.1',port:0,socket:{data(){}}});const port=listener.port;listener.stop(true);
process.env.SHIM_PORT=String(port);process.env.SHIM_SESSIONS_DIR=temp;process.env.SHIM_TOOL_MODE='mcp';process.env.SHIM_MAX_LIVE='1';process.env.SHIM_UI_SOCKET=socketPath;
let queries=0;const options=[];
mock.module('@anthropic-ai/claude-agent-sdk',()=>({createSdkMcpServer:()=>({}),tool:(name,description,schema,handler)=>({name,handler}),query:({prompt,options:opts})=>{const n=++queries;options.push(opts);let closed=false;const stream=(async function*(){yield{type:'system',subtype:'init',session_id:opts.resume||'sess-'+n};for await(const msg of prompt){if(closed)break;yield{type:'stream_event',event:{type:'message_start',message:{usage:{input_tokens:8,cache_read_input_tokens:3,cache_creation_input_tokens:1}}}};yield{type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'normal answer'}}};yield{type:'stream_event',event:{type:'message_delta',usage:{output_tokens:2}}};if(JSON.stringify(msg.message.content).includes('with-tool')) {yield {type:'assistant',uuid:randomUUID(),message:{content:[{type:'tool_use',id:'toolu_fake',name:'mcp__vellum__echo',input:{text:'test'}}],usage:{input_tokens:8,cache_read_input_tokens:3,cache_creation_input_tokens:1,output_tokens:2}}};yield {type:'stream_event',event:{type:'message_stop'}};continue;}yield{type:'result',subtype:'success',session_id:opts.resume||'sess-'+n,usage:{input_tokens:99,output_tokens:99}};}})();return Object.assign(stream,{close(){closed=true;},async setModel(){},async setMcpServers(){return{};},async applyFlagSettings(){}});}}));
await import('../scripts/server-v3.js');
const tools=[{type:'function',function:{name:'echo',parameters:{type:'object',properties:{text:{type:'string'}}}}}];
const uuid=()=>randomUUID();const user=t=>({role:'user',content:t});
const make=(messages,key=uuid())=>({model:'claude-sonnet',prompt_cache_key:key,_vellum:{version:3,reply_id:uuid()},tools,messages});
async function run(body){const r=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return await r.text();}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const key=uuid();let response=await run(make([user('hello')],key));await sleep(20);
 assert.match(response,/normal answer/);assert(!response.includes('__shim_notice__'));assert.equal(queries,1);
 assert(ipcEvents.some(e=>e.hookName==='shim-ui'&&e.detail.kind==='notice'&&/Старт/.test(e.detail.text)),'fresh-session notice must use UI IPC');
 assert(ipcEvents.some(e=>e.detail.kind==='usage'&&e.detail.usage?.prompt_tokens===12&&e.detail.usage?.completion_tokens===2),'per-step usage must win over aggregate result usage');
 assert(ipcEvents.some(e=>e.detail.kind==='complete'));
 const before=ipcEvents.filter(e=>e.detail.kind==='notice').length;
 response=await run(make([user('hello'),{role:'assistant',content:'normal answer'},user('second')],key));await sleep(20);
 assert.match(response,/normal answer/);assert.equal(queries,1,'chat should resume the same CLI');assert.equal(ipcEvents.filter(e=>e.detail.kind==='notice'&&/Старт|завершён/.test(e.detail.text)).length,1,'normal continuation has no additional lifecycle notice');
 const freshHistory=make(Array.from({length:2},(_,i)=>user('history-'+i)));
 await run(freshHistory);await sleep(20);assert(ipcEvents.some(e=>e.detail.kind==='notice'&&/Восстановлена история/.test(e.detail.text)),'fresh multi-block restore emits notice');
 const threshold=make(Array.from({length:9},(_,i)=>user('threshold-'+i)));
 await run(threshold);await sleep(20);assert(ipcEvents.some(e=>e.detail.kind==='notice'&&/Большой контекст/.test(e.detail.text)),'history re-feed threshold warns');
 const oneuse=make([user('internal oneuse')],'router-oneuse-'+uuid());
 const count=ipcEvents.length;await run(oneuse);await sleep(20);assert.equal(ipcEvents.length,count,'oneuse does not publish any UI event');
 const prior=ipcEvents.length;const toolResponse=await run(make([user('with-tool')]));assert(toolResponse.includes('tool_calls')&&toolResponse.includes('toolu_fake'));const toolEvents=ipcEvents.slice(prior);assert(toolEvents.some(e=>e.detail.kind==='usage'&&e.detail.usage?.completion_tokens===2));assert(toolEvents.at(-1).detail.kind==='complete');assert(!toolResponse.includes('__shim_notice__'));
 console.log('PASS: fake-SDK lifecycle exercised; IPC notice/usage/complete collected; no model calls; no notice tool rounds');
}finally{ipc.close();}
process.exit(0);
