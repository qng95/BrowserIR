import { describe, expect, it } from 'vitest';

import { sanitizeModelFacingUrl } from '../src/index.js';

describe('sanitizeModelFacingUrl', () => {
  it('redacts userinfo and credential parameters without losing route context', () => {
    const sanitized = sanitizeModelFacingUrl(
      'https://user:password@example.test/customers?code=secret&tab=history&X-Amz-Signature=signed#access_token=fragment&view=detail',
    );

    expect(sanitized).not.toContain('user');
    expect(sanitized).not.toContain('password');
    expect(sanitized).not.toContain('secret');
    expect(sanitized).not.toContain('signed');
    expect(sanitized).not.toContain('fragment');
    expect(sanitized).toContain('/customers');
    expect(sanitized).toContain('tab=history');
    expect(sanitized).toContain('view=detail');
    expect(sanitized.match(/%5BREDACTED%5D/g)).toHaveLength(3);
  });

  it('preserves hash routes while redacting their sensitive query values', () => {
    expect(
      sanitizeModelFacingUrl(
        'https://example.test/#/orders/42?session=secret&panel=items',
      ),
    ).toBe(
      'https://example.test/#/orders/42?session=%5BREDACTED%5D&panel=items',
    );
  });

  it('does not echo malformed or non-HTTP URLs into model context', () => {
    expect(sanitizeModelFacingUrl('not a URL with a secret')).toBe(
      '[unavailable URL]',
    );
    expect(sanitizeModelFacingUrl('data:text/plain,secret')).toBe(
      'data:[REDACTED]',
    );
    expect(sanitizeModelFacingUrl('about:blank')).toBe('about:blank');
  });
});
