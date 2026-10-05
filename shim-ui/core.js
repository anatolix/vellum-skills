import { createHash, randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PENDING = 512;
const TTL_MS = 15 * 60_000;
const OWNER = 'shim-ui-transport';
export const validUUID = value => typeof value === 'string' && UUID.test(value);
export const bindingKey = (conversationId, replyId) => `${conversationId}\0${replyId}`;
const mdLiteral = value => String(value).replace(/[\\`*_{}\[\]()#+\-.!|>~]/g, '\\$&');
const fmt = n => !Number.isSafeInteger(n) || n < 0 ? '—' : n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}m` : n >= 1_000 ? `${(n/1_000).toFixed(1)}k` : String(n);

export function tokenLine(usage) {
  const d = usage?.prompt_tokens_details || {};
  const prompt = usage?.prompt_tokens;
  const cached = d.cached_tokens;
  const write = d.cache_write_tokens;
  const out = usage?.completion_tokens;
  const uncached = Number.isSafeInteger(prompt) && prompt >= 0 && Number.isSafeInteger(cached) && cached >= 0
    ? Math.max(0, prompt - cached - (Number.isSafeInteger(write) && write >= 0 ? write : 0)) : null;
  return `Cached ${fmt(cached)} · Uncached ${fmt(uncached)} · Out ${fmt(out)}${write > 0 ? ` · Write ${fmt(write)}` : ''}`;
}
function cardData(body) { return { body }; }
const surfaceId = (replyId, kind, discriminator='') => `shim-ui:${replyId}:${kind}:${createHash('sha256').update(discriminator).digest('hex').slice(0,12)}`;

export function createManager({ getMessages, getMessageById, publish, logger=console, now=Date.now }) {
  const pending = new Map();
  const applied = new Set();
  function prune() {
    const cutoff=now()-TTL_MS;
    for (const [k,v] of pending) if (v.updated < cutoff) pending.delete(k);
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
    while (applied.size > MAX_PENDING*4) applied.delete(applied.values().next().value);
  }
  const safePublish = async message => { try { await publish(message); } catch (e) { logger.warn?.({err:String(e)}, 'shim-ui event publish failed (non-fatal)'); } };
  function normalize(event) {
    if (!event || event.type !== 'hook_event' || event.hookName !== 'shim-ui' || event.owner?.kind !== 'plugin' || event.owner?.id !== OWNER) return null;
    const d=event.detail;
    if (!validUUID(event.conversationId) || !d || !validUUID(d.replyId) || !['claude-shim','codex-shim'].includes(d.source) || !['notice','usage','complete'].includes(d.kind)) return null;
    return { conversationId:event.conversationId, replyId:d.replyId, source:d.source, kind:d.kind, text:typeof d.text==='string'?d.text:undefined, usage:d.usage, model:typeof d.model==='string'?d.model:undefined };
  }
  async function consume(envelope) {
    prune();
    const event=envelope?.message ?? envelope;
    const e=normalize(event); if (!e) return false;
    const key=bindingKey(e.conversationId,e.replyId);
    if (applied.has(key)) return false;
    if (getMessageById) {
      const row=await getMessageById(e.replyId);
      if (!row || row.conversationId!==e.conversationId || row.role!=='assistant' || row.finalized) return false;
    }
    let item=pending.get(key);
    if (!item) { item={conversationId:e.conversationId,replyId:e.replyId,source:e.source,notices:new Map(),usage:null,complete:false,updated:now()}; pending.set(key,item); }
    item.updated=now(); item.source=e.source;
    if (e.kind==='notice' && e.text) {
      const id=surfaceId(e.replyId,'notice',e.source+'\0'+e.text);
      if (!item.notices.has(id)) {
        const body=`🔴 ${mdLiteral(e.text)}`;
        item.notices.set(id,{id,body});
        await show(item,id,'card',cardData(body));
      }
    } else if (e.kind==='usage') {
      const signature=JSON.stringify(e.usage ?? null);
      if (signature !== item.usageSignature) {
        item.usage=e.usage ?? null;
        item.usageSignature=signature;
        await show(item,surfaceId(e.replyId,'usage'), 'card',cardData(tokenLine(item.usage)));
      }
    } else if (e.kind==='complete') {
      if (!item.complete) {
        item.complete=true;
        if (!item.usage) await show(item,surfaceId(e.replyId,'usage'),'card',cardData(tokenLine(null)));
      }
    }
    return true;
  }
  async function show(item,id,surfaceType,data) {
    await safePublish({type:'ui_surface_show',conversationId:item.conversationId,surfaceId:id,surfaceType,title:undefined,data,messageId:item.replyId});
  }
  async function postModelCall(ctx) {
    try {
      if (ctx.error || !validUUID(ctx.conversationId)) return;
      prune();
      const rows=await getMessages(ctx.conversationId);
      const row=[...rows].reverse().find(r=>r.role==='assistant' && !r.finalized);
      if (!row) return;
      const key=bindingKey(ctx.conversationId,row.id), item=pending.get(key);
      if (!item) return;
      if (applied.has(key)) return;
      const add=[];
      for (const n of item.notices.values()) add.push({type:'ui_surface',surfaceId:n.id,surfaceType:'card',data:cardData(n.body)});
      if (item.usage || item.complete) add.push({type:'ui_surface',surfaceId:surfaceId(item.replyId,'usage'),surfaceType:'card',data:cardData(tokenLine(item.usage))});
      if (!add.length) return;
      const existing=new Set((ctx.content||[]).filter(b=>b?.type==='ui_surface').map(b=>b.surfaceId));
      for (const block of add) if (!existing.has(block.surfaceId)) ctx.content.push(block);
      applied.add(key);
      pending.delete(key);
    } catch (e) { logger.warn?.({err:String(e)}, 'shim-ui post-model-call failed open'); }
  }
  return { consume, postModelCall, dispose(){pending.clear();applied.clear();}, get pendingSize(){return pending.size;} };
}
