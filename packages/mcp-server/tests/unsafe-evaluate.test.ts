import { describe, expect, it } from 'vitest';

import { redactUnsafeEvaluationValue } from '../src/unsafe-evaluate.js';

describe('unsafe evaluation result redaction', () => {
  it('redacts credential keys, token-shaped strings, and sensitive URL components', () => {
    const result = redactUnsafeEvaluationValue({
      password: 'plain-secret',
      nested: {
        session_token: 'session-secret',
        safe: 'customer-42',
      },
      authorization: 'Bearer token-that-must-not-survive',
      url: 'https://user:pass@example.test/customer?token=url-secret&tab=history',
    });
    const encoded = JSON.stringify(result.value);

    expect(result.redactionCount).toBeGreaterThanOrEqual(4);
    expect(encoded).not.toContain('plain-secret');
    expect(encoded).not.toContain('session-secret');
    expect(encoded).not.toContain('token-that-must-not-survive');
    expect(encoded).not.toContain('url-secret');
    expect(encoded).toContain('customer-42');
    expect(encoded).toContain('tab=history');
  });

  it('preserves dangerous-looking JSON keys as data without changing prototypes', () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"safe":"value"}}',
    ) as { [key: string]: never };
    const result = redactUnsafeEvaluationValue(input);
    const value = result.value as Record<string, unknown>;

    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(value.__proto__).toEqual({ polluted: true });
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});
