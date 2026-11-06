import { assistantEventHub, publishEvent, getWorkspaceDir } from '@vellumai/plugin-api';
import { randomUUID } from 'node:crypto';
import { createManager } from './core-compact.js';
import { runtimeRoot } from './runtime-compat.js';
import { pathToFileURL } from 'node:url';

let subscription;
let manager;
export async function start(ctx) {
  subscription?.dispose(); manager?.dispose();
  try {
    const root=runtimeRoot(ctx.assistantVersion, getWorkspaceDir());
    const crud=await import(pathToFileURL(`${root}/persistence/conversation-crud.ts`).href);
    for (const name of ['getMessages', 'getMessageById', 'updateMessageContent'])
      if (typeof crud[name] !== 'function') throw new Error(`Missing persistence API: ${name}`);
    const removeSurfaceBlock=(messageId,surfaceId)=>{
      const row=crud.getMessageById(messageId);
      if(!row||!Array.isArray(row.content)) return;
      const next=row.content.filter(b=>!(b&&b.type==='ui_surface'&&b.surfaceId===surfaceId));
      if(next.length!==row.content.length) crud.updateMessageContent(messageId,JSON.stringify(next));
    };
    manager=createManager({getMessages:crud.getMessages,getMessageById:crud.getMessageById,removeSurfaceBlock,logger:ctx.logger,
      publish:message=>publishEvent({id:randomUUID(),emittedAt:new Date().toISOString(),conversationId:message.conversationId,message})});
    subscription=assistantEventHub.subscribe({type:'process',callback:envelope=>manager?.consume(envelope).catch(err=>ctx.logger.warn({err:String(err)},'shim-ui event failed open'))});
    ctx.logger.info({version:ctx.assistantVersion}, 'shim-ui v1.3.1 listener active');
  } catch (err) { manager?.dispose(); manager=undefined; ctx.logger.warn({err:String(err)},'shim-ui could not load version-gated CRUD; disabled'); }
}
export function currentManager(){return manager;}
export function stop(){subscription?.dispose();subscription=undefined;manager?.dispose();manager=undefined;}
