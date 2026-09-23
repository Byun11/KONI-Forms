import { describe, it, expect } from 'vitest';
import MessageManager from '../service';
import { USER_REQUEST_TAG_START, USER_REQUEST_TAG_END } from '../utils';

// ---------------------------------------------------------------------------
// Mid-run user chat (Wave 3): messages typed while the agent runs are queued
// (AgentContext.queuedUserMessages) and drained FIFO at the next step boundary
// into MessageManager.addUserUpdate. These tests cover the message shape and
// the drain-order invariant (the executor's drain loop is a shift() loop over
// the same array shape used here).
// ---------------------------------------------------------------------------

function textOf(message: { content: unknown }): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

describe('Mid-run user chat - addUserUpdate', () => {
  it('wraps the text as a user request and keeps the ultimate task unchanged', () => {
    const manager = new MessageManager();
    manager.addUserUpdate('use the second search result');

    const messages = manager.getMessages();
    expect(messages).toHaveLength(1);
    const text = textOf(messages[0]);
    expect(text).toContain(USER_REQUEST_TAG_START);
    expect(text).toContain(USER_REQUEST_TAG_END);
    expect(text).toContain('use the second search result');
    expect(text).toContain('User message (mid-task):');
    expect(text).toContain('The ultimate task is unchanged');
  });

  it('queue drain preserves FIFO order', () => {
    const manager = new MessageManager();
    const queue = ['first message', 'second message', 'third message'];

    // Same drain shape as Executor.drainQueuedUserMessages: shift until empty.
    while (queue.length > 0) {
      manager.addUserUpdate(queue.shift() as string);
    }

    const texts = manager.getMessages().map(textOf);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('first message');
    expect(texts[1]).toContain('second message');
    expect(texts[2]).toContain('third message');
    expect(queue).toHaveLength(0);
  });
});
