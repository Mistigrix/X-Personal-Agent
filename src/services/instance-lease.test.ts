import { afterEach, describe, expect, it } from 'vitest';
import { createTestServices, type TestServices } from '../../tests/helpers/services.ts';
import { createInstanceLease } from './instance-lease.ts';

const opened: TestServices[] = [];
afterEach(() => {
  for (const created of opened.splice(0)) created.handle.close();
});

function setup() {
  const s = createTestServices();
  opened.push(s);
  const lease = (owner: string) =>
    createInstanceLease({ db: s.db, clock: s.clock, ttlMs: 90_000, owner });
  return { s, first: lease('first'), second: lease('second') };
}

describe('instance lease', () => {
  it('lets only one instance hold it', () => {
    const { s, first, second } = setup();
    expect(first.tryAcquire()).toEqual({ acquired: true });
    expect(second.tryAcquire()).toEqual({
      acquired: false,
      heldUntil: new Date(s.clock.now().getTime() + 90_000),
    });
    expect(first.renew()).toBe(true);
  });

  it('can be taken over once it expires (crashed instance)', () => {
    const { s, first, second } = setup();
    first.tryAcquire();
    s.clock.advance(90_001);
    expect(second.tryAcquire()).toEqual({ acquired: true });
    expect(first.renew()).toBe(false);
  });

  it('is released only by its owner', () => {
    const { first, second } = setup();
    first.tryAcquire();
    second.release();
    expect(second.tryAcquire().acquired).toBe(false);
    first.release();
    expect(second.tryAcquire().acquired).toBe(true);
  });
});
