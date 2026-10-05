
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
export const summaryId = replyId => `shim-ui:${replyId}:summary`;
const noticeText = value => String(value).replace(/^\s*\[(?:codex|claude)-shim\]\s*/,'').replace(/^[🔴⚠⛔\s]+/u,'').replace(/\s+/g,' ').trim();
export function startupNotice(value, source) {
  const match=noticeText(value).match(/^Старт(?: CLI| диалога CLI)?\s*[:;]\s*(.+)$/i);
  if(!match) return null;
  return `${source==='codex-shim'?'Codex':'Claude'} CLI: ${match[1].trim()}`;
}
export function compactNotice(value) {
  const text=noticeText(value);
  const failure=/(?:ошиб|не удалось|failed|error|failure|потер)/i.test(text);
  if (!failure && /^(?:Старт(?: CLI| диалога CLI)?|Смена модели|Reasoning недоступен|Счётчик reasoning недоступен|История загружена|Восстановлена история|Компакция)(?:[:; ]|$)/i.test(text)) return null;
  const ids=text.match(/без ID (\d+) из (\d+)/i);
  if(ids) return `Без ID: ${ids[1]}/${ids[2]}`;
  return text.length>100 ? text.slice(0,99)+'…' : text;
}
export function hasTokenUsage(usage) {
  const d=usage?.prompt_tokens_details || {};
  return [usage?.prompt_tokens,d.cached_tokens,d.cache_write_tokens,usage?.completion_tokens].some(n=>Number.isSafeInteger(n) && n>=0);
}
export function summaryData(usage, warnings=[], includeUsage=true, startup=null) {
  const labels=[...new Set(warnings.map(compactNotice).filter(Boolean))];
  const parts=[], showUsage=includeUsage && hasTokenUsage(usage);
  if(showUsage && startup) parts.push(mdLiteral(startup));
  if(showUsage) parts.push(tokenLine(usage));
  if(labels.length) parts.push('🔴 '+labels.slice(0,2).map(mdLiteral).join(' · ')+(labels.length>2?` · ещё ${labels.length-2}`:''));
  return {body:parts.join(' · '), ...(showUsage&&startup?{_shimStartup:startup}:{}), ...(labels.length?{_shimWarnings:warnings.filter(w=>compactNotice(w))}:{})};
}
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
    if (!item) { item={conversationId:e.conversationId,replyId:e.replyId,source:e.source,notices:new Map(),startup:null,usage:null,complete:false,updated:now(),shown:false,shownBody:null}; pending.set(key,item); }
    item.updated=now(); item.source=e.source;
    if (e.kind==='notice' && e.text) {
      const startup=startupNotice(e.text,e.source);
      if(startup) item.startup=startup;
      else {
        const label=compactNotice(e.text);
        if(label) item.notices.set(label,e.text);
      }
    } else if (e.kind==='usage') {
      item.usage=e.usage ?? null;
    } else if (e.kind==='complete') {
      item.complete=true;
    }
    const data=summaryData(item.usage,[...item.notices.values()],Boolean(item.usage || item.complete),item.startup);
    if(data.body && data.body !== item.shownBody) {
      await safePublish(item.shown
        ? {type:'ui_surface_update',conversationId:item.conversationId,surfaceId:summaryId(item.replyId),data}
        : {type:'ui_surface_show',conversationId:item.conversationId,surfaceId:summaryId(item.replyId),surfaceType:'card',data,messageId:item.replyId});
      item.shown=true; item.shownBody=data.body;
    }
    return true;
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
      const data=summaryData(item.usage,[...item.notices.values()],Boolean(item.usage || item.complete),item.startup);
      if(!data.body) { pending.delete(key); return; }
      const id=summaryId(item.replyId);
      if(!(ctx.content||[]).some(b=>b?.type==='ui_surface' && b.surfaceId===id))
        ctx.content.push({type:'ui_surface',surfaceId:id,surfaceType:'card',data});
      applied.add(key);
      pending.delete(key);
    } catch (e) { logger.warn?.({err:String(e)}, 'shim-ui post-model-call failed open'); }
  }
  return { consume, postModelCall, dispose(){pending.clear();applied.clear();}, get pendingSize(){return pending.size;} };
}
