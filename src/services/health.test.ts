import { afterEach, describe, expect, it } from 'vitest';
import { createTestServices, type TestServices } from '../../tests/helpers/services.ts';
import { checkHealth } from './health.ts';
import { createInstanceLease } from './instance-lease.ts';

const opened: TestServices[] = [];
afterEach(() => {
  for (const created of opened.splice(0)) created.handle.close();
});

describe('checkHealth', () => {
  it('is healthy only while the lease is being renewed', () => {
    const s = createTestServices();
    opened.push(s);
    expect(checkHealth(s.db, s.clock.now())).toMatchObject({
      healthy: false,
      detail: expect.stringContaining('No running agent'),
    });

    const lease = createInstanceLease({ db: s.db, clock: s.clock, ttlMs: 90_000 });
    lease.tryAcquire();
    expect(checkHealth(s.db, s.clock.now()).healthy).toBe(true);

    s.clock.advance(91_000);
    expect(checkHealth(s.db, s.clock.now())).toMatchObject({
      healthy: false,
      detail: expect.stringContaining('stuck or stopped'),
    });
    lease.renew();
    expect(checkHealth(s.db, s.clock.now()).healthy).toBe(true);
  });
});
