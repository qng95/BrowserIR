import { describe, expect, it } from 'vitest';

import { browserCreateSchema } from '../src/schemas.js';

describe('browser_create capture profile limits', () => {
  it('accepts a bounded high-DPI profile', () => {
    expect(
      browserCreateSchema.safeParse({
        viewport: {
          width: 1920,
          height: 1080,
          device_scale_factor: 2,
        },
      }).success,
    ).toBe(true);
  });

  it('rejects a profile whose physical pixel area can exhaust capture output', () => {
    const parsed = browserCreateSchema.safeParse({
      viewport: {
        width: 3840,
        height: 2160,
        device_scale_factor: 3,
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['viewport'],
          message: expect.stringContaining('physical-pixel'),
        }),
      );
    }
  });
});
