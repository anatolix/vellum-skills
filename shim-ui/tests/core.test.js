import { test, expect } from 'bun:test';
import { createManager, bindingKey, tokenLine } from '../core.js';
const c='123e4567-e89b-42d3-a456-426614174000', r='123e4567-e89b-42d3-a456-426614174001';
const ev=(kind,detail={})=>({type:'hook_event',conversationId:c,hookName:'shim-ui',owner:{kind:'plugin',id:'shim-ui-transport'},detail:{kind,source:'claude-shim',replyId:r,...detail}});
function fixture(){const pub=[];const manager=createManager({getMessages:()=>[{id:r,role:'assistant',finalized:0}],getMessageById:()=>({id:r,conversationId:c,role:'assistant',finalized:0}),publish:async e=>pub.push(e),logger:{warn(){}}});return {manager,pub};}
test('exact event binding stages surfaces on reserved unfinalized row, preserving every content type',async()=>{
 const {manager,pub}=fixture(); const foreign={type:'text',text:'keep'}, tool={type:'tool_use',id:'x',name:'f',input:{}}, result={type:'tool_result',tool_use_id:'x',content:'ok'};
 await manager.consume(ev('notice',{text:'**warning** [x]'})); await manager.consume(ev('usage',{usage:{prompt_tokens:100,prompt_tokens_details:{cached_tokens:70,cache_write_tokens:10},completion_tokens:8}}));
 const ctx={conversationId:c,error:undefined,content:[foreign,tool,result,{type:'image',source:{type:'url',url:'x'}}]}; await manager.postModelCall(ctx);
 expect(ctx.content.slice(0,4)).toEqual([foreign,tool,result,{type:'image',source:{type:'url',url:'x'}}]);
 const surfaces=ctx.content.slice(4); expect(surfaces).toHaveLength(2); expect(surfaces.every(x=>x.type==='ui_surface')).toBe(true);
 expect(surfaces[0].data.body).toBe('🔴 \\*\\*warning\\*\\* \\[x\\]');
 expect(surfaces[1].data.body).toBe('Cached 70 · Uncached 20 · Out 8 · Write 10');
 expect(pub.some(x=>x.messageId===r)).toBe(true); expect(bindingKey(c,r)).not.toBe(bindingKey(c,'other'));
});
test('rejects foreign hook owner, mismatched source, non-UUID and absent reply id',async()=>{
 const {manager,pub}=fixture();
 for(const e of [ev('notice',{text:'no',replyId:undefined}),{...ev('notice',{text:'no'}),conversationId:'router-oneuse-aa'}, {...ev('notice',{text:'no'}),owner:{kind:'plugin',id:'other'}}, {...ev('notice',{text:'no'}),hookName:'other'},ev('notice',{text:'no',source:'other'})]) await manager.consume(e);
 const ctx={conversationId:c,content:[]}; await manager.postModelCall(ctx); expect(ctx.content).toEqual([]); expect(pub).toEqual([]);
});
test('missing token details are unknown, never fabricated zero; notice escaping is literal',async()=>{
 expect(tokenLine(null)).toBe('Cached — · Uncached — · Out —');
 const {manager,pub}=fixture(); await manager.consume(ev('notice',{text:'a_b `c` !'})); await manager.consume(ev('complete'));
 const ctx={conversationId:c,content:[{type:'text',text:'assistant'}]}; await manager.postModelCall(ctx);
 expect(ctx.content[1].data.body).toBe('🔴 a\\_b \\`c\\` \\!'); expect(ctx.content[2].data.body).toBe('Cached — · Uncached — · Out —');
 expect(pub.filter(x=>x.type==='ui_surface_show').every(x=>x.messageId===r)).toBe(true);
});
test('late usage merges prior pending notice and uses stable surface IDs',async()=>{
 const {manager,pub}=fixture(); await manager.consume(ev('notice',{text:'warning'})); await manager.consume(ev('usage',{usage:{prompt_tokens:9,prompt_tokens_details:{cached_tokens:4},completion_tokens:2}}));
 const shows=pub.filter(x=>x.type==='ui_surface_show'); expect(shows).toHaveLength(2); expect(shows[0].surfaceId).not.toBe(shows[1].surfaceId); expect(manager.pendingSize).toBe(1);
 const ctx={conversationId:c,content:[]}; await manager.postModelCall(ctx); expect(ctx.content).toHaveLength(2);
});
test('each row surface only once and all common content block types remain intact',async()=>{
 const {manager}=fixture(); await manager.consume(ev('notice',{text:'warning'}));
 const blocks=['text','thinking','tool_use','tool_result','image','document','ui_surface'].map((type,i)=>({type,surfaceId:type==='ui_surface'?'foreign':undefined,i}));
 const ctx={conversationId:c,content:blocks}; await manager.postModelCall(ctx); expect(ctx.content.slice(0,blocks.length)).toEqual(blocks); await manager.postModelCall(ctx); expect(ctx.content.filter(x=>x.type==='ui_surface')).toHaveLength(2);
});

test('foreign or finalized reply rows are rejected before any UI broadcast',async()=>{
 for(const row of [null,{id:r,conversationId:'other',role:'assistant',finalized:0},{id:r,conversationId:c,role:'assistant',finalized:1}]){
  const published=[];const manager=createManager({getMessages:()=>[],getMessageById:()=>row,publish:async e=>published.push(e)});
  expect(await manager.consume(ev('notice',{text:'foreign'}))).toBe(false);expect(published).toEqual([]);
 }
});
