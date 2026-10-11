import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as codex from './history-rehydration.js';
import * as claude from '../../claude-code-shim-provider/scripts/history-rehydration.js';
import { SourceIdMap } from './source-id-map.js';

const sentinels = ['__PLACEHOLDER__[empty assistant turn]', '__PLACEHOLDER__[internal blocks omitted]'];
const edge = Array.from({length: 33}, (_, i) => String.fromCharCode(i)).join('');
const variants = sentinels.flatMap(s => [s, '\0' + s, edge + s + edge]);
const prose = sentinels.flatMap(s => [`Mention ${s}`, `${s} is a marker`, `"${s}"`, '\u00a0' + s + '\u00a0', '\x7f' + s]);
const call = {id: 'real-call', function: {name: 'lookup', arguments: '{"q":"kept"}'}};
const row = content => ({role: 'assistant', content, _sourceIds: ['01a12b14-40f2-73a2-8adc-5c94825331e1']});

for (const [name, h] of [['Codex', codex], ['Claude', claude]]) {
  test(`${name}: exact sentinel matcher accepts all C0 edges, preserves substring/non-C0 text`, () => {
    for (const s of variants) expect(h.isPlaceholderSentinelText(s)).toBe(true);
    for (const s of [...prose, '', '__PLACEHOLDER__', '__PLACEHOLDER__[unknown]']) expect(h.isPlaceholderSentinelText(s)).toBe(false);
  });
  test(`${name}: fresh sentinel-only history uses fallback; no assistant record leaks`, () => {
    for (const s of variants) {
      expect(h.historyToPrompt([row(s)])).toBe('');
      expect(h.promptForSession([row(s)], 'TAIL', true)).toBe('TAIL');
      expect(h.historyToPrompt([row(s), {role: 'user', content: 'next'}])).not.toContain('[Saved assistant message]');
    }
  });
  test(`${name}: fresh history preserves tool calls on sentinel rows`, () => {
    for (const s of variants) {
      const p = h.historyToPrompt([{...row(s), tool_calls: [call]}]);
      expect(p).toContain(h.recordedCallLine(call));
      expect(p).not.toContain('__PLACEHOLDER__');
    }
  });
  test(`${name}: multipart assistant filtering retains prose, tool_use and tool_result data`, () => {
    const content = [
      ...['text', 'input_text', 'output_text'].map(type => ({type, text: variants[2]})),
      {type: 'text', text: prose[0]},
      {type: 'tool_use', id: 'c', name: 'lookup', input: {q: sentinels[0]}},
      {type: 'tool_result', tool_use_id: 'c', content: sentinels[1]},
    ];
    expect(h.assistantContent(content)).toEqual(content.slice(3));
    expect(content).toHaveLength(6);
    const p = h.historyToPrompt([row(content)]);
    expect(p).toContain(prose[0]);
    expect(p).toContain('Recorded tool call lookup id=c');
    expect(p).toContain(`Recorded tool result c] ${sentinels[1]}`);
  });
  test(`${name}: fresh user/tool text and real assistant prose retain markers`, () => {
    for (const role of ['user', 'tool']) for (const s of variants) {
      expect(h.historyToPrompt([{role, content: s}])).toContain(s);
      expect(h.historyToPrompt([{role, content: [{type: 'text', text: s}]}])).toContain(s);
    }
    for (const s of prose) expect(h.historyToPrompt([row(s)])).toContain(s);
  });
  test(`${name}: foreign formatter drops empty frames, preserves calls and mentions`, () => {
    for (const s of variants) {
      expect(h.foreignReplyText(s, [])).toBe('');
      expect(h.foreignReplyText(s, [call])).toBe(`${h.FOREIGN_REPLY_FRAME}\n${h.recordedCallLine(call)}`);
    }
    for (const s of prose) expect(h.foreignReplyText(s, [])).toBe(`${h.FOREIGN_REPLY_FRAME}\n${s.trim()}`);
  });
}

// Exercise the actual server helpers without importing servers (which start listeners/CLIs).
const codexSource = readFileSync(new URL('./server-v2.js', import.meta.url), 'utf8');
const claudeSource = readFileSync(new URL('../../claude-code-shim-provider/scripts/server-v3.js', import.meta.url), 'utf8');
function declaration(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  if (!match) throw new Error(`missing ${name}`);
  return match[0];
}
const hash = b => JSON.stringify(b);
const blocksOf = Function('assistantContent', 'foreignReplyText', 'blockHash', `${declaration(codexSource, 'blocksOf')}; return blocksOf`)(codex.assistantContent, codex.foreignReplyText, hash);
const tagForeign = Function('foreignReplyText', 'sha', `return function ${claudeSource.match(/  tagForeign\(blocks\) \{[^]*?\n  \}/)[0].trim()}`)(claude.foreignReplyText, hash);
const inputBlocks = Function(`${declaration(claudeSource, 'inputBlocks')}; return inputBlocks`)();
for (const mode of ['Codex', 'Claude mcp', 'Claude text']) {
  const messagesToBlocks = mode === 'Codex' ? null : Function('assistantContent', 'TOOL_MODE', 'consumedToolIds', [declaration(claudeSource, 'contentToText'), declaration(claudeSource, 'tcToJson'), declaration(claudeSource, 'messagesToBlocks'), 'return messagesToBlocks'].join('\n'))(claude.assistantContent, mode === 'Claude mcp' ? 'mcp' : 'text', new Set());
  function feed(messages, map) {
    if (mode === 'Codex') return blocksOf(messages, map);
    const blocks = messagesToBlocks(messages, [], map);
    tagForeign.call({idMap: () => map}, blocks);
    return inputBlocks(blocks);
  }
  test(`${mode}: warm unknown sentinel row never becomes a foreign reply`, () => {
    const map = new SourceIdMap(':memory:');
    try {
      for (const s of variants) for (const content of [s, [{type: 'text', text: s}]]) {
        expect(feed([row(content)], map)).toEqual([]);
      }
      expect(feed([row('real reply')], map)).toHaveLength(1);
    } finally { map.close(); }
  });
  test(`${mode}: warm sentinel row keeps real tool calls and source ids`, () => {
    const map = new SourceIdMap(':memory:');
    try {
      for (const s of variants) {
        const blocks = feed([{...row(s), tool_calls: [call]}], map);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].text).toContain(codex.recordedCallLine(call));
        expect(blocks[0].text).not.toContain('__PLACEHOLDER__');
        expect(blocks[0].sourceIds).toEqual(row(s)._sourceIds);
      }
    } finally { map.close(); }
  });
  test(`${mode}: warm user/tool markers and assistant mentions survive`, () => {
    const map = new SourceIdMap(':memory:');
    try {
      for (const s of variants) {
        const blocks = feed([{role: 'user', content: s}, {role: 'tool', content: s, tool_call_id: 'done'}], map);
        expect(blocks).toHaveLength(2);
        for (const b of blocks) expect(b.text).toContain(s);
      }
      for (const s of prose) {
        const blocks = feed([row(s)], map);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].text).toContain(s.trim());
      }
      const blocks = feed([row([{type: 'text', text: sentinels[0]}, {type: 'text', text: 'real reply'}])], map);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].text).toContain('real reply');
      expect(blocks[0].text).not.toContain('__PLACEHOLDER__');
    } finally { map.close(); }
  });
}

test('Claude live tool-result resolver preserves exact markers and control bytes', () => {
  const pending = new Map();
  const consumed = new Set();
  const resolveToolResults = Function('pendingToolUses', 'consumedToolIds', 'emittedToolIds', 'earlyResults', [
    declaration(claudeSource, 'contentToText'), declaration(claudeSource, 'resolveToolResults'), 'return resolveToolResults',
  ].join('\n'))(pending, consumed, new Set(), new Map());
  for (const s of [...variants, ...prose]) for (const content of [s, [{type: 'text', text: s}]]) {
    let result;
    pending.set('pending', {chatKey: 'chat', resolve: value => { result = value; }});
    expect(resolveToolResults([{role: 'assistant', content: s}, {role: 'tool', content, tool_call_id: 'pending'}], 'chat')).toBe(1);
    expect(result).toEqual({content: [{type: 'text', text: s}]});
    expect(pending.size).toBe(0);
    expect(consumed.has('pending')).toBe(true);
  }
});
