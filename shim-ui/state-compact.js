import { assistantEventHub, publishEvent } from '@vellumai/plugin-api';
import { randomUUID } from 'node:crypto';
import { createManager } from './core-compact.js';

let subscription;
let manager;
export async function start(ctx) {
  if (ctx.assistantVersion !== '0.12.6') { ctx.logger.warn({version:ctx.assistantVersion}, 'shim-ui disabled: native CRUD is only verified on 0.12.6'); return; }
  subscription?.dispose(); manager?.dispose();
  try {
    const root='/home/vellum/.local/share/vellum/assistants/juno/.vellum/runtime/0.12.6/node_modules/@vellumai/assistant/src';
    const crud=await import(`file://${root}/persistence/conversation-crud.ts`);
    manager=createManager({getMessages:crud.getMessages,getMessageById:crud.getMessageById,logger:ctx.logger,
      publish:message=>publishEvent({id:randomUUID(),emittedAt:new Date().toISOString(),conversationId:message.conversationId,message})});
    subscription=assistantEventHub.subscribe({type:'process',callback:envelope=>manager?.consume(envelope).catch(err=>ctx.logger.warn({err:String(err)},'shim-ui event failed open'))});
    ctx.logger.info('shim-ui compact v1.0.2 listener active');
  } catch (err) { manager?.dispose(); manager=undefined; ctx.logger.warn({err:String(err)},'shim-ui could not load version-gated CRUD; disabled'); }
}
export function currentManager(){return manager;}
export function stop(){subscription?.dispose();subscription=undefined;manager?.dispose();manager=undefined;}
