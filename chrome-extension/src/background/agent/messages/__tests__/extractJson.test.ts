import { describe, expect, it } from 'vitest';
import { extractFirstJson, extractJsonFromModelOutput } from '../utils';

/**
 * Regression tests for the structured-output parse hardening: gpt-5.5's
 * navigator responses arrived as "{valid json}\n<extra prose or a second
 * object>", which broke the whole-string JSON.parse with V8's "Unexpected
 * non-whitespace character after JSON at position …" and (because the old
 * recovery path sniffed for 'is not valid JSON') killed the step entirely.
 */
describe('extractFirstJson', () => {
  it('parses a plain object', () => {
    expect(extractFirstJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('tolerates trailing prose after the object (the gpt-5.5 failure)', () => {
    const blob =
      '{"current_state":{"next_goal":"search"},"action":[{"go_to_url":{"url":"https://map.kakao.com"}}]}\nI opened the map as requested.';
    const parsed = extractFirstJson(blob) as { action: unknown[] };
    expect(parsed.action).toHaveLength(1);
  });

  it('returns the FIRST object when two objects are concatenated', () => {
    expect(extractFirstJson('{"a":1}\n{"b":2}')).toEqual({ a: 1 });
  });

  it('tolerates leading prose before the object', () => {
    expect(extractFirstJson('Here is the result:\n{"a":1} thanks')).toEqual({ a: 1 });
  });

  it('is not fooled by braces and escaped quotes inside strings', () => {
    const blob = '{"a":"b } { \\" c","d":2} trailing';
    expect(extractFirstJson(blob)).toEqual({ a: 'b } { " c', d: 2 });
  });

  it('skips a non-parsing balanced span and finds a later object', () => {
    expect(extractFirstJson('{oops not json} {"a":1}')).toEqual({ a: 1 });
  });

  it('returns undefined when there is no object', () => {
    expect(extractFirstJson('no json here')).toBeUndefined();
    expect(extractFirstJson('[1,2,3]')).toBeUndefined();
  });
});

describe('extractJsonFromModelOutput — trailing-garbage fallback', () => {
  it('still parses clean JSON', () => {
    expect(extractJsonFromModelOutput('{"a":1}')).toEqual({ a: 1 });
  });

  it('recovers when prose follows the JSON', () => {
    expect(extractJsonFromModelOutput('{"a":1}\nDone.')).toEqual({ a: 1 });
  });

  it('recovers inside a code fence with a trailing note after the object', () => {
    expect(extractJsonFromModelOutput('```json\n{"a":1}\nnote\n```')).toEqual({ a: 1 });
  });

  it('throws when nothing parseable exists', () => {
    expect(() => extractJsonFromModelOutput('total garbage')).toThrow();
  });
});
