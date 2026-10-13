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

describe('review and idea payloads', () => {
  it.each(['approve', 'edit', 'regenerate', 'reject'] as const)('round-trips %s', (action) => {
    const payload = { action, publicId: 'P7K2QX', version: 3 };
    expect(decodeCallback(encodeCallback(payload))).toEqual(payload);
  });

  it('encodes idea drafting without a version', () => {
    expect(encodeCallback({ action: 'draftIdea', ideaId: 'K7Q2ZP' })).toBe('d:K7Q2ZP');
    expect(decodeCallback('d:K7Q2ZP')).toEqual({ action: 'draftIdea', ideaId: 'K7Q2ZP' });
    expect(decodeCallback('d:K7Q2ZP:1')).toBeNull();
    expect(decodeCallback('a:P7K2QX')).toBeNull();
  });
});
