import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import MessageManager, { MessageManagerSettings } from '../service';

// ---------------------------------------------------------------------------
// Trim direction. cutMessages() used to truncate the LAST message, so a long
// run blinded itself: stale action logs survived while the page the agent was
// about to act on got chopped. It now drops oldest step history first and only
// falls back to truncating the newest message when nothing else is left.
// ---------------------------------------------------------------------------

const STATE = '[Current state starts here] the live page';

function textOf(message: { content: unknown }): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

/** Init block + `steps` action results + the current-state message. */
function seeded(steps: number): MessageManager {
  const manager = new MessageManager(new MessageManagerSettings({ maxInputTokens: 1_000_000 }));
  manager.initTaskMessages(new SystemMessage('you are an agent'), 'fill the form');
  for (let i = 0; i < steps; i++) {
    manager.addMessageWithTokens(new HumanMessage(`Action result: step ${i} did a thing`));
  }
  manager.addStateMessage(new HumanMessage(STATE));
  return manager;
}

/** Budget that forces history out but still fits init + the state message. */
function budgetLeavingNoHistory(): number {
  return seeded(0).getTotalTokens();
}

describe('cutMessages', () => {
  it('drops old history and leaves the newest observation untouched', () => {
    const manager = new MessageManager(new MessageManagerSettings({ maxInputTokens: budgetLeavingNoHistory() }));
    manager.initTaskMessages(new SystemMessage('you are an agent'), 'fill the form');
    for (let i = 0; i < 6; i++) {
      manager.addMessageWithTokens(new HumanMessage(`Action result: step ${i} did a thing`));
    }
    manager.addStateMessage(new HumanMessage(STATE));

    manager.cutMessages();

    const texts = manager.getMessages().map(textOf);
    expect(texts[texts.length - 1]).toBe(STATE); // not truncated
    expect(texts.some(t => t.includes('step 0 did a thing'))).toBe(false); // oldest went first
  });

  it('keeps the init block: task and history marker survive a full squeeze', () => {
    const manager = new MessageManager(new MessageManagerSettings({ maxInputTokens: budgetLeavingNoHistory() }));
    manager.initTaskMessages(new SystemMessage('you are an agent'), 'fill the form');
    for (let i = 0; i < 6; i++) {
      manager.addMessageWithTokens(new HumanMessage(`Action result: step ${i} did a thing`));
    }
    manager.addStateMessage(new HumanMessage(STATE));

    manager.cutMessages();

    const texts = manager.getMessages().map(textOf);
    expect(texts.some(t => t.includes('fill the form'))).toBe(true);
    expect(texts.some(t => t.includes('[Your task history memory starts here]'))).toBe(true);
  });

  it('drops a model output together with its placeholder tool response', () => {
    const manager = new MessageManager(new MessageManagerSettings({ maxInputTokens: budgetLeavingNoHistory() }));
    manager.initTaskMessages(new SystemMessage('you are an agent'), 'fill the form');
    manager.addModelOutput({ action: [{ click_element: { index: 1 } }] });
    manager.addMessageWithTokens(new HumanMessage('Action result: clicked'));
    manager.addStateMessage(new HumanMessage(STATE));

    manager.cutMessages();

    // No orphaned tool response: every ToolMessage still has its AIMessage call.
    const seenCallIds = new Set<string>();
    for (const m of manager.getMessages()) {
      if (m instanceof AIMessage) for (const c of m.tool_calls ?? []) seenCallIds.add(String(c.id));
      if (m instanceof ToolMessage) expect(seenCallIds.has(String(m.tool_call_id))).toBe(true);
    }
  });

  it('does nothing when the history already fits', () => {
    const manager = seeded(3);
    const before = manager.getMessages().map(textOf);
    manager.cutMessages();
    expect(manager.getMessages().map(textOf)).toEqual(before);
  });
});
