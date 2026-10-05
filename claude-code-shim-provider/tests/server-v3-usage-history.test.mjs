import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../scripts/server-v3.js', import.meta.url), 'utf8');
const fn = source.match(/function usageFromStep\(u\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(fn, 'usageFromStep remains a pure helper in server-v3.js');
const usageFromStep = Function(`${fn}; return usageFromStep`)();

test('Anthropic step usage becomes inclusive prompt and distinct cache buckets', () => {
  assert.deepEqual(usageFromStep({ input_tokens: 11, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 5 }), {
    prompt_tokens: 21, completion_tokens: 5, total_tokens: 26,
    prompt_tokens_details: { cached_tokens: 7, cache_write_tokens: 3 },
  });
});
test('unknown/incomplete step usage is omitted, never fabricated as zero', () => {
  assert.equal(usageFromStep(null), null);
  assert.equal(usageFromStep({ input_tokens: 12 }), null);
});
test('full-history restore notice is emitted only for fresh multi-block history', () => {
  assert.match(source, /if \(historyBlocks > 1\) shimNotice\(onMsg, short\(this\.key\), noticeText\("claude-shim", "Восстановлена история"/);
  assert.match(source, /if \(historyBlocks > 1\) shimNotice\(onMsg, tag, noticeText\("claude-shim", "Восстановлена история"/);
  assert.match(source, /sendUsage\(finalStepUsage\(\)\);/);
  assert.match(source, /stepCount <= 1 \? usageFromResult\(result\) : null/);
});

test('another model\'s assistant rows are fed as text, own rows never (model switch fix)', () => {
  assert.match(source, /function inputBlocks\(blocks\) \{\n  return blocks\.filter\(\(b\) => \(b\.role !== "assistant" \|\| b\.foreign\)/);
  assert.match(source, /this\.idMap\(\)\.isForeignAssistant\(b, sha\(b\.text\)\)/);
  assert.match(source, /if \(\/\^<context_summary>\/\.test\(plain\)\) continue;/);
  assert.match(source, /const fedUser = unseen\.filter\(\(b\) => \(b\.role === "user" \|\| b\.foreign\) && b\.sourceIds\?\.length\);/);
  assert.match(source, /diagnostic\(onMsg, short\(this\.key\), "Ответы другой модели"/);
});
