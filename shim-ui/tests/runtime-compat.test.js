import { test, expect } from 'bun:test';
import { runtimeRoot, VERIFIED_VERSIONS } from '../runtime-compat.js';
test('both verified Vellum releases resolve their own CRUD, never old runtime',()=>{
 for(const v of VERIFIED_VERSIONS) expect(runtimeRoot(v, '/tmp/assistant/workspace')).toEndWith(`/runtime/${v}/node_modules/@vellumai/assistant/src`);
 expect(VERIFIED_VERSIONS).toContain('0.12.8');
});
test('unknown releases and path injection fail closed',()=>{
 for(const v of ['0.12.9','../0.12.6',undefined]) expect(()=>runtimeRoot(v, '/tmp/assistant/workspace')).toThrow('unverified');
});
