import { describe, expect, it } from 'vitest';
import { classifyFingerprint, FINGERPRINT_HISTORY } from '../util';

/**
 * A click that changes nothing and a click that toggles the page back to where
 * it started both leave the agent repeating itself; only the first is visible
 * to a plain before/after comparison.
 */
describe('classifyFingerprint', () => {
  it('reports a click that left the page identical', () => {
    const history = ['A'];
    expect(classifyFingerprint(history, 'A')).toEqual({ unchanged: true, revisited: false });
  });

  it('reports a toggle that returned to an earlier state', () => {
    const history = ['A', 'B'];
    expect(classifyFingerprint(history, 'A')).toEqual({ unchanged: false, revisited: true });
  });

  it('stays quiet while the page keeps moving forward', () => {
    const history = ['A', 'B', 'C'];
    expect(classifyFingerprint(history, 'D')).toEqual({ unchanged: false, revisited: false });
  });

  it('forgets states that fell out of the window', () => {
    const history: string[] = [];
    for (let i = 0; i <= FINGERPRINT_HISTORY; i += 1) {
      classifyFingerprint(history, `state-${i}`);
    }
    expect(history).toHaveLength(FINGERPRINT_HISTORY);
    expect(classifyFingerprint(history, 'state-0')).toEqual({ unchanged: false, revisited: false });
  });

  it('ignores an empty fingerprint rather than recording it as a state', () => {
    const history = ['A'];
    expect(classifyFingerprint(history, '')).toEqual({ unchanged: false, revisited: false });
    expect(history).toEqual(['A']);
    expect(classifyFingerprint(history, 'A')).toEqual({ unchanged: true, revisited: false });
  });
});
