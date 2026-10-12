import { describe, expect, it } from 'vitest';
import { generatePublicId, parsePublicId } from './ids.ts';

describe('public IDs', () => {
  it('generates 6 unambiguous characters', () => {
    for (let index = 0; index < 500; index += 1) {
      expect(generatePublicId()).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    }
  });

  it('normalizes user input', () => {
    expect(parsePublicId(' #p7k2qx ')).toBe('P7K2QX');
  });

  it.each(['', 'P7K2Q', 'P7K2QXX', 'P0K2QX', 'PIK2QX', 'P7K2Q!'])('rejects %j', (input) => {
    expect(parsePublicId(input)).toBeNull();
  });
});
