import { z } from 'zod';
import type BrowserContext from '../browser/context';
import { DEFAULT_INCLUDE_ATTRIBUTES } from '../browser/dom/views';
import type { DOMHistoryElement } from '../browser/dom/history/view';
import type MessageManager from './messages/service';
import type { EventManager } from './event/manager';
import { type Actors, ExecutionState, AgentEvent } from './event/types';
import { AgentStepHistory } from './history';

export interface AgentOptions {
  maxSteps: number;
  maxActionsPerStep: number;
  maxFailures: number;
  retryDelay: number;
  maxInputTokens: number;
  maxErrorLength: number;
  useVision: boolean;
  useVisionForPlanner: boolean;
  includeAttributes: string[];
  planningInterval: number;
}

// Context window, in one place because the two numbers below MUST agree.
// helper.ts hands MODEL_CONTEXT_TOKENS to Ollama as num_ctx — a per-request
// option, so it overrides whatever the Modelfile declares — and MessageManager
// trims history at MAX_PROMPT_TOKENS. They had drifted apart (trim at 128k, a
// 64k window): trimming never fired, the prompt outgrew the window, and local
// models stalled mid-run. The gap between the two is the room left for output.
export const MODEL_CONTEXT_TOKENS = 40_000;
export const MAX_PROMPT_TOKENS = 32_000;

export const DEFAULT_AGENT_OPTIONS: AgentOptions = {
  maxSteps: 100,
  maxActionsPerStep: 10,
  maxFailures: 3,
  retryDelay: 10,
  maxInputTokens: MAX_PROMPT_TOKENS,
  maxErrorLength: 400,
  useVision: false,
  useVisionForPlanner: true,
  includeAttributes: DEFAULT_INCLUDE_ATTRIBUTES,
  planningInterval: 3,
};

// ---------------------------------------------------------------------------
// Attached documents (doc store)
// ---------------------------------------------------------------------------
// Structured parses of office documents (.docx/.hwpx) attached in the side
// panel. The side panel parses at attach time and ships store-path documents
// on the `new_task` / `follow_up_task` port messages; the parse then lives on
// the AgentContext for the task's lifetime so doc actions (M3) can query it
// without ever inlining the full document into a prompt.
//
// These are mirror copies of the side-panel source of truth
// (pages/side-panel/src/lib/docParse.ts: DocParseResult/TocEntry/DocBlock and
// docAttach.ts: AttachedDocPayload) — the two workspaces don't share code, the
// same convention as event/types.ts vs pages/side-panel/src/types/event.ts.

export interface DocTocEntry {
  id: string; // 't1', 't1-2' (nested), stable
  title: string;
  fields: string[]; // header-row cell texts
  rowCount: number;
  parentId?: string; // for nested tables
}

export interface DocBlock {
  id: string;
  tableId?: string; // undefined for plain paragraph blocks
  breadcrumb: string;
  lines: string[]; // searchable lines
}

/** Mirror of docParse.ts FieldEntry — a "Label: value" pair with its section. */
export interface DocFieldEntry {
  label: string;
  value: string;
  section?: string;
  ref: string;
}

export interface DocParseResult {
  kind: 'docx' | 'hwpx' | 'pdf';
  toc: DocTocEntry[];
  blocks: DocBlock[];
  fields?: DocFieldEntry[];
  markdown?: string; // whole office document as markdown (row-intact tables), see docParse.ts
  stats: { tables: number; maxDepth: number; blocks: number };
  // PDF only (M4): one rendered image per page, produced once at attach time,
  // for the view_doc sticky slot. Office documents leave this undefined.
  pages?: DocPageImage[];
}

/** One rendered PDF page image for the view_doc sticky slot. */
export interface DocPageImage {
  index: number; // 1-based page number — matches the 'pN' toc/block ids
  image: string; // data URL (JPEG)
}

/** One attached store-path document: file name + its structured parse. */
export interface AttachedDoc {
  name: string;
  parse: DocParseResult;
}

export class AgentContext {
  controller: AbortController;
  taskId: string;
  browserContext: BrowserContext;
  messageManager: MessageManager;
  eventManager: EventManager;
  options: AgentOptions;
  paused: boolean;
  stopped: boolean;
  consecutiveFailures: number;
  nSteps: number;
  stepInfo: AgentStepInfo | null;
  actionResults: ActionResult[];
  stateMessageAdded: boolean;
  history: AgentStepHistory;
  finalAnswer: string | null;
  // Metadata of the action currently executing; auto-attached to act.* events.
  currentAction: { actionName: string; actionIndex: number; actionCount: number } | null = null;
  // Doc store: structured parses of documents attached to this task. Lives for
  // the executor's lifetime, so follow-up tasks in the same session keep it.
  // Queried by the search_doc / read_table actions (M3).
  attachedDocs: AttachedDoc[] = [];
  // Sticky "found values" slot (M3): the last ~30 distinct lines the doc
  // actions returned (FIFO, deduped by text). Re-injected into every per-step
  // state message so values found at step 3 are still visible at step 40.
  docFindings: string[] = [];
  // Sticky PDF page slot (M4): the ONE attached-PDF page pinned by view_doc,
  // re-sent as an image with every per-step state message (goto semantics —
  // view_doc replaces the slot, there is no next/prev). docOrdinal is 1-based
  // among ALL attachedDocs, the same numbering the multi-doc table-id
  // prefixes use; page is the 1-based page number ('pN').
  pdfSticky: { docOrdinal: number; page: number } | null = null;
  // Navigator's latest current_state.memory — the model's own running progress
  // summary. Captured each step (agents/navigator.ts) and persisted with every
  // session snapshot (session/serialize.ts); Wave 2 revival primes from it.
  progressMemory = '';
  // ask_user (Wave 3): the question the agent asked the user, if any. Set by
  // the ask_user action; the navigator then drops the rest of the action
  // batch and the executor ends the run as a clean 'awaiting_user' terminal.
  // Cleared at the start of the next run (the user's answer arrives as a
  // follow-up / revival task).
  askUserPending: string | null = null;
  // done with reason cannot_continue: the cause, read by the executor to end the run.
  blockedReason: string | null = null;
  // Mid-run user chat (Wave 3): messages the user typed while the agent was
  // stepping. index.ts queues them here; the executor drains the queue at the
  // next step boundary and injects each as a user message.
  queuedUserMessages: string[] = [];

  constructor(
    taskId: string,
    browserContext: BrowserContext,
    messageManager: MessageManager,
    eventManager: EventManager,
    options: Partial<AgentOptions>,
  ) {
    this.controller = new AbortController();
    this.taskId = taskId;
    this.browserContext = browserContext;
    this.messageManager = messageManager;
    this.eventManager = eventManager;
    this.options = { ...DEFAULT_AGENT_OPTIONS, ...options };

    this.paused = false;
    this.stopped = false;
    this.nSteps = 0;
    this.consecutiveFailures = 0;
    this.stepInfo = null;
    this.actionResults = [];
    this.stateMessageAdded = false;
    this.history = new AgentStepHistory();
    this.finalAnswer = null;
  }

  async emitEvent(
    actor: Actors,
    state: ExecutionState,
    eventDetails: string,
    extra?: { actionName?: string; actionIndex?: number; actionCount?: number },
  ) {
    // Auto-attach the executing action's metadata to act.* events so the side
    // panel can render type icons / "Tool:" boxes / batch grouping.
    const isActState =
      state === ExecutionState.ACT_START || state === ExecutionState.ACT_OK || state === ExecutionState.ACT_FAIL;
    const actionMeta = isActState && this.currentAction ? this.currentAction : undefined;
    const event = new AgentEvent(actor, state, {
      taskId: this.taskId,
      step: this.nSteps,
      maxSteps: this.options.maxSteps,
      details: eventDetails,
      ...actionMeta,
      ...extra,
    });
    await this.eventManager.emit(event);
  }

  async pause() {
    this.paused = true;
  }

  async resume() {
    this.paused = false;
  }

  async stop() {
    this.stopped = true;
    setTimeout(() => this.controller.abort(), 300);
  }
}

export class AgentStepInfo {
  stepNumber: number;
  maxSteps: number;

  constructor(params: { stepNumber: number; maxSteps: number }) {
    this.stepNumber = params.stepNumber;
    this.maxSteps = params.maxSteps;
  }
}

export class ActionResult {
  isDone: boolean;
  success: boolean;
  extractedContent: string | null;
  error: string | null;
  includeInMemory: boolean;
  interactedElement: DOMHistoryElement | null;

  constructor(params: Partial<ActionResult> = {}) {
    this.isDone = params.isDone ?? false;
    this.success = params.success ?? false;
    this.interactedElement = params.interactedElement ?? null;
    this.extractedContent = params.extractedContent ?? null;
    this.error = params.error ?? null;
    this.includeInMemory = params.includeInMemory ?? false;
  }
}

export type WrappedActionResult = ActionResult & {
  toolCallId: string;
};

export class StepMetadata {
  stepStartTime: number;
  stepEndTime: number;
  inputTokens: number;
  stepNumber: number;

  constructor(stepStartTime: number, stepEndTime: number, inputTokens: number, stepNumber: number) {
    this.stepStartTime = stepStartTime;
    this.stepEndTime = stepEndTime;
    this.inputTokens = inputTokens;
    this.stepNumber = stepNumber;
  }

  /**
   * Calculate step duration in seconds
   */
  get durationSeconds(): number {
    return this.stepEndTime - this.stepStartTime;
  }
}

export const agentBrainSchema = z
  .object({
    evaluation_previous_goal: z.string(),
    memory: z.string(),
    next_goal: z.string(),
  })
  .describe('Current state of the agent');

export type AgentBrain = z.infer<typeof agentBrainSchema>;

// Make AgentOutput generic with Zod schema
export interface AgentOutput<T = unknown> {
  /**
   * The unique identifier for the agent
   */
  id: string;

  /**
   * The result of the agent's step
   */
  result?: T;
  /**
   * The error that occurred during the agent's action
   */
  error?: string;
}
