import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  buildResumeMessages,
  buildResumeNote,
  mergeAttachedDocs,
  RESUME_NOTE_HEADER,
  type SessionRecord,
} from '../serialize';
import type { AttachedDoc } from '../../types';

// ---------------------------------------------------------------------------
// Wave 2 revival seeding — pure helpers (buildResumeMessages / buildResumeNote
// / mergeAttachedDocs). The executor consumes these; the store stays dumb.
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 'session-1',
    savedAt: 1_800_000_000_000,
    status: 'cancelled',
    tasks: ['fill the form', 'submit it'],
    transcript: [
      { role: 'system', text: 'OLD STALE SYSTEM PROMPT' },
      { role: 'user', text: 'Your ultimate task is: """fill the form"""' },
      { role: 'ai', text: '<plan>{"observation":"form found","next_steps":"type name"}</plan>' },
      { role: 'user', text: 'Action result: typed name' },
    ],
    attachedDocs: [],
    docFindings: ['성명: 홍길동'],
    pdfSticky: null,
    progressMemory: 'Typed the name field; 2 fields remain.',
    nSteps: 3,
    ...overrides,
  };
}

function makeDoc(name: string, marker = ''): AttachedDoc {
  return {
    name,
    parse: {
      kind: 'docx',
      toc: [{ id: 't1', title: `table-${marker || name}`, fields: [], rowCount: 1 }],
      blocks: [],
      stats: { tables: 1, maxDepth: 1, blocks: 0 },
    },
  };
}

describe('Session revival - buildResumeMessages', () => {
  const freshSystem = new SystemMessage('FRESH CURRENT NAVIGATOR PROMPT');

  it('drops the stale serialized system message and uses the fresh one', () => {
    const messages = buildResumeMessages(makeRecord(), freshSystem);

    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[0].content).toBe('FRESH CURRENT NAVIGATOR PROMPT');
    // Exactly one system message, and the stale text is gone entirely.
    expect(messages.filter(m => m instanceof SystemMessage)).toHaveLength(1);
    for (const message of messages) {
      expect(message.content).not.toContain('OLD STALE SYSTEM PROMPT');
    }
  });

  it('preserves transcript order and roles between system and resume note', () => {
    const messages = buildResumeMessages(makeRecord(), freshSystem);

    // [fresh system, ...transcript(no system), resume note]
    expect(messages).toHaveLength(1 + 3 + 1);
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(messages[1].content).toBe('Your ultimate task is: """fill the form"""');
    expect(messages[2]).toBeInstanceOf(AIMessage);
    expect(messages[2].content).toBe('<plan>{"observation":"form found","next_steps":"type name"}</plan>');
    expect(messages[3]).toBeInstanceOf(HumanMessage);
    expect(messages[3].content).toBe('Action result: typed name');
  });

  it('ends with ONE resume note: page-is-the-truth header, progress summary, previous tasks', () => {
    const messages = buildResumeMessages(makeRecord(), freshSystem);
    const note = messages[messages.length - 1];

    expect(note).toBeInstanceOf(HumanMessage);
    const text = note.content as string;
    expect(text).toContain(RESUME_NOTE_HEADER);
    expect(text).toContain('the CURRENT page state is the truth');
    expect(text).toContain('Progress so far: Typed the name field; 2 fields remain.');
    expect(text).toContain('(earlier tasks: fill the form / submit it)');
    // Only one message carries the header.
    expect(messages.filter(m => typeof m.content === 'string' && m.content.includes(RESUME_NOTE_HEADER))).toHaveLength(
      1,
    );
  });

  it('empty progressMemory renders as (none)', () => {
    const note = buildResumeNote(makeRecord({ progressMemory: '  ' }));
    expect(note).toContain('Progress so far: (none)');
  });
});

describe('Session revival - mergeAttachedDocs (dedupe by name)', () => {
  it('incoming doc with the same name replaces the restored one', () => {
    const restored = [makeDoc('report.docx', 'old'), makeDoc('form.hwpx')];
    const incoming = [makeDoc('report.docx', 'new')];

    const merged = mergeAttachedDocs(restored, incoming);

    expect(merged.map(d => d.name)).toEqual(['form.hwpx', 'report.docx']);
    expect(merged.find(d => d.name === 'report.docx')?.parse.toc[0].title).toBe('table-new');
  });

  it('new names are appended after the restored docs', () => {
    const merged = mergeAttachedDocs([makeDoc('a.docx')], [makeDoc('b.docx')]);
    expect(merged.map(d => d.name)).toEqual(['a.docx', 'b.docx']);
  });

  it('empty incoming returns a copy of existing (no aliasing)', () => {
    const existing = [makeDoc('a.docx')];
    const merged = mergeAttachedDocs(existing, []);
    expect(merged).toEqual(existing);
    expect(merged).not.toBe(existing);
  });

  it('empty existing returns the incoming docs', () => {
    const merged = mergeAttachedDocs([], [makeDoc('a.docx')]);
    expect(merged.map(d => d.name)).toEqual(['a.docx']);
  });
});
