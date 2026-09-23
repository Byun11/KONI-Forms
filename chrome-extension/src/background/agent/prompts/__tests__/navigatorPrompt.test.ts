import { describe, it, expect } from 'vitest';
import {
  buildNavigatorSystemPrompt,
  irreversibleActionRule,
  navigatorSystemPromptTemplate,
} from '../templates/navigator';

// ---------------------------------------------------------------------------
// Submit guard (Wave 3): the irreversible-action rule block is included in the
// navigator system prompt when askBeforeIrreversible is ON and omitted when
// it's off — with no leftover template placeholders either way.
// ---------------------------------------------------------------------------

describe('Navigator system prompt - irreversible-action rule', () => {
  it('template carries the {{irreversible_rule}} placeholder', () => {
    expect(navigatorSystemPromptTemplate).toContain('{{irreversible_rule}}');
  });

  it('includes the rule block when askBeforeIrreversible is true', () => {
    const prompt = buildNavigatorSystemPrompt(10, true);
    expect(prompt).toContain('13. Irreversible actions:');
    expect(prompt).toContain('you MUST call ask_user and wait');
    expect(prompt).toContain(irreversibleActionRule.trim());
  });

  it('omits the rule block when askBeforeIrreversible is false', () => {
    const prompt = buildNavigatorSystemPrompt(10, false);
    expect(prompt).not.toContain('Irreversible actions');
    expect(prompt).not.toContain('ask_user and wait');
  });

  it('leaves no unresolved placeholders in either mode', () => {
    for (const enabled of [true, false]) {
      const prompt = buildNavigatorSystemPrompt(7, enabled);
      expect(prompt).not.toContain('{{irreversible_rule}}');
      expect(prompt).not.toContain('{{max_actions}}');
      expect(prompt).toContain('Use maximum 7 actions per sequence');
    }
  });
});
