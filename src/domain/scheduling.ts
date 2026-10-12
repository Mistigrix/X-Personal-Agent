/**
 * Publication slots: pure, timezone-aware and deterministic.
 *
 * Each active day gets one slot inside each of the first `postsPerDay` windows.
 * The time inside a window is derived from a per-install salt, the local date and
 * the window index, so slots vary from day to day but are stable across restarts
 * without being stored. Consecutive slots are always `minGapMinutes` apart.
 */
import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface TimeWindow {
  /** Local time, `HH:mm`. */
  start: string;
  /** Local time, `HH:mm`, after `start` (windows do not cross midnight). */
  end: string;
}

export interface ScheduleRules {
  timezone: string;
  postsPerDay: number;
  activeDays: readonly Weekday[];
  windows: readonly TimeWindow[];
  minGapMinutes: number;
}

export interface Slot {
  /** Stable identity, e.g. `2026-10-14#1`. At most one post can hold a slot. */
  key: string;
  /** Local date (ISO) in the schedule's timezone. */
  localDate: string;
  /** Window index. */
  index: number;
  at: Date;
}

/** Minutes since local midnight for a validated `HH:mm` string. */
export function minutesOfDay(time: string): number {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Index of the first window (among the first `postsPerDay`) that cannot hold a
 * slot while keeping `minGapMinutes` after the previous one, or null if all fit.
 */
export function findInfeasibleWindow(
  windows: readonly TimeWindow[],
  postsPerDay: number,
  minGapMinutes: number,
): number | null {
  let previous: number | undefined;
  for (const [index, window] of windows.slice(0, postsPerDay).entries()) {
    const earliest = Math.max(
      minutesOfDay(window.start),
      previous === undefined ? 0 : previous + minGapMinutes,
    );
    if (earliest > minutesOfDay(window.end)) return index;
    previous = earliest;
  }
  return null;
}

/** All slots of one local date (empty on inactive days). */
export function slotsForDate(localDate: string, rules: ScheduleRules, salt: string): Slot[] {
  const day = DateTime.fromISO(localDate, { zone: rules.timezone });
  if (!day.isValid) throw new Error(`Invalid local date: ${localDate}`);
  const weekday = WEEKDAYS[day.weekday - 1];
  if (weekday === undefined || !rules.activeDays.includes(weekday)) return [];

  const windows = rules.windows.slice(0, rules.postsPerDay).map((window) => ({
    start: minutesOfDay(window.start),
    end: minutesOfDay(window.end),
  }));

  // Latest minute each slot may take while leaving room for the following slots.
  const latest: number[] = [];
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    const window = windows[index];
    if (!window) continue;
    const next = latest[index + 1];
    latest[index] =
      next === undefined ? window.end : Math.min(window.end, next - rules.minGapMinutes);
  }

  const slots: Slot[] = [];
  let previous: number | undefined;
  windows.forEach((window, index) => {
    const earliest =
      previous === undefined
        ? window.start
        : Math.max(window.start, previous + rules.minGapMinutes);
    const upper = latest[index] ?? window.end;
    if (earliest > upper) return; // impossible with a validated configuration

    const minute = earliest + Math.floor(jitter(salt, localDate, index) * (upper - earliest + 1));
    previous = minute;
    const at = day.set({
      hour: Math.floor(minute / 60),
      minute: minute % 60,
      second: 0,
      millisecond: 0,
    });
    slots.push({ key: `${localDate}#${index}`, localDate, index, at: at.toJSDate() });
  });
  return slots;
}

/** Slots strictly after `from`, in chronological order, up to `horizonDays` local days ahead. */
export function* upcomingSlots(
  from: Date,
  rules: ScheduleRules,
  salt: string,
  horizonDays = 366,
): Generator<Slot> {
  let day = DateTime.fromJSDate(from, { zone: rules.timezone }).startOf('day');
  for (let offset = 0; offset < horizonDays; offset += 1) {
    const localDate = day.toISODate();
    if (localDate === null) return;
    for (const slot of slotsForDate(localDate, rules, salt)) {
      if (slot.at.getTime() > from.getTime()) yield slot;
    }
    day = day.plus({ days: 1 });
  }
}

/** The earliest upcoming slot not already taken, or null if none within the horizon. */
export function findNextFreeSlot(
  from: Date,
  takenKeys: ReadonlySet<string>,
  rules: ScheduleRules,
  salt: string,
  horizonDays = 366,
): Slot | null {
  for (const slot of upcomingSlots(from, rules, salt, horizonDays)) {
    if (!takenKeys.has(slot.key)) return slot;
  }
  return null;
}

/** Deterministic value in [0, 1) for a given install, date and window. */
function jitter(salt: string, localDate: string, index: number): number {
  const digest = createHash('sha256').update(`${salt}|${localDate}|${index}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}
