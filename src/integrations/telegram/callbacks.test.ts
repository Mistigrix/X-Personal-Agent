import { describe, expect, it } from 'vitest';
import { decodeCallback, encodeCallback } from './callbacks.ts';

describe('callback payloads', () => {
  it('round-trips and fits in Telegram 64-byte limit', () => {
    const payload = { action: 'queue', publicId: 'P7K2QX', version: 12 } as const;
    const data = encodeCallback(payload);
    expect(data).toBe('q:P7K2QX:12');
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(decodeCallback(data)).toEqual(payload);
    expect(decodeCallback(encodeCallback({ ...payload, action: 'discard' }))?.action).toBe(
      'discard',
    );
  });

  it.each([
    '',
    'q',
    'q:P7K2QX',
    'z:P7K2QX:1',
    'q:BAD:1',
    'q:P7K2QX:0',
    'q:P7K2QX:1.5',
    'q:P7K2QX:1:x',
  ])('rejects %j', (data) => {
    expect(decodeCallback(data)).toBeNull();
  });
});
