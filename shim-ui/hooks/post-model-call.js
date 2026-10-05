import { currentManager } from '../state-compact.js';
export default async function postModelCall(ctx){ await currentManager()?.postModelCall(ctx); }
