import { currentManager } from './init.js';
export default async function postModelCall(ctx){ await currentManager()?.postModelCall(ctx); }
