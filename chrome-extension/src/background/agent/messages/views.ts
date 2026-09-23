import { type BaseMessage, AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';

export class MessageMetadata {
  tokens: number;
  message_type: string | null = null;

  constructor(tokens: number, message_type?: string | null) {
    this.tokens = tokens;
    this.message_type = message_type ?? null;
  }
}

export class ManagedMessage {
  message: BaseMessage;
  metadata: MessageMetadata;

  constructor(message: BaseMessage, metadata: MessageMetadata) {
    this.message = message;
    this.metadata = metadata;
  }
}

export class MessageHistory {
  messages: ManagedMessage[] = [];
  totalTokens = 0;

  addMessage(message: BaseMessage, metadata: MessageMetadata, position?: number): void {
    const managedMessage: ManagedMessage = {
      message,
      metadata,
    };

    if (position === undefined) {
      this.messages.push(managedMessage);
    } else {
      this.messages.splice(position, 0, managedMessage);
    }
    this.totalTokens += metadata.tokens;
  }

  removeMessage(index = -1): void {
    if (this.messages.length > 0) {
      const msg = this.messages.splice(index, 1)[0];
      this.totalTokens -= msg.metadata.tokens;
    }
  }

  /**
   * Removes the last message from the history if it is a human message.
   * This is used to remove the state message from the history.
   */
  removeLastStateMessage(): void {
    if (this.messages.length > 2 && this.messages[this.messages.length - 1].message instanceof HumanMessage) {
      const msg = this.messages.pop();
      if (msg) {
        this.totalTokens -= msg.metadata.tokens;
      }
    }
  }

  /**
   * Get all messages
   */
  getMessages(): BaseMessage[] {
    return this.messages.map(m => m.message);
  }

  /**
   * Get total tokens in history
   */
  getTotalTokens(): number {
    return this.totalTokens;
  }

  /**
   * Drops the oldest step-history message so the newest observation survives a
   * token squeeze. 'init' messages (system prompt, task, doc guide, history
   * marker) and the final message are never touched — the final message is the
   * page the agent is looking at right now, which is the last thing worth
   * losing.
   *
   * A model output is stored as an AIMessage carrying tool_calls followed by a
   * placeholder ToolMessage; the pair is dropped together, since an orphaned
   * tool_call is rejected by the OpenAI-shaped APIs.
   *
   * @returns tokens freed, or 0 if there is nothing left to drop
   */
  dropOldestStepMessage(): number {
    const last = this.messages.length - 1;
    for (let i = 0; i < last; i++) {
      const { message, metadata } = this.messages[i];
      if (metadata.message_type === 'init' || message instanceof SystemMessage) continue;

      const isToolCall = message instanceof AIMessage && (message.tool_calls?.length ?? 0) > 0;
      const count = isToolCall && this.messages[i + 1]?.message instanceof ToolMessage ? 2 : 1;
      const freed = this.messages.slice(i, i + count).reduce((n, m) => n + m.metadata.tokens, 0);
      this.messages.splice(i, count);
      this.totalTokens -= freed;
      return freed;
    }
    return 0;
  }
}
