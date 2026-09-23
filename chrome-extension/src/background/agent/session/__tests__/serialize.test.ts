import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
  serializeMessages,
  deserializeMessages,
  pruneRecords,
  STATE_MESSAGE_MARKER,
  type SessionRecordMeta,
} from '../serialize';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Session serialize - message round-trip', () => {
  it('system/user/ai messages survive serialize -> deserialize (class + text)', () => {
    const messages = [
      new SystemMessage('You are a navigator agent.'),
      new HumanMessage('Your ultimate task is: """fill the form"""'),
      new AIMessage('<plan>{"observation":"ok","next_steps":"click submit"}</plan>'),
      new HumanMessage('Action result: clicked'),
    ];

    const serialized = serializeMessages(messages);
    expect(serialized).toEqual([
      { role: 'system', text: 'You are a navigator agent.' },
      { role: 'user', text: 'Your ultimate task is: """fill the form"""' },
      { role: 'ai', text: '<plan>{"observation":"ok","next_steps":"click submit"}</plan>' },
      { role: 'user', text: 'Action result: clicked' },
    ]);

    const revived = deserializeMessages(serialized);
    expect(revived).toHaveLength(messages.length);
    expect(revived[0]).toBeInstanceOf(SystemMessage);
    expect(revived[1]).toBeInstanceOf(HumanMessage);
    expect(revived[2]).toBeInstanceOf(AIMessage);
    expect(revived[3]).toBeInstanceOf(HumanMessage);
    revived.forEach((message, i) => {
      expect(message.content).toBe(messages[i].content);
    });
  });

  it('skips tool messages and empty-content ai messages', () => {
    const messages = [
      new AIMessage({ content: '', tool_calls: [{ name: 'AgentOutput', args: {}, id: '1', type: 'tool_call' }] }),
      new ToolMessage({ content: 'Browser started', tool_call_id: '1' }),
      new HumanMessage('keep me'),
    ];
    expect(serializeMessages(messages)).toEqual([{ role: 'user', text: 'keep me' }]);
  });
});

describe('Session serialize - multi-part content', () => {
  it('keeps text parts and drops image_url parts entirely', () => {
    const message = new HumanMessage({
      content: [
        { type: 'text', text: 'first text part' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        { type: 'text', text: 'second text part' },
      ],
    });

    const serialized = serializeMessages([message]);
    expect(serialized).toHaveLength(1);
    expect(serialized[0].role).toBe('user');
    expect(serialized[0].text).toBe('first text part\nsecond text part');
    expect(serialized[0].text).not.toContain('data:image');
  });

  it('drops a message whose content is images only', () => {
    const message = new HumanMessage({
      content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }],
    });
    expect(serializeMessages([message])).toEqual([]);
  });
});

describe('Session serialize - browser-state message exclusion', () => {
  const stateText = `\n[Task history memory ends]\n${STATE_MESSAGE_MARKER}\nThe following is one-time information - if you need to remember it write it to memory:\nCurrent tab: {id: 1, url: https://example.com, title: Example}\nInteractive elements from top layer of the current page inside the viewport:\nempty page`;

  it('skips a plain-string browser-state message', () => {
    const messages = [new HumanMessage('before'), new HumanMessage(stateText), new HumanMessage('after')];
    expect(serializeMessages(messages)).toEqual([
      { role: 'user', text: 'before' },
      { role: 'user', text: 'after' },
    ]);
  });

  it('skips a multi-part browser-state message (text + screenshot)', () => {
    const state = new HumanMessage({
      content: [
        { type: 'text', text: stateText },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } },
      ],
    });
    expect(serializeMessages([state])).toEqual([]);
  });

  it('does not skip an ai message that merely quotes the marker', () => {
    const ai = new AIMessage(`the state message contains ${STATE_MESSAGE_MARKER}`);
    expect(serializeMessages([ai])).toHaveLength(1);
  });
});

describe('Session prune policy', () => {
  const now = 1_800_000_000_000;
  const meta = (sessionId: string, ageMs: number, hasDocs = true): SessionRecordMeta => ({
    sessionId,
    savedAt: now - ageMs,
    hasDocs,
  });

  it('keeps docs on the newest 20, strips docs beyond that', () => {
    // 25 fresh records (all younger than 7 days), newest = s0.
    const records = Array.from({ length: 25 }, (_, i) => meta(`s${i}`, i * 60_000));
    const decision = pruneRecords(records, now);
    expect(decision.deleteRecords).toEqual([]);
    expect(decision.stripDocs.sort()).toEqual(['s20', 's21', 's22', 's23', 's24'].sort());
  });

  it('exactly 20 fresh records: nothing stripped', () => {
    const records = Array.from({ length: 20 }, (_, i) => meta(`s${i}`, i * 60_000));
    const decision = pruneRecords(records, now);
    expect(decision.stripDocs).toEqual([]);
    expect(decision.deleteRecords).toEqual([]);
  });

  it('strips docs from records older than 7 days even inside the newest 20', () => {
    const records = [meta('fresh', 1 * DAY_MS), meta('old', 8 * DAY_MS)];
    const decision = pruneRecords(records, now);
    expect(decision.stripDocs).toEqual(['old']);
    expect(decision.deleteRecords).toEqual([]);
  });

  it('exactly 7 days old keeps its docs (strictly-older boundary)', () => {
    const records = [meta('boundary', 7 * DAY_MS), meta('justOver', 7 * DAY_MS + 1)];
    const decision = pruneRecords(records, now);
    expect(decision.stripDocs).toEqual(['justOver']);
  });

  it('records without docs are never listed for stripping', () => {
    const records = [meta('noDocs', 10 * DAY_MS, false)];
    expect(pruneRecords(records, now).stripDocs).toEqual([]);
  });

  it('deletes records older than 30 days; exactly 30 days survives', () => {
    const records = [
      meta('ancient', 31 * DAY_MS),
      meta('boundary30', 30 * DAY_MS),
      meta('justOver30', 30 * DAY_MS + 1),
      meta('fresh', 1 * DAY_MS),
    ];
    const decision = pruneRecords(records, now);
    expect(decision.deleteRecords.sort()).toEqual(['ancient', 'justOver30'].sort());
    // Deleted records must not also be listed for doc-stripping.
    expect(decision.stripDocs).not.toContain('ancient');
    expect(decision.stripDocs).not.toContain('justOver30');
    // boundary30 survives deletion but is older than 7d, so its docs go.
    expect(decision.stripDocs).toContain('boundary30');
  });

  it('respects custom keepCount and maxAgeDays', () => {
    const records = [meta('a', 0), meta('b', 1 * DAY_MS), meta('c', 3 * DAY_MS)];
    const decision = pruneRecords(records, now, 1, 2);
    // 'b' overflows keepCount=1; 'c' overflows AND is older than 2 days.
    expect(decision.stripDocs.sort()).toEqual(['b', 'c'].sort());
  });
});
