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
 const surfaces=ctx.content.slice(4); expect(surfaces).toHaveLength(1); expect(surfaces.every(x=>x.type==='ui_surface')).toBe(true);
 expect(surfaces[0].data.body).toBe('Cached 70 · Uncached 20 · Out 8 · Write 10 · 🔴 \\*\\*warning\\*\\* \\[x\\]');
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
 expect(ctx.content[1].data.body).toBe('Cached — · Uncached — · Out — · 🔴 a\\_b \\`c\\` \\!');
 expect(pub.filter(x=>x.type==='ui_surface_show').every(x=>x.messageId===r)).toBe(true);
});
test('late usage merges prior pending notice and uses stable surface IDs',async()=>{
 const {manager,pub}=fixture(); await manager.consume(ev('notice',{text:'warning'})); await manager.consume(ev('usage',{usage:{prompt_tokens:9,prompt_tokens_details:{cached_tokens:4},completion_tokens:2}}));
 const shows=pub.filter(x=>x.type==='ui_surface_show'); expect(shows).toHaveLength(1); expect(pub[1].type).toBe('ui_surface_update'); expect(shows[0].surfaceId).toBe(pub[1].surfaceId); expect(manager.pendingSize).toBe(1);
 const ctx={conversationId:c,content:[]}; await manager.postModelCall(ctx); expect(ctx.content).toHaveLength(1);
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

test('routine notices produce no cards; genuine warnings and usage share one short summary',async()=>{
 const {manager,pub}=fixture();
 for(const text of ['Старт: gpt-6.1-sol; из файла; видено=8','Reasoning недоступен: gpt-6.1-sol; 574 токенов без summary','История загружена: 200 сообщений']) await manager.consume(ev('notice',{text}));
 expect(pub).toHaveLength(0);
 await manager.consume(ev('notice',{text:'Потеря tool call: 2'}));
 await manager.consume(ev('notice',{text:'⚠ Часть сообщений без ID: gpt-6.1-sol; без ID 1 из 17 *user1* — они сверяются по хэшу'}));
 await manager.consume(ev('usage',{usage:{prompt_tokens:100,prompt_tokens_details:{cached_tokens:80},completion_tokens:12}}));
 await manager.consume(ev('complete'));
 expect(pub.filter(e=>e.type==='ui_surface_show')).toHaveLength(1);
 const ctx={conversationId:c,content:[]}; await manager.postModelCall(ctx);
 expect(ctx.content).toHaveLength(1);
 expect(ctx.content[0].data.body).toBe('Cached 80 · Uncached 20 · Out 12 · 🔴 Потеря tool call: 2 · Без ID: 1/17');
});
test('long warnings are bounded without adding more cards',async()=>{
 const {manager,pub}=fixture(); for(let i=0;i<10;i++) await manager.consume(ev('notice',{text:String(i)+'x'.repeat(500)}));
 const ctx={conversationId:c,content:[]}; await manager.postModelCall(ctx);
 expect(ctx.content).toHaveLength(1); expect(ctx.content[0].data.body.length).toBeLessThan(250);
 expect(ctx.content[0].data.body).toContain('ещё 8'); expect(pub.filter(e=>e.type==='ui_surface_show')).toHaveLength(1);
});

test('failed compaction is NOT hidden as routine status',async()=>{const {manager,pub}=fixture();await manager.consume(ev('notice',{text:'Компакция: ошибка CLI'}));expect(pub).toHaveLength(1);expect(pub[0].data.body).toContain('ошибка CLI');expect(pub[0].data._shimWarnings).toEqual(['Компакция: ошибка CLI']);});
