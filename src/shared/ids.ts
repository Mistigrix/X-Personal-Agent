import { randomInt } from 'node:crypto';

/** Unambiguous characters: no 0/O, 1/I/L or U, so IDs can be read and typed reliably. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 6;

/** Short public identifier shown to users (e.g. `P7K2QX`). Uniqueness is enforced by the database. */
export function generatePublicId(): string {
  let id = '';
  for (let index = 0; index < LENGTH; index += 1) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}

/** Normalizes user input (case, surrounding spaces, optional leading #) to a public ID, or null. */
export function parsePublicId(input: string): string | null {
  const candidate = input.trim().replace(/^#/, '').toUpperCase();
  return new RegExp(`^[${ALPHABET}]{${LENGTH}}$`).test(candidate) ? candidate : null;
}
