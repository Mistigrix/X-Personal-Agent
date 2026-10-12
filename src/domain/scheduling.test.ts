import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  findInfeasibleWindow,
  findNextFreeSlot,
  type ScheduleRules,
  type Slot,
  slotsForDate,
  upcomingSlots,
} from './scheduling.ts';

const SALT = 'test-salt-0123456789';

const RULES: ScheduleRules = {
  timezone: 'Africa/Abidjan',
  postsPerDay: 3,
  activeDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  windows: [
    { start: '08:00', end: '09:30' },
    { start: '12:30', end: '14:00' },
    { start: '18:30', end: '20:30' },
  ],
  minGapMinutes: 90,
};

const localTime = (slot: Slot, zone = RULES.timezone) =>
  DateTime.fromJSDate(slot.at, { zone }).toFormat('HH:mm');

function datesFrom(start: string, days: number): string[] {
  return Array.from(
    { length: days },
    (_, offset) => DateTime.fromISO(start).plus({ days: offset }).toISODate() ?? '',
  );
}

describe('slotsForDate', () => {
  it('places one slot inside each window, with stable keys', () => {
    const slots = slotsForDate('2026-10-12', RULES, SALT);
    expect(slots.map((slot) => slot.key)).toEqual(['2026-10-12#0', '2026-10-12#1', '2026-10-12#2']);
    slots.forEach((slot, index) => {
      const window = RULES.windows[index];
      expect(localTime(slot) >= (window?.start ?? '')).toBe(true);
      expect(localTime(slot) <= (window?.end ?? '')).toBe(true);
    });
  });

  it('is deterministic for a given install and date', () => {
    expect(slotsForDate('2026-10-12', RULES, SALT)).toEqual(
      slotsForDate('2026-10-12', RULES, SALT),
    );
  });

  it('varies from day to day and between installs', () => {
    const times = datesFrom('2026-10-12', 14).map((date) =>
      localTime(slotsForDate(date, RULES, SALT)[0] as Slot),
    );
    expect(new Set(times).size).toBeGreaterThan(5);
    const otherInstall = slotsForDate('2026-10-12', RULES, 'another-salt-987654321');
    expect(otherInstall.map((slot) => slot.at)).not.toEqual(
      slotsForDate('2026-10-12', RULES, SALT).map((slot) => slot.at),
    );
  });

  it('always keeps the minimum gap, even with tight windows', () => {
    const tight: ScheduleRules = {
      ...RULES,
      windows: [
        { start: '08:00', end: '08:30' },
        { start: '09:00', end: '09:30' },
        { start: '10:00', end: '10:30' },
      ],
      minGapMinutes: 60,
    };
    for (const date of datesFrom('2026-01-01', 365)) {
      const slots = slotsForDate(date, tight, SALT);
      expect(slots).toHaveLength(3);
      for (let index = 1; index < slots.length; index += 1) {
        const gap =
          ((slots[index]?.at.getTime() ?? 0) - (slots[index - 1]?.at.getTime() ?? 0)) / 60_000;
        expect(gap).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it('uses only the first postsPerDay windows', () => {
    expect(slotsForDate('2026-10-12', { ...RULES, postsPerDay: 2 }, SALT)).toHaveLength(2);
  });

  it('returns no slot on inactive days', () => {
    // 2026-10-17 is a Saturday.
    expect(
      slotsForDate(
        '2026-10-17',
        { ...RULES, activeDays: ['mon', 'tue', 'wed', 'thu', 'fri'] },
        SALT,
      ),
    ).toEqual([]);
  });

  it('follows local wall-clock time across daylight saving changes', () => {
    const paris: ScheduleRules = {
      ...RULES,
      timezone: 'Europe/Paris',
      postsPerDay: 1,
      windows: [{ start: '08:00', end: '08:01' }],
    };
    // Paris switches to summer time (UTC+2) on 2026-03-29.
    const before = slotsForDate('2026-03-28', paris, SALT)[0];
    const after = slotsForDate('2026-03-29', paris, SALT)[0];
    expect(before?.at.getUTCHours()).toBe(7);
    expect(after?.at.getUTCHours()).toBe(6);
  });
});

describe('upcomingSlots and findNextFreeSlot', () => {
  const now = new Date('2026-10-12T13:00:00Z'); // Monday 13:00 in Abidjan

  it('only yields slots strictly after the given time', () => {
    const slots = [...upcomingSlots(now, RULES, SALT, 2)];
    expect(slots.every((slot) => slot.at.getTime() > now.getTime())).toBe(true);
    expect(slots[0]?.localDate).toBe('2026-10-12');
    expect(slots.map((slot) => slot.at.getTime())).toEqual(
      [...slots.map((slot) => slot.at.getTime())].sort((a, b) => a - b),
    );
  });

  it('skips taken slots', () => {
    const [first, second] = [...upcomingSlots(now, RULES, SALT, 2)];
    expect(findNextFreeSlot(now, new Set(), RULES, SALT)?.key).toBe(first?.key);
    expect(findNextFreeSlot(now, new Set([first?.key ?? '']), RULES, SALT)?.key).toBe(second?.key);
  });

  it('returns null when every slot within the horizon is taken', () => {
    const taken = new Set([...upcomingSlots(now, RULES, SALT, 1)].map((slot) => slot.key));
    expect(findNextFreeSlot(now, taken, RULES, SALT, 1)).toBeNull();
  });
});

describe('findInfeasibleWindow', () => {
  it('accepts windows that can keep the gap', () => {
    expect(findInfeasibleWindow(RULES.windows, 3, 90)).toBeNull();
  });

  it('reports the first window that cannot keep the gap', () => {
    const windows = [
      { start: '08:00', end: '09:00' },
      { start: '09:00', end: '10:00' },
      { start: '10:00', end: '10:30' },
    ];
    // Earliest times with a 90-minute gap: 08:00, 09:30, then 11:00 > 10:30.
    expect(findInfeasibleWindow(windows, 3, 90)).toBe(2);
    expect(findInfeasibleWindow(windows, 2, 90)).toBeNull();
    expect(findInfeasibleWindow(windows, 3, 60)).toBeNull();
  });
});
