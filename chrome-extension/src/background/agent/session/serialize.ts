import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { AttachedDoc } from '../types';

// ---------------------------------------------------------------------------
// Session persistence — serialization (Wave 1: save-and-die foundation)
// ---------------------------------------------------------------------------
// PURE module: no chrome.*, no IndexedDB, no logging. Converts the live
// AgentContext pieces into plain JSON-safe records and back. The store shell
// (./store.ts) owns the IndexedDB side; the executor owns when to snapshot.
//
// Design: "every wait = save and die; every resume = load and revive."
// Wave 1 only writes these records; nothing reads them yet (revival = Wave 2).

/** One saved snapshot of a task session. Keyed by sessionId (= taskId). */
export interface SessionRecord {
  sessionId: string;
  savedAt: number;
  status: 'running' | 'awaiting_user' | 'cancelled' | 'done' | 'failed';
  /** Original + follow-up task texts, in order. */
  tasks: string[];
  /** Agent-visible message history, TEXT ONLY (no images, no browser state). */
  transcript: SerializedMessage[];
  /** Doc store mirror (may be stripped later by the prune policy). */
  attachedDocs: AttachedDoc[];
  /** Sticky "found values" lines from doc actions. */
  docFindings: string[];
  /** Sticky PDF page slot pinned by view_doc. */
  pdfSticky: { docOrdinal: number; page: number } | null;
  /** Navigator's last current_state.memory ('' if none yet). */
  progressMemory: string;
  nSteps: number;
}

export interface SerializedMessage {
  role: 'system' | 'user' | 'ai';
  text: string;
}

/**
 * Marker that identifies the ephemeral per-step browser-state HumanMessage
 * (built in prompts/base.ts buildBrowserStateUserMessage). There is no
 * structural tag on these messages — MessageMetadata.message_type is null for
 * them just like for plans and action results — so this content marker is the
 * only reliable signal. Keep in sync with prompts/base.ts.
 */
export const STATE_MESSAGE_MARKER = '[Current state starts here]';

/** Extract the concatenated text parts of a message, dropping image parts. */
function extractText(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string') {
        parts.push(item.text);
      }
      // image_url (and any other non-text) parts are dropped entirely.
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Serialize the agent-visible history to plain text records.
 * - Keeps System/Human/AI messages only (ToolMessages and AI tool_calls are
 *   per-step plumbing, not durable context).
 * - Drops image content parts (screenshots, sticky PDF pages).
 * - Excludes the ephemeral browser-state messages (STATE_MESSAGE_MARKER).
 * - Drops messages whose remaining text is empty.
 */
export function serializeMessages(messages: BaseMessage[]): SerializedMessage[] {
  const records: SerializedMessage[] = [];
  for (const message of messages) {
    let role: SerializedMessage['role'];
    if (message instanceof SystemMessage) {
      role = 'system';
    } else if (message instanceof HumanMessage) {
      role = 'user';
    } else if (message instanceof AIMessage) {
      role = 'ai';
    } else {
      continue; // ToolMessage etc.
    }
    const text = extractText(message);
    if (text.length === 0) {
      continue;
    }
    if (role === 'user' && text.includes(STATE_MESSAGE_MARKER)) {
      continue; // ephemeral per-step browser state
    }
    records.push({ role, text });
  }
  return records;
}

/** Rebuild LangChain messages from serialized records (used by Wave 2 revival). */
export function deserializeMessages(records: SerializedMessage[]): BaseMessage[] {
  return records.map(record => {
    switch (record.role) {
      case 'system':
        return new SystemMessage(record.text);
      case 'user':
        return new HumanMessage(record.text);
      case 'ai':
        return new AIMessage(record.text);
    }
  });
}

// ---------------------------------------------------------------------------
// Revival seeding (Wave 2: load and revive) — pure helpers.
// ---------------------------------------------------------------------------

/** First line of the resume note injected before the reviving task. */
export const RESUME_NOTE_HEADER =
  '[Resuming an earlier session — the summary below is a hint; the CURRENT page state is the truth]';

/**
 * Compact progress note shown to the model once, right before the new task.
 * The saved progressMemory is a *hint*: the live browser state message rebuilt
 * each step is the source of truth.
 */
export function buildResumeNote(record: SessionRecord): string {
  const summary = record.progressMemory.trim().length > 0 ? record.progressMemory.trim() : '(none)';
  return `${RESUME_NOTE_HEADER}\nProgress so far: ${summary}\n(earlier tasks: ${record.tasks.join(' / ')})`;
}

/**
 * Build the message-history seed for a revived executor.
 *
 * Rule: serialized system messages are DROPPED — the revived executor always
 * speaks with the CURRENT navigator system prompt (`freshSystemMessage`), so a
 * prompt update never leaves a stale serialized prompt in charge. The rest of
 * the transcript is replayed in order, followed by ONE resume note. The doc
 * guide and the new task message are appended by the executor afterwards
 * (mirroring the live follow-up flow).
 */
export function buildResumeMessages(record: SessionRecord, freshSystemMessage: SystemMessage): BaseMessage[] {
  const transcript = deserializeMessages(record.transcript.filter(message => message.role !== 'system'));
  return [freshSystemMessage, ...transcript, new HumanMessage(buildResumeNote(record))];
}

/**
 * Merge newly attached docs into an existing doc store, deduped by file name:
 * re-attaching a document with the same name replaces the earlier version
 * (incoming wins, appended at the end). Shared by the live follow-up path
 * (Executor.addAttachedDocs) and revival (restored record + new payload).
 */
export function mergeAttachedDocs(existing: AttachedDoc[], incoming: AttachedDoc[]): AttachedDoc[] {
  if (incoming.length === 0) {
    return [...existing];
  }
  const incomingNames = new Set(incoming.map(doc => doc.name));
  return [...existing.filter(doc => !incomingNames.has(doc.name)), ...incoming];
}

// ---------------------------------------------------------------------------
// Prune policy (pure) — the store applies the returned decision.
// ---------------------------------------------------------------------------

/** Metadata the store hands to the policy (never the full records). */
export interface SessionRecordMeta {
  sessionId: string;
  savedAt: number;
  hasDocs: boolean;
}

export interface PruneDecision {
  /** Records that keep their transcript but lose attachedDocs (the heavy part). */
  stripDocs: string[];
  /** Records to delete entirely. */
  deleteRecords: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DELETE_AFTER_DAYS = 30;

/**
 * Retention policy:
 * - records STRICTLY older than 30 days are deleted entirely;
 * - of the survivors, attachedDocs are stripped from any record that is
 *   beyond the newest `keepCount` (by savedAt) OR strictly older than
 *   `maxAgeDays` days. Records exactly at either boundary are kept intact.
 */
export function pruneRecords(records: SessionRecordMeta[], now: number, keepCount = 20, maxAgeDays = 7): PruneDecision {
  const deleteCutoff = now - DELETE_AFTER_DAYS * DAY_MS;
  const stripCutoff = now - maxAgeDays * DAY_MS;

  const deleteRecords: string[] = [];
  const survivors: SessionRecordMeta[] = [];
  for (const record of records) {
    if (record.savedAt < deleteCutoff) {
      deleteRecords.push(record.sessionId);
    } else {
      survivors.push(record);
    }
  }

  survivors.sort((a, b) => b.savedAt - a.savedAt); // newest first
  const stripDocs: string[] = [];
  survivors.forEach((record, index) => {
    if (!record.hasDocs) {
      return; // nothing to strip
    }
    if (index >= keepCount || record.savedAt < stripCutoff) {
      stripDocs.push(record.sessionId);
    }
  });

  return { stripDocs, deleteRecords };
}
