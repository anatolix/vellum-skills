
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PENDING = 512;
const MAX_LINES = 5;
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
export const warnId = replyId => `shim-ui:${replyId}:warnings`;
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
export function createManager({ getMessages, getMessageById, publish, removeSurfaceBlock, logger=console, now=Date.now }) {
  const pending = new Map();
  const applied = new Set();
  // conversationId -> rolling usage card for the whole chat: one card at the
  // newest step, holding up to MAX_LINES recent step lines; the previous
  // step's card is dismissed live and stripped from its persisted row.
  const turns = new Map();
  function prune() {
    const cutoff=now()-TTL_MS;
    for (const [k,v] of pending) if (v.updated < cutoff) pending.delete(k);
    for (const [k,v] of turns) if (v.updated < cutoff) turns.delete(k);
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
    while (applied.size > MAX_PENDING*4) applied.delete(applied.values().next().value);
  }
  const rolled = turn => turn.lines.join('  \n');
  const hasText = row => Array.isArray(row?.content) && row.content.some(b=>b?.type==='text' && String(b.text||'').trim());
  // Roll-up breaks on visible output: any model text since the card's current
  // step (including that step's own row) or any human text message in between.
  async function needsReset(turn, conversationId, replyId) {
    try {
      if (getMessageById && hasText(await getMessageById(turn.replyId))) return true;
      if (getMessages) {
        const rows=await getMessages(conversationId);
        const i=rows.findIndex(x=>x.id===turn.replyId), j=rows.findIndex(x=>x.id===replyId);
        if (i>=0 && j>i)
          for (const m of rows.slice(i+1,j))
            if (m.role==='user' && hasText(m)) return true;
      }
    } catch { /* fail open: keep rolling */ }
    return false;
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
    const data=summaryData(item.usage,[],Boolean(item.usage || item.complete),item.startup);
    if(data.body && data.body !== item.shownBody) {
      const id=summaryId(item.replyId);
      let turn=turns.get(e.conversationId);
      if (turn && turn.surfaceId!==id && await needsReset(turn,e.conversationId,e.replyId)) { turns.delete(e.conversationId); turn=undefined; }
      if (turn && turn.surfaceId===id) {
        turn.lines[turn.lines.length-1]=data.body; turn.updated=now();
        const data2={...data, body:rolled(turn)};
        await safePublish({type:'ui_surface_update',conversationId:item.conversationId,surfaceId:id,data:data2});
        item.rolledData=data2;
      } else if (turn && turn.lines.length) {
        turn.lines.push(data.body); while(turn.lines.length>MAX_LINES) turn.lines.shift();
        turn.updated=now();
        const data2={...data, body:rolled(turn)};
        await safePublish({type:'ui_surface_dismiss',conversationId:item.conversationId,surfaceId:turn.surfaceId});
        await safePublish({type:'ui_surface_show',conversationId:item.conversationId,surfaceId:id,surfaceType:'card',data:data2,messageId:item.replyId});
        if (removeSurfaceBlock && turn.replyId!==item.replyId) {
          try { await removeSurfaceBlock(turn.replyId, turn.surfaceId); }
          catch (err) { logger.warn?.({err:String(err)}, 'shim-ui strip of superseded card failed (non-fatal)'); }
        }
        turn.surfaceId=id; turn.replyId=item.replyId;
        item.rolledData=data2;
      } else {
        turn={lines:[data.body],surfaceId:id,replyId:item.replyId,updated:now()};
        turns.set(e.conversationId,turn);
        await safePublish({type:'ui_surface_show',conversationId:item.conversationId,surfaceId:id,surfaceType:'card',data,messageId:item.replyId});
        item.rolledData=data;
      }
      item.shown=true; item.shownBody=data.body;
    }
    // Warnings live on their OWN card per reply — never rolled into the token card.
    const warnLabels=[...new Set([...item.notices.values()].map(compactNotice).filter(Boolean))];
    const warnBody=warnLabels.length ? '🔴 '+warnLabels.slice(0,2).map(mdLiteral).join(' · ')+(warnLabels.length>2?` · ещё ${warnLabels.length-2}`:'') : '';
    if (warnBody && warnBody!==item.shownWarnBody) {
      const wdata={body:warnBody, _shimWarnings:[...item.notices.values()]};
      await safePublish(item.shownWarn
        ? {type:'ui_surface_update',conversationId:item.conversationId,surfaceId:warnId(item.replyId),data:wdata}
        : {type:'ui_surface_show',conversationId:item.conversationId,surfaceId:warnId(item.replyId),surfaceType:'card',data:wdata,messageId:item.replyId});
      item.shownWarn=true; item.shownWarnBody=warnBody; item.warnData=wdata;
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
      const data=item.rolledData ?? summaryData(item.usage,[],Boolean(item.usage || item.complete),item.startup);
      const warnData=item.warnData;
      if(!data.body && !warnData?.body) { pending.delete(key); return; }
      const id=summaryId(item.replyId);
      if(data.body && !(ctx.content||[]).some(b=>b?.type==='ui_surface' && b.surfaceId===id))
        ctx.content.push({type:'ui_surface',surfaceId:id,surfaceType:'card',data});
      if(warnData?.body && !(ctx.content||[]).some(b=>b?.type==='ui_surface' && b.surfaceId===warnId(item.replyId)))
        ctx.content.push({type:'ui_surface',surfaceId:warnId(item.replyId),surfaceType:'card',data:warnData});
      applied.add(key);
      pending.delete(key);
    } catch (e) { logger.warn?.({err:String(e)}, 'shim-ui post-model-call failed open'); }
  }
  return { consume, postModelCall, dispose(){pending.clear();applied.clear();turns.clear();}, get pendingSize(){return pending.size;} };
}
