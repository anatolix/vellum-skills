import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NoticeTransport,noticeFrame} from '../scripts/notice-transport.js';
import {publishShimUI} from '../scripts/shim-ui-transport.js';
const key='c30f1bbd-01ea-4b21-915f-c6a507b075e8',reply='01a10c67-02f8-74e9-9d78-7e7fd658e2d5';
const chunk=JSON.stringify({choices:[{delta:{content:'answer'},finish_reason:null}]});
const usage={prompt_tokens:100,completion_tokens:5,prompt_tokens_details:{cached_tokens:70}};
const req=(extra={},headers={})=>new Request('http://localhost/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({model:'test',prompt_cache_key:key,_vellum:{version:3,reply_id:reply},messages:[{role:'user',content:'hello'}],...extra})});
const stream=text=>new Response(text,{headers:{'content-type':'text/event-stream'}});
test('UI metadata never enters stream; late warnings, usage and complete bound to exact reply',async()=>{
 const events=[];let calls=0;const transport=new NoticeTransport({source:'codex-shim',publish:async m=>events.push(m)});
 transport.queue(key,'queued');
 const response=await transport.fetch(req(),async()=>{calls++;return stream(noticeFrame('first')+`data: ${chunk}\n\n`+noticeFrame('late')+`data: ${JSON.stringify({choices:[],usage})}\n\ndata: [DONE]\n\n`);});
 const out=await response.text();assert.equal(calls,1);assert(!out.includes('shim_notice'));assert(!out.includes('__shim_notice__'));assert(!out.includes('late'));assert(out.includes('answer'));
 assert.deepEqual(events.map(e=>e.detail.kind),['notice','notice','notice','usage','complete']);
 assert(events.every(e=>e.conversationId===key&&e.detail.replyId===reply&&e.detail.source==='codex-shim'));assert.deepEqual(events[3].detail.usage,usage);
});
test('metadata exclusions: background, router, compact, dryrun, absent reply',async()=>{
 for(const [extra,headers] of [[{prompt_cache_key:'router-oneuse-test'},{}],[{}, {'x-call-site':'select_pages'}],[{}, {'x-shim-operation':'compact'}],[{messages:[{role:'user',content:'<compaction_instructions>summary'}]},{}],[{}, {'x-shim-dry-run':'1'}],[{_vellum:undefined},{}]]){
 const events=[];const t=new NoticeTransport({publish:async m=>events.push(m)});const out=await (await t.fetch(req(extra,headers),async()=>stream(noticeFrame('private')+`data: ${chunk}\n\ndata: [DONE]\n\n`))).text();assert.equal(events.length,0);assert(!out.includes('private'));assert(out.includes('answer'));
 }
});
test('IPC failure never falls back into model text; missing usage complete still emitted',async()=>{
 const events=[];const t=new NoticeTransport({publish:async m=>{events.push(m);throw new Error('down');}});
 const out=await(await t.fetch(req(),async()=>stream(noticeFrame('warning')+`data: ${chunk}\n\ndata: [DONE]\n\n`))).text();assert(out.includes('answer'));assert(!out.includes('warning'));assert.equal(events.at(-1).detail.kind,'complete');
});
test('HTTP and streamed errors stay errors, not assistant warnings',async()=>{
 const t=new NoticeTransport({publish:async()=>true});const r=await t.fetch(req(),async()=>Response.json({error:{message:'invalid'}},{status:400}));assert.equal(r.status,400);
 const out=await(await t.fetch(req(),async()=>stream('data: {"error":{"message":"failed"}}\n\ndata: [DONE]\n\n'))).text();assert(out.includes('"error"'));assert(!out.includes('"content"'));
});
test('framed authenticated local IPC envelope and non-fatal timeout',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'shim-ui-'));const path=join(dir,'socket');let received;
 const server=createServer(socket=>{let bytes=Buffer.alloc(0);socket.on('data',c=>{bytes=Buffer.concat([bytes,c]);if(bytes.length<4||bytes.length<4+bytes.readUInt32BE(0))return;received=JSON.parse(bytes.subarray(4));const data=Buffer.from(JSON.stringify({id:received.id,result:{ok:true}}));const h=Buffer.alloc(4);h.writeUInt32BE(data.length);socket.end(Buffer.concat([h,data]));});});
 await new Promise(r=>server.listen(path,r));
 try{assert.equal(await publishShimUI({type:'hook_event',conversationId:key,hookName:'shim-ui',owner:{kind:'plugin',id:'shim-ui-transport'},detail:{kind:'complete',replyId:reply,source:'claude-shim'}},{socketPath:path}),true);assert.equal(received.method,'/events/publish');assert.equal(received.params.body.event.message.detail.replyId,reply);assert.equal(await publishShimUI({}, {socketPath:join(dir,'missing'),timeoutMs:50}),false);}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
