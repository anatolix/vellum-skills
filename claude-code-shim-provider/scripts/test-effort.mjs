import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
// usage: bun test-effort.mjs [path/to/server-v3.js ...]  (default: sibling server-v3.js)
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const paths = process.argv.slice(2).length ? process.argv.slice(2) : [join(dirname(fileURLToPath(import.meta.url)), 'server-v3.js')];
for (const path of paths) {
  const source = readFileSync(path, 'utf8');
  const classSource = source.slice(source.indexOf('class Cli {'), source.indexOf('\nfunction sameList'));
  const captures = [], changes = [];
  const fakeQuery = {
    applyFlagSettings: async x => changes.push(x),
    updateSettings: () => { throw Error('Must not write persistent settings'); },
  };
  const Cli = new Function('query', `let cliSeq=0; const SYS_SNAPSHOT=false, VERBATIM=true, FALLBACK_MODEL='', PRECOMPUTE_COMPACT=false; ${classSource}; return Cli;`)(opts => { captures.push(opts); return fakeQuery; });
  Cli.prototype.pump = async () => {};
  for (const effort of ['low','medium','high','xhigh','max']) {
    const c = new Cli('test', 'opus', null, null, effort);
    assert.equal(captures.at(-1).options.effort, effort);
    assert.equal(captures.at(-1).options.thinking.type, 'adaptive');
  }
  const disabled = new Cli('none', 'opus', null, null, 'none');
  assert.equal(captures.at(-1).options.thinking.type, 'disabled');
  assert.equal(captures.at(-1).options.effort, undefined);
  const c = new Cli('switch', 'opus', null, null, 'low');
  for (const effort of ['medium','high','xhigh','max','low']) {
    assert.equal(await c.setEffort(effort), true);
    assert.deepEqual(changes.at(-1), { effortLevel: effort });
    assert.equal(c.effort, effort);
  }
  const n = changes.length;
  assert.equal(await c.setEffort('low'), true);
  assert.equal(changes.length,n);
  assert.equal(await c.setEffort('none'),false);
  assert.equal(await c.setEffort(null),false);
  assert.equal(await disabled.setEffort('max'),false);
  console.log('PASS: spawn all five tiers, live applyFlagSettings, none transitions:', path);
}
