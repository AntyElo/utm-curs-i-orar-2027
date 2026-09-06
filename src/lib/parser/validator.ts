/**
 * Stage 9: sanity checks. A parse that fails here must never replace the
 * production dataset. Returns structured problems instead of throwing so the
 * caller can log and decide.
 */
import { config } from "@/lib/config";
import { DAY_NAMES, ScheduleSchema, type Schedule } from "@/lib/models";
import { timeToMinutes } from "./normalizer";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface ValidationContext {
  /** Lesson count of the currently served schedule, when one exists. */
  previousLessonCount?: number | null;
}

export function validateSchedule(schedule: Schedule, context: ValidationContext = {}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const schemaCheck = ScheduleSchema.safeParse(schedule);
  if (!schemaCheck.success) {
    errors.push(`schema: ${schemaCheck.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  }

  if (schedule.groups.length < config.minGroups) {
    errors.push(`only ${schedule.groups.length} groups detected (min ${config.minGroups})`);
  }

  const missingDays = DAY_NAMES.filter((day) => !schedule.days.includes(day));
  if (missingDays.length > 0) errors.push(`missing day blocks: ${missingDays.join(", ")}`);

  if (schedule.lessons.length < config.minLessons) {
    errors.push(`only ${schedule.lessons.length} lessons parsed (min ${config.minLessons})`);
  }

  if (schedule.time_slots.length < 4) errors.push(`only ${schedule.time_slots.length} time slots detected`);

  const table = tableBounds(schedule);
  for (const lesson of schedule.lessons) {
    if (timeToMinutes(lesson.start_time) >= timeToMinutes(lesson.end_time)) {
      errors.push(`lesson ${lesson.id}: start ${lesson.start_time} >= end ${lesson.end_time}`);
    }
    if (lesson.groups.length === 0) errors.push(`lesson ${lesson.id}: no groups`);
    const g = lesson.geometry;
    if (g.x0 < table.x0 - 1 || g.x1 > table.x1 + 1 || g.y0 < table.y0 - 1 || g.y1 > table.y1 + 1) {
      errors.push(`lesson ${lesson.id}: geometry outside table bounds`);
    }
  }

  const uncertainCount = schedule.lessons.filter((lesson) => lesson.uncertain).length;
  const uncertainRatio = schedule.lessons.length ? uncertainCount / schedule.lessons.length : 0;
  if (uncertainRatio > 0.5) errors.push(`${Math.round(uncertainRatio * 100)}% of lessons are uncertain`);
  else if (uncertainRatio > 0.15) warnings.push(`${Math.round(uncertainRatio * 100)}% of lessons are uncertain`);

  const groupsWithoutLessons = schedule.groups.filter(
    (group) => !schedule.lessons.some((lesson) => lesson.groups.includes(group.name)),
  );
  if (groupsWithoutLessons.length > 0) {
    warnings.push(`groups without lessons: ${groupsWithoutLessons.map((group) => group.name).join(", ")}`);
  }

  // Detect unresolved slot collisions (different independent lessons in the same group/slot)
  for (const group of schedule.groups) {
    for (const day of schedule.days) {
      for (const slot of schedule.time_slots) {
        const matching = schedule.lessons.filter(
          (l) => l.day === day && l.start_time === slot.start_time && l.groups.includes(group.name),
        );
        if (matching.length <= 1) continue;
        for (let i = 0; i < matching.length; i++) {
          for (let j = i + 1; j < matching.length; j++) {
            const a = matching[i];
            const b = matching[j];
            const parityOverlap = a.week_parity === "both" || b.week_parity === "both" || a.week_parity === b.week_parity;
            const noSubgroupDiff = (!a.subgroup && !b.subgroup) || a.subgroup === b.subgroup;
            const different = a.subject !== b.subject || a.raw_text !== b.raw_text;
            if (parityOverlap && noSubgroupDiff && different) {
              warnings.push(
                `unresolved slot collision for ${group.name} on ${day} ${slot.start_time}: "${a.subject}" vs "${b.subject}"`,
              );
            }
          }
        }
      }
    }
  }

  // Detect suspicious broad lessons (large group span with unknown type and no teacher/room)
  for (const lesson of schedule.lessons) {
    if (lesson.groups.length >= 10 && lesson.lesson_type === "unknown" && !lesson.teacher && !lesson.room) {
      warnings.push(
        `suspicious broad lesson spanning ${lesson.groups.length} groups with no teacher/room: "${lesson.subject}" (${lesson.day} ${lesson.start_time})`,
      );
    }
  }

  const previous = context.previousLessonCount ?? null;
  if (previous !== null && previous > 0 && schedule.lessons.length < previous * config.minLessonRatio) {
    errors.push(
      `lesson count dropped from ${previous} to ${schedule.lessons.length} (below ${Math.round(config.minLessonRatio * 100)}% threshold)`,
    );
  }

  return { ok: errors.length === 0, errors: dedupe(errors).slice(0, 25), warnings: dedupe(warnings) };
}

function tableBounds(schedule: Schedule) {
  const xs0 = schedule.groups.map((group) => group.x0);
  const xs1 = schedule.groups.map((group) => group.x1);
  const ys0 = schedule.lessons.map((lesson) => lesson.geometry.y0);
  const ys1 = schedule.lessons.map((lesson) => lesson.geometry.y1);
  return {
    x0: xs0.length ? Math.min(...xs0) : -Infinity,
    x1: xs1.length ? Math.max(...xs1) : Infinity,
    y0: ys0.length ? Math.min(...ys0) : -Infinity,
    y1: ys1.length ? Math.max(...ys1) : Infinity,
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
