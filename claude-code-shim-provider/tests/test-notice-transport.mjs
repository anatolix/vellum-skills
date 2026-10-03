import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NoticeTransport,noticeFrame,NOTICE_TOOL,cleanNotices} from '../scripts/notice-transport.js';
const body={model:'test',prompt_cache_key:'chat-1',tools:[{type:'function',function:{name:'bash'}}],messages:[{role:'user',content:'Hello'}]};
const req=b=>new Request('http://localhost/v1/chat/completions',{method:'POST',body:JSON.stringify(b),headers:{'content-type':'application/json'}});
const chunk=delta=>`data: ${JSON.stringify({choices:[{index:0,delta}]})}\n\n`;
const frames=s=>s.split('\n\n').filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));
const tc=s=>frames(s).flatMap(x=>x.choices||[]).flatMap(x=>x.delta?.tool_calls||[])[0];
function ack(b,t){return {...b,messages:[...b.messages,{role:'assistant',content:'---',tool_calls:[t]},{role:'tool',tool_call_id:t.id,content:'Unknown tool'}]};}
test('two singleton diagnostic round trips, no model replay, no thinking in diagnostic',async()=>{
 const n=new NoticeTransport();let calls=0;
 const h=async()=>{calls++;return new Response(noticeFrame('start')+noticeFrame('large feed')+chunk({reasoning_content:'Thinking'})+chunk({content:'Answer'})+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
 const one=await(await n.fetch(req(body),h)).text();assert(!one.includes('Thinking'));const t1=tc(one);assert.equal(t1.function.name,NOTICE_TOOL);
 let b=ack(body,t1);const two=await(await n.fetch(req(b),h)).text();const t2=tc(two);assert.notEqual(t1.id,t2.id);assert(!two.includes('Thinking'));
 b=ack(b,t2);const three=await(await n.fetch(req(b),h)).text();assert(three.includes('Thinking'));assert(three.includes('Answer'));assert.equal(calls,1);assert.equal(n.pending.size,0);
 assert.deepEqual(cleanNotices(b.messages),body.messages);
});
test('retry without acknowledgement re-emits same diagnostic, no repeated inference',async()=>{
 const n=new NoticeTransport();let calls=0;const h=async()=>{calls++;return new Response(noticeFrame('start')+chunk({content:'ok'}),{headers:{'content-type':'text/event-stream'}});};
 const a=tc(await(await n.fetch(req(body),h)).text());const b=tc(await(await n.fetch(req(body),h)).text());assert.equal(a.id,b.id);assert.equal(calls,1);
 await(await n.fetch(req(ack(body,a)),h)).text();
});
test('oneuse, no tools, structured response and tool_choice none never get fake calls or prose',async()=>{
 for(const patch of [{prompt_cache_key:'router-oneuse-test'},{tools:[]},{response_format:{type:'json_object'}},{tool_choice:'none'}]){
 const n=new NoticeTransport();const s=await(await n.fetch(req({...body,...patch}),async()=>new Response(noticeFrame('notice')+chunk({content:'{"ok":true}'}),{headers:{'content-type':'text/event-stream'}}))).text();
 assert(!s.includes(NOTICE_TOOL));assert(!s.includes('notice'));assert(s.includes('ok'));
 }
});
test('late diagnostic deferred, never mixes with model thinking',async()=>{
 const n=new NoticeTransport();const h=async()=>new Response(chunk({reasoning_content:'thinking'})+noticeFrame('died')+chunk({content:'result'}),{headers:{'content-type':'text/event-stream'}});
 const s=await(await n.fetch(req(body),h)).text();assert(!s.includes('died'));assert.equal(n.later.get('chat-1')[0],'died');
 const t=tc(await(await n.fetch(req(body),h)).text());assert(t.function.arguments.includes('died'));
 await(await n.fetch(req(ack(body,t)),h)).text();
});
test('HTTP errors unchanged; real tool history preserved',async()=>{
 const n=new NoticeTransport();const r=await n.fetch(req(body),async()=>Response.json({error:'bad'},{status:400}));assert.equal(r.status,400);
 const history=[...body.messages,{role:'assistant',tool_calls:[{id:'real',function:{name:'bash'}}]},{role:'tool',tool_call_id:'real',content:'result'}];assert.deepEqual(cleanNotices(history),history);
});
test('pending reader cancelled when acknowledgement never arrives',async()=>{
 const n=new NoticeTransport({ttlMs:20});let signal;
 await(await n.fetch(req(body),async r=>{signal=r.signal;return new Response(noticeFrame('start')+chunk({content:'ok'}),{headers:{'content-type':'text/event-stream'}});})).text();
 await new Promise(r=>setTimeout(r,40));assert.equal(n.pending.size,0);assert(signal.aborted);
});
