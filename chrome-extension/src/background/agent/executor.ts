import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import { type ActionResult, AgentContext, type AgentOptions, type AgentOutput, type AttachedDoc } from './types';
import { t } from '@extension/i18n';
import { formatDocGuide } from './actions/docSearch';
import { wrapUntrustedContent } from './messages/utils';
import { NavigatorAgent, NavigatorActionRegistry } from './agents/navigator';
import { PlannerAgent, type PlannerOutput } from './agents/planner';
import { NavigatorPrompt } from './prompts/navigator';
import { PlannerPrompt } from './prompts/planner';
import { createLogger } from '@src/background/log';
import MessageManager from './messages/service';
import type BrowserContext from '../browser/context';
import { ActionBuilder } from './actions/builder';
import { EventManager } from './event/manager';
import { Actors, type EventCallback, EventType, ExecutionState } from './event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  ExtensionConflictError,
  RequestCancelledError,
  MaxFailuresReachedError,
} from './agents/errors';
import { URLNotAllowedError } from '../browser/views';
import { chatHistoryStore } from '@extension/storage/lib/chat';
import { buildResumeMessages, mergeAttachedDocs, serializeMessages, type SessionRecord } from './session/serialize';
import { saveSessionRecord, pruneSessions } from './session/store';
import type { AgentStepHistory } from './history';
import { generalSettingsStore, type GeneralSettingsConfig } from '@extension/storage';

const logger = createLogger('Executor');

export interface ExecutorExtraArgs {
  plannerLLM?: BaseChatModel;
  extractorLLM?: BaseChatModel;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
  /** Store-path documents attached to the task (doc store; see AgentContext.attachedDocs). */
  attachedDocs?: AttachedDoc[];
  /**
   * Session revival (Wave 2: load and revive): when present, the executor is
   * rebuilt from this saved record instead of a blank task init — transcript,
   * doc store, doc findings, sticky PDF slot and progress note all come back,
   * and `task` becomes a follow-up on top of them. nSteps restarts at 0 (a
   * revival is a new run). The record returns to status 'running' through the
   * existing per-step persist hooks once execute() starts stepping.
   */
  resume?: SessionRecord;
}

export class Executor {
  private readonly navigator: NavigatorAgent;
  private readonly planner: PlannerAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  private tasks: string[] = [];
  // Mid-run user chat (Wave 3): true while execute() is stepping. index.ts
  // routes messages for a mid-run session into the queue instead of
  // addFollowUpTask.
  private midRun = false;
  constructor(
    task: string,
    taskId: string,
    browserContext: BrowserContext,
    navigatorLLM: BaseChatModel,
    extraArgs?: Partial<ExecutorExtraArgs>,
  ) {
    const messageManager = new MessageManager();

    const plannerLLM = extraArgs?.plannerLLM ?? navigatorLLM;
    const extractorLLM = extraArgs?.extractorLLM ?? navigatorLLM;
    const eventManager = new EventManager();
    const context = new AgentContext(
      taskId,
      browserContext,
      messageManager,
      eventManager,
      extraArgs?.agentOptions ?? {},
    );

    this.generalSettings = extraArgs?.generalSettings;
    const resume = extraArgs?.resume;
    if (resume) {
      // Revival: restore the saved doc store (new docs attached alongside the
      // reviving message join it, deduped by name — incoming wins), doc
      // findings, sticky PDF slot and progress memory. nSteps stays 0.
      context.attachedDocs = mergeAttachedDocs(resume.attachedDocs ?? [], extraArgs?.attachedDocs ?? []);
      context.docFindings = [...(resume.docFindings ?? [])];
      context.pdfSticky = resume.pdfSticky ? { ...resume.pdfSticky } : null;
      context.progressMemory = resume.progressMemory ?? '';
      this.tasks.push(...resume.tasks);
    } else if (extraArgs?.attachedDocs?.length) {
      context.attachedDocs = [...extraArgs.attachedDocs];
    }
    // Image-first for PDFs: filled/scanned forms carry their VALUES only in the
    // page pixels (the text layer often has just the labels), so pin page 1 of
    // the first attached PDF into the sticky slot up front. The agent then sees
    // the form image from step 1 — no need to "find" it or (mis)treat the
    // attachment as a browser tab — and view_doc swaps to other pages.
    if (context.pdfSticky === null) {
      // any document that carries page images, not only a PDF: an office file
      // attached with its own render has both parsed blocks and pages
      const firstPdf = context.attachedDocs.findIndex(d => (d.parse.pages?.length ?? 0) > 0);
      if (firstPdf >= 0) {
        context.pdfSticky = { docOrdinal: firstPdf + 1, page: 1 };
      }
    }
    this.tasks.push(task);
    // Submit guard (Wave 3): default ON — only an explicit settings opt-out
    // removes the "ask_user before irreversible actions" prompt rule.
    this.navigatorPrompt = new NavigatorPrompt(
      context.options.maxActionsPerStep,
      this.generalSettings?.askBeforeIrreversible ?? true,
    );
    this.plannerPrompt = new PlannerPrompt();

    const actionBuilder = new ActionBuilder(context, extractorLLM);
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());

    // Initialize agents with their respective prompts
    this.navigator = new NavigatorAgent(navigatorActionRegistry, {
      chatLLM: navigatorLLM,
      context: context,
      prompt: this.navigatorPrompt,
    });

    this.planner = new PlannerAgent({
      chatLLM: plannerLLM,
      context: context,
      prompt: this.plannerPrompt,
    });

    this.context = context;
    if (resume) {
      // Revival seeding: fresh CURRENT system prompt (serialized system
      // messages are dropped by buildResumeMessages), the saved transcript in
      // order, then one resume note. The doc guide and the new task land after
      // — the same order the live follow-up path produces (addAttachedDocs
      // then addFollowUpTask).
      for (const message of buildResumeMessages(resume, this.navigatorPrompt.getSystemMessage())) {
        this.context.messageManager.addMessageWithTokens(message, 'init');
      }
      this.injectDocGuideMessage();
      this.context.messageManager.addNewTask(task);
    } else {
      // Initialize message history
      this.context.messageManager.initTaskMessages(this.navigatorPrompt.getSystemMessage(), task);
      // Attached documents: the model must never start blind — inject the
      // persistent TOC + line-format guide right after the task messages.
      this.injectDocGuideMessage();
    }
  }

  /**
   * Add the doc-guide message (line-format syntax, per-doc TOC, usage
   * guidance for search_doc/read_table) to the message history. It is a
   * plain history message, so it persists for the task's lifetime and serves
   * both Planner and Navigator. The TOC itself is document-derived content
   * and travels inside an untrusted-content block.
   */
  private injectDocGuideMessage(): void {
    if (this.context.attachedDocs.length === 0) {
      return;
    }
    const guide = formatDocGuide(this.context.attachedDocs, wrapUntrustedContent);
    this.context.messageManager.addMessageWithTokens(new HumanMessage({ content: guide }), 'init');
  }

  subscribeExecutionEvents(callback: EventCallback): void {
    this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  /**
   * Add store-path documents attached to a follow-up task. The store keeps
   * earlier documents for the session; re-attaching a document with the same
   * file name replaces the earlier version.
   */
  addAttachedDocs(docs: AttachedDoc[]): void {
    this.context.attachedDocs = mergeAttachedDocs(this.context.attachedDocs, docs);
    // Re-inject the guide so the follow-up task sees the updated combined TOC
    // (index.ts calls this before addFollowUpTask, so it lands right before
    // the new task message).
    this.injectDocGuideMessage();
  }

  addFollowUpTask(task: string): void {
    this.tasks.push(task);
    this.context.messageManager.addNewTask(task);

    // need to reset previous action results that are not included in memory
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
    // The tasks array grew — snapshot so the saved record knows the follow-up.
    this.persist('running');
  }

  /**
   * Session persistence (Wave 1, save-and-die foundation): snapshot the
   * task's serializable state to IndexedDB after each step and at every
   * terminal transition. Write-only — nothing reads these records yet
   * (revival is Wave 2). Fire-and-forget: a persistence failure must never
   * throw into the agent loop.
   */
  private persist(status: SessionRecord['status']): void {
    try {
      const context = this.context;
      const record: SessionRecord = {
        sessionId: context.taskId,
        savedAt: Date.now(),
        status,
        tasks: [...this.tasks],
        transcript: serializeMessages(context.messageManager.getMessages()),
        attachedDocs: context.attachedDocs,
        docFindings: [...context.docFindings],
        pdfSticky: context.pdfSticky ? { ...context.pdfSticky } : null,
        progressMemory: context.progressMemory,
        nSteps: context.nSteps,
      };
      saveSessionRecord(record).catch(error => logger.error('persist: save failed', error));
    } catch (error) {
      logger.error('persist: snapshot failed', error);
    }
  }

  /**
   * Check if task is complete based on planner output and handle completion
   */
  private checkTaskCompletion(planOutput: AgentOutput<PlannerOutput> | null): boolean {
    if (planOutput?.result?.done) {
      logger.info('✅ Planner confirms task completion');
      if (planOutput.result.final_answer) {
        this.context.finalAnswer = planOutput.result.final_answer;
      }
      return true;
    }
    return false;
  }

  /**
   * Execute the task
   *
   * @returns {Promise<void>}
   */
  async execute(): Promise<void> {
    logger.info(`🚀 Executing task: ${this.tasks[this.tasks.length - 1]}`);
    // reset the step counter
    const context = this.context;
    context.nSteps = 0;
    // A new run always starts with a clean ask slot: the message that started
    // this run IS the answer to any previous ask_user question.
    const answeringQuestion = context.askUserPending !== null;
    context.askUserPending = null;
    context.blockedReason = null;
    // Each run reports its own answer. finalAnswer was only cleared when the
    // executor was built, so a follow-up run that finished without writing one
    // showed the previous task's answer as its own.
    context.finalAnswer = null;
    const allowedMaxSteps = this.context.options.maxSteps;

    // Plan approval fires on the FIRST plan of a run only (Claude-style:
    // approve the approach once, then let it run). Deliberately not
    // nSteps === 0 — a failed first action keeps nSteps at 0 and would
    // re-fire the gate.
    // Read the setting now, not at construction: the user may have switched the
    // mode while the task ran. A run that starts as the answer to the agent's own
    // question continues an approved plan, so it is not asked again.
    let planApprovalPending = false;
    try {
      planApprovalPending = (await generalSettingsStore.getSettings()).planApproval === true && !answeringQuestion;
    } catch {
      planApprovalPending = this.generalSettings?.planApproval === true && !answeringQuestion;
    }
    // ask_user (Wave 3): set when a step ends with a pending question — the
    // run then terminates as 'awaiting_user' instead of ok/fail/cancel/pause.
    let askedUser = false;

    this.midRun = true;
    try {
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      // Session persistence: apply the retention policy once per task start
      // (fire-and-forget; pruneSessions catches internally).
      void pruneSessions();

      let step = 0;
      let latestPlanOutput: AgentOutput<PlannerOutput> | null = null;
      let navigatorDone = false;

      for (step = 0; step < allowedMaxSteps; step++) {
        context.stepInfo = {
          stepNumber: context.nSteps,
          maxSteps: context.options.maxSteps,
        };

        logger.info(`🔄 Step ${step + 1} / ${allowedMaxSteps}`);

        // Mid-run user chat (Wave 3): messages typed while the previous step
        // ran join the conversation at this step boundary.
        await this.drainQueuedUserMessages();

        if (await this.shouldStop()) {
          break;
        }

        // Run planner periodically for guidance
        if (this.planner && (context.nSteps % context.options.planningInterval === 0 || navigatorDone)) {
          navigatorDone = false;
          latestPlanOutput = await this.runPlanner();

          // Check if task is complete after planner run — but for a web task never
          // on the very first planner run (nSteps === 0). The browser state is not
          // added to memory before that first plan, so a planner seeing only the
          // document (now with a full "Label: value" field index) can wrongly
          // conclude the values are already present and declare done. A real web
          // task always needs at least one navigation step. A question that needs
          // no web action (web_task false) is answered by that first plan.
          const answeredWithoutWeb = latestPlanOutput?.result?.web_task === false;
          if ((context.nSteps > 0 || answeredWithoutWeb) && this.checkTaskCompletion(latestPlanOutput)) {
            break;
          }

          // The planner's ask channel: a value or step only the user can give ends
          // the run awaiting their answer, exactly like the navigator's ask_user.
          const plannerQuestion = latestPlanOutput?.result?.need_user?.trim();
          if (plannerQuestion) {
            context.askUserPending = plannerQuestion;
            this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_OK, plannerQuestion);
            askedUser = true;
            break;
          }

          // Plan approval (Claude-style): surface the FIRST plan of the run
          // and hold here until the user approves (resume_task) or rejects
          // (cancel_task). The pause loop inside shouldStop() does the actual
          // waiting; later plans in the same run flow through unguarded.
          if (planApprovalPending && latestPlanOutput?.result) {
            planApprovalPending = false;
            const planDetails = latestPlanOutput.result.next_steps || latestPlanOutput.result.observation || '';
            this.context.emitEvent(Actors.PLANNER, ExecutionState.PLAN_WAIT, planDetails);
            this.context.pause();
            if (await this.shouldStop()) {
              break;
            }
          }
        }

        // Execute navigator
        navigatorDone = await this.navigate();

        // ask_user (Wave 3): the agent asked the user something — end the run
        // here as a clean terminal; the completion branch below persists it.
        if (context.askUserPending) {
          askedUser = true;
          break;
        }
        if (context.blockedReason) {
          break;
        }

        // Session persistence: snapshot after each step (save-and-die).
        this.persist('running');

        // If navigator indicates completion, the next periodic planner run will validate it
        if (navigatorDone) {
          logger.info('🔄 Navigator indicates completion - will be validated by next planner run');
        }
      }

      // Determine task completion status
      const isCompleted = latestPlanOutput?.result?.done === true;

      if (askedUser && context.askUserPending) {
        // ask_user (Wave 3): clean 'awaiting_user' terminal — deliberately no
        // TASK_OK/FAIL/CANCEL/PAUSE. Flush this step's action results into the
        // transcript now (the question must be saved before the answer — the
        // usual flush happens on the NEXT step's state build, and there is no
        // next step), snapshot as 'awaiting_user', then surface the question.
        // The executor object stays live and followupable: the user's next
        // message continues it via the live follow-up path (or the saved
        // record revives it after an MV3 service-worker restart).
        this.navigator.flushActionResultsToMemory();
        this.persist('awaiting_user');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.ASK_USER, context.askUserPending);
      } else if (context.blockedReason) {
        this.context.emitEvent(
          Actors.SYSTEM,
          ExecutionState.TASK_FAIL,
          t('exec_errors_cannotContinue', [context.blockedReason]),
        );
        this.persist('failed');
      } else if (isCompleted) {
        // Emit final answer if available, otherwise use task ID
        const finalMessage = this.context.finalAnswer || this.context.taskId;
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);
        this.persist('done');
      } else if (step >= allowedMaxSteps) {
        logger.error('❌ Task failed: Max steps reached');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));
        this.persist('failed');
      } else if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));
        this.persist('cancelled');
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));
        this.persist('cancelled');
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));
        this.persist('failed');
      }
    } finally {
      this.midRun = false;
      if (import.meta.env.DEV) {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
      // store the history only if replay is enabled
      if (this.generalSettings?.replayHistoricalTasks) {
        const historyString = JSON.stringify(this.context.history);
        logger.info(`Executor history size: ${historyString.length}`);
        await chatHistoryStore.storeAgentStepHistory(this.context.taskId, this.tasks[0], historyString);
      } else {
        logger.info('Replay historical tasks is disabled, skipping history storage');
      }
    }
  }

  /**
   * Mid-run user chat (Wave 3): true while execute() is running. The
   * background routes messages for a mid-run session into queueUserMessage
   * instead of addFollowUpTask.
   */
  isMidRun(): boolean {
    return this.midRun;
  }

  /**
   * Queue a message the user typed while the agent was running; the main loop
   * injects it into the conversation at the next step boundary.
   */
  queueUserMessage(text: string): void {
    this.context.queuedUserMessages.push(text);
  }

  /**
   * Drain the mid-run user message queue (FIFO): each message joins the agent
   * transcript as a user message and a SYSTEM notice is emitted so the user
   * SEES that it landed.
   */
  private async drainQueuedUserMessages(): Promise<void> {
    const context = this.context;
    while (context.queuedUserMessages.length > 0) {
      const text = context.queuedUserMessages.shift() as string;
      context.messageManager.addUserUpdate(text);
      await context.emitEvent(Actors.SYSTEM, ExecutionState.USER_MESSAGE, t('exec_midRun_userMessage', [text]));
      logger.info('Injected queued mid-run user message at step boundary');
    }
  }

  /**
   * Helper method to run planner and store its output
   */
  private async runPlanner(): Promise<AgentOutput<PlannerOutput> | null> {
    const context = this.context;
    try {
      // Add current browser state to memory
      let positionForPlan = 0;
      if (this.tasks.length > 1 || this.context.nSteps > 0) {
        await this.navigator.addStateMessageToMemory();
        positionForPlan = this.context.messageManager.length() - 1;
      } else {
        positionForPlan = this.context.messageManager.length();
      }

      // Execute planner
      const planOutput = await this.planner.execute();
      if (planOutput.result) {
        this.context.messageManager.addPlan(JSON.stringify(planOutput.result), positionForPlan);
      }
      return planOutput;
    } catch (error) {
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute planner: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
      return null;
    }
  }

  private async navigate(): Promise<boolean> {
    const context = this.context;
    try {
      // Get and execute navigation action
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      const navOutput = await this.navigator.execute();
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      context.nSteps++;
      if (navOutput.error) {
        throw new Error(navOutput.error);
      }
      context.consecutiveFailures = 0;
      if (navOutput.result?.done) {
        return true;
      }
    } catch (error) {
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute step: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
    }
    return false;
  }

  private async shouldStop(): Promise<boolean> {
    if (this.context.stopped) {
      logger.info('Agent stopped');
      return true;
    }

    while (this.context.paused) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.context.stopped) {
        return true;
      }
    }

    if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
      logger.error(`Stopping due to ${this.context.options.maxFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  async cancel(): Promise<void> {
    this.context.stop();
  }

  async resume(): Promise<void> {
    this.context.resume();
  }

  async pause(): Promise<void> {
    this.context.pause();
  }

  async cleanup(): Promise<void> {
    try {
      await this.context.browserContext.cleanup();
    } catch (error) {
      logger.error(`Failed to cleanup browser context: ${error}`);
    }
  }

  async getCurrentTaskId(): Promise<string> {
    return this.context.taskId;
  }

  /**
   * Replays a saved history of actions with error handling and retry logic.
   *
   * @param history - The history to replay
   * @param maxRetries - Maximum number of retries per action
   * @param skipFailures - Whether to skip failed actions or stop execution
   * @param delayBetweenActions - Delay between actions in seconds
   * @returns List of action results
   */
  async replayHistory(
    sessionId: string,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2.0,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const replayLogger = createLogger('Executor:replayHistory');

    logger.info('replay task', this.tasks[0]);

    try {
      const historyFromStorage = await chatHistoryStore.loadAgentStepHistory(sessionId);
      if (!historyFromStorage) {
        throw new Error(t('exec_replay_historyNotFound'));
      }

      const history = JSON.parse(historyFromStorage.history) as AgentStepHistory;
      if (history.history.length === 0) {
        throw new Error(t('exec_replay_historyEmpty'));
      }
      logger.debug(`🔄 Replaying history: ${JSON.stringify(history, null, 2)}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      for (let i = 0; i < history.history.length; i++) {
        const historyItem = history.history[i];

        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history step with enhanced method that handles all the logic
        const stepResults = await this.navigator.executeHistoryStep(
          historyItem,
          i,
          history.history.length,
          maxRetries,
          delayBetweenActions * 1000,
          skipFailures,
        );

        results.push(...stepResults);

        // If stopped during execution, break the loop
        if (this.context.stopped) {
          break;
        }
      }

      if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_replay_cancel'));
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, t('exec_replay_ok'));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replayLogger.error(`Replay failed: ${errorMessage}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_replay_fail', [errorMessage]));
    }

    return results;
  }
}
