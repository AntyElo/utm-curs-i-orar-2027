/** Time helpers pinned to Europe/Chisinau regardless of the visitor's device timezone. */
import type { DayName, Lesson } from "@/lib/models";

export const TIMEZONE = "Europe/Chisinau";

const WEEKDAY_TO_DAY: Record<string, DayName> = {
  Monday: "Luni",
  Tuesday: "Marți",
  Wednesday: "Miercuri",
  Thursday: "Joi",
  Friday: "Vineri",
};

export const DAY_SHORT: Record<DayName, string> = { Luni: "Lu", Marți: "Ma", Miercuri: "Mi", Joi: "Jo", Vineri: "Vi" };

/**
 * Monday of a week the university counts as odd. The autumn 2026/2027 semester opens on
 * Monday 31 August 2026, which is week 1. Overridable per semester through
 * SCHEDULE_ODD_WEEK_ANCHOR and served in /api/status.
 */
export const DEFAULT_ODD_WEEK_ANCHOR = "2026-08-31";

export type WeekParityName = "odd" | "even";

export interface WeekInfo {
  /** 1-based week of the semester, counted from the anchor. */
  number: number;
  parity: WeekParityName;
  /** Weekend: the week shown is the one starting tomorrow / on Monday, not the one just ending. */
  lookingAhead: boolean;
}

const MS_PER_DAY = 86_400_000;
const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Civil date in Chișinău as whole days since the epoch, plus Monday-based weekday index. */
function chisinauDay(now: Date): { day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    day: Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))) / MS_PER_DAY,
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** "2026-08-31" as whole days since the epoch; NaN for anything unparsable. */
function anchorDay(anchor: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchor.trim());
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / MS_PER_DAY;
}

/**
 * Which week of the semester is on show. Weeks run Monday→Sunday; on Saturday and Sunday
 * the current week is over, so the schedule already shows the one that starts on Monday.
 */
export function currentWeek(anchor: string = DEFAULT_ODD_WEEK_ANCHOR, now = new Date()): WeekInfo {
  const today = chisinauDay(now);
  let start = anchorDay(anchor);
  if (!Number.isFinite(start)) start = anchorDay(DEFAULT_ODD_WEEK_ANCHOR);
  // Tolerate an anchor that is not a Monday by walking back to the Monday of its week.
  const anchorMonday = start - modulo(start - 4, 7); // 1970-01-01 was a Thursday, index 3.
  const thisMonday = today.day - today.weekday;
  const lookingAhead = today.weekday >= 5;
  const number = Math.round((thisMonday - anchorMonday) / 7) + 1 + (lookingAhead ? 1 : 0);
  return { number, parity: modulo(number, 2) === 1 ? "odd" : "even", lookingAhead };
}

/** Remainder that stays non-negative for weeks before the anchor. */
function modulo(value: number, by: number): number {
  return ((value % by) + by) % by;
}

/** The lessons that actually run on the week being shown; the faded ones do not count. */
export function lessonsThisWeek(lessons: Lesson[], parity: WeekParityName): Lesson[] {
  return lessons.filter((lesson) => !isOtherWeek(lesson, parity));
}

/** A lesson that runs on the other week – shown, but faded out. */
export function isOtherWeek(lesson: Lesson, parity: WeekParityName): boolean {
  return (lesson.week_parity === "odd" || lesson.week_parity === "even") && lesson.week_parity !== parity;
}

export const WEEK_PARITY_LABEL: Record<WeekParityName, string> = { odd: "impară", even: "pară" };

export interface LocalNow {
  day: DayName | null;
  minutes: number;
  dateLabel: string;
  timeLabel: string;
}

export function localNow(now = new Date()): LocalNow {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return {
    day: WEEKDAY_TO_DAY[get("weekday")] ?? null,
    minutes: hour * 60 + minute,
    dateLabel: new Intl.DateTimeFormat("ro-RO", { timeZone: TIMEZONE, weekday: "long", day: "numeric", month: "long" }).format(now),
    timeLabel: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ro-RO", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date).replace(",", "");
}

export type LessonStatus = "past" | "current" | "next" | "upcoming";

/** Classify today's lessons relative to the current time; only for the current day. */
export function classifyLessons(lessons: Lesson[], now: LocalNow, day: DayName): Map<string, LessonStatus> {
  const result = new Map<string, LessonStatus>();
  if (now.day !== day) return result;
  let nextAssigned = false;
  const sorted = [...lessons].sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));
  for (const lesson of sorted) {
    const start = toMinutes(lesson.start_time);
    const end = toMinutes(lesson.end_time);
    if (now.minutes >= end) result.set(lesson.id, "past");
    else if (now.minutes >= start) result.set(lesson.id, "current");
    else if (!nextAssigned) {
      result.set(lesson.id, "next");
      nextAssigned = true;
    } else result.set(lesson.id, "upcoming");
  }
  // Every lesson starting at the same time as the "next" one is also next.
  const nextLesson = sorted.find((lesson) => result.get(lesson.id) === "next");
  if (nextLesson) {
    for (const lesson of sorted) if (lesson.start_time === nextLesson.start_time && result.get(lesson.id) === "upcoming") result.set(lesson.id, "next");
  }
  return result;
}

export function dayBanner(lessons: Lesson[], now: LocalNow, day: DayName): string | null {
  if (now.day !== day) return null;
  if (lessons.length === 0) return "Nu sunt lecții programate azi";
  const statuses = classifyLessons(lessons, now, day);
  if ([...statuses.values()].includes("current")) return null;
  const next = lessons.find((lesson) => statuses.get(lesson.id) === "next");
  if (next) return `Următoarea lecție la ${next.start_time}`;
  return "Lecțiile de azi s-au încheiat";
}

export function todayBanner(lessons: Lesson[], now: LocalNow): string {
  if (lessons.length === 0) return "Nu sunt lecții programate azi";
  const statuses = classifyLessons(lessons, now, now.day);
  if ([...statuses.values()].includes("current")) return `Acum este "${statuses.get("current")}" la ${next.start_time}`;
  const next = lessons.find((lesson) => statuses.get(lesson.id) === "next");
  if (next) return `Următoarea lecție "${next.subject}" la ${next.start_time}`;
  return "Lecțiile de azi s-au încheiat";
}
