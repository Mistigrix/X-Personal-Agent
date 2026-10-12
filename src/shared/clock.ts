/** Source of the current time, injected so time-dependent logic can be tested. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
