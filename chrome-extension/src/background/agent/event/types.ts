export enum Actors {
  SYSTEM = 'system',
  USER = 'user',
  PLANNER = 'planner',
  NAVIGATOR = 'navigator',
}

export enum EventType {
  /**
   * Type of events that can be subscribed to.
   *
   * For now, only execution events are supported.
   */
  EXECUTION = 'execution',
}

export enum ExecutionState {
  /**
   * States representing different phases in the execution lifecycle.
   *
   * Format: <SCOPE>.<STATUS>
   * Scopes: task, step, act
   * Statuses: start, ok, fail, cancel
   *
   * Examples:
   *     TASK_OK = "task.ok"  // Task completed successfully
   *     STEP_FAIL = "step.fail"  // Step failed
   *     ACT_START = "act.start"  // Action started
   */
  // Task level states
  TASK_START = 'task.start',
  TASK_OK = 'task.ok',
  TASK_FAIL = 'task.fail',
  TASK_PAUSE = 'task.pause',
  TASK_RESUME = 'task.resume',
  TASK_CANCEL = 'task.cancel',

  // Step level states
  STEP_START = 'step.start',
  STEP_OK = 'step.ok',
  STEP_FAIL = 'step.fail',
  STEP_CANCEL = 'step.cancel',

  // Plan approval: the planner produced a plan and execution is paused
  // until the user approves (resume_task) or rejects (cancel_task).
  PLAN_WAIT = 'plan.wait',

  // ask_user (Wave 3): the agent asked the user a question and the run ended
  // as a clean 'awaiting_user' terminal (not ok/fail/cancel/pause) — details
  // carries the question; the typed answer continues the session.
  ASK_USER = 'task.ask',

  // Mid-run user chat (Wave 3): a message typed while the agent was running
  // was injected into the conversation at a step boundary — details carries
  // the confirmation notice shown to the user.
  USER_MESSAGE = 'task.user_message',

  // Action/Tool level states
  ACT_START = 'act.start',
  ACT_OK = 'act.ok',
  ACT_FAIL = 'act.fail',
}

export interface EventData {
  /** Data associated with an event */
  taskId: string;
  /** step is the step number of the task where the event occurred */
  step: number;
  /** max_steps is the maximum number of steps in the task */
  maxSteps: number;
  /** details is the content of the event */
  details: string;
  /** actionName is the name of the action that triggered the event */
  actionName?: string;
  /** actionIndex is the 0-based index of the action within the current batch */
  actionIndex?: number;
  /** actionCount is the total number of actions in the current batch */
  actionCount?: number;
}

export class AgentEvent {
  /**
   * Represents a state change event in the task execution system.
   * Each event has a type, a specific state that changed,
   * the actor that triggered the change, and associated data.
   */
  constructor(
    public actor: Actors,
    public state: ExecutionState,
    public data: EventData,
    public timestamp: number = Date.now(),
    public type: EventType = EventType.EXECUTION,
  ) {}
}

// The type of callback for event subscribers
export type EventCallback = (event: AgentEvent) => Promise<void>;
