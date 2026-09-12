"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from "react";
import type { DayName, Lesson } from "@/lib/models";
import type { CourseOption, ScheduleResponse, StatusResponse } from "@/lib/client/types";
import { groupFor, readPreferences, rememberCourse, rememberGroup, type Preferences } from "@/lib/client/preferences";
import { loadCourse, LoadGenerations } from "@/lib/client/course-load";
import { currentWeek, DAY_SHORT, formatDateTime, isOtherWeek, localNow, WEEK_PARITY_LABEL, todayBanner, lessonsThisWeek, type WeekInfo } from "@/lib/client/time";
import { AllGroupsView } from "./AllGroupsView";
import { DayTimeline } from "./DayTimeline";
import { LessonCard } from "./LessonCard";
import { WeekBadge } from "./WeekBadge";

type ViewMode = "today" | "week" | "all";
const SEARCH_DEBOUNCE_MS = 250;

interface ScheduleAppProps {
  /** Course years this deployment serves, in display order. */
  courses: CourseOption[];
  defaultCourse: number;
}

/** Even reaching for window.localStorage throws in some privacy modes, so acquisition
 *  is guarded as well as the reads and writes inside the preferences module. */
function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function ScheduleApp({ courses, defaultCourse }: ScheduleAppProps) {
  const courseYears = useMemo(() => courses.map((course) => course.course_year), [courses]);
  const [course, setCourse] = useState(defaultCourse);
  const [preferences, setPreferences] = useState<Preferences>({ course: defaultCourse, groups: {} });
  // Nothing is fetched until the stored selection is known, so a returning Anul II
  // reader never sees an Anul I payload flash first.
  const [hydrated, setHydrated] = useState(false);
  /** Only the newest load generation may paint; a switch or a newer load retires the rest. */
  const generations = useRef(new LoadGenerations());
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("today");
  const [selectedDay, setSelectedDay] = useState<DayName | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [now, setNow] = useState(() => localNow());
  const [tick, setTick] = useState(() => Date.now());
  const [footerSpace, setFooterSpace] = useState(0);

  // The pinned "Toate grupele" matrix sizes itself against the viewport, so it has to know how
  // much room the status footer needs below it - otherwise the footer rides up over the last
  // table row at the bottom of the page. The height is measured because the footer reflows with
  // the breakpoint (4/2/1 columns) and with its own text.
  const measureFooter = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(() => setFooterSpace(node.getBoundingClientRect().height));
    observer.observe(node);
    return () => {
      observer.disconnect();
      setFooterSpace(0);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(localNow());
      setTick(Date.now());
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    // localStorage exists only in the browser, so the server-rendered default stands until
    // the stored selection is applied here - deferred by a tick, like the first fetch below,
    // so restoring it does not cascade another render out of the effect body.
    const timer = setTimeout(() => {
      const stored = readPreferences(browserStorage(), courseYears, defaultCourse);
      generations.current.invalidate();
      setPreferences(stored);
      setCourse(stored.course);
      setGroup(groupFor(stored, stored.course));
      setHydrated(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [courseYears, defaultCourse]);

  const load = useCallback(async (target: number) => {
    const outcome = await loadCourse(target, { fetchJson, generations: generations.current });
    // "stale" means a newer load (or a course switch) has taken over: this response must
    // change nothing, not even the error state.
    if (outcome.kind === "stale") return;
    if (outcome.kind === "failed") {
      setLoadError(outcome.message);
      return;
    }
    setSchedule(outcome.payload.schedule);
    setStatus(outcome.payload.status);
    setLoadError(null);
    // A group remembered for this course but missing from the published timetable is dropped.
    setGroup((current) => (current && outcome.payload.schedule.groups.includes(current) ? current : null));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    // Initial fetch happens asynchronously (after the effect body) plus a periodic refresh.
    const initial = setTimeout(() => void load(course), 0);
    const timer = setInterval(() => void load(course), 10 * 60_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [load, course, hydrated]);

  const selectGroup = (value: string) => {
    const next = value || null;
    setGroup(next);
    setPreferences((current) => rememberGroup(browserStorage(), current, course, next));
  };

  /** Switching course discards the previous course's payload instead of filtering it. */
  const selectCourse = (next: number) => {
    if (next === course) return;
    // Retire every in-flight load before the new course's own load starts, so a response
    // for the course being left (or for an earlier visit to the one being entered) is dropped.
    generations.current.invalidate();
    setCourse(next);
    setSchedule(null);
    setStatus(null);
    setLoadError(null);
    setSelectedDay(null);
    setSearch("");
    setDebouncedSearch("");
    setGroup(groupFor(preferences, next));
    rememberCourse(browserStorage(), next);
  };

  // Which week the university is running. Recomputed on the clock tick so the page rolls
  // over to the next week on its own, without waiting for the next status fetch.
  const week = useMemo(() => currentWeek(status?.source.odd_week_anchor, new Date(tick)), [status, tick]);

  const days = useMemo(() => schedule?.days ?? [], [schedule]);
  const todayName = now.day && days.includes(now.day) ? now.day : null;
  const activeDay: DayName | null = selectedDay ?? todayName ?? days[0] ?? null;

  const groupLessons = useMemo(() => (schedule && group ? schedule.lessons.filter((lesson) => lesson.groups.includes(group)) : []), [schedule, group]);

  const searchResults = useMemo(() => {
    if (!schedule || debouncedSearch.length < 2) return [];
    const needle = fold(debouncedSearch);
    return schedule.lessons
      .filter((lesson) => [lesson.subject, lesson.teacher, lesson.room, lesson.groups.join(" ")].map(fold).join(" ").includes(needle))
      .sort((a, b) => days.indexOf(a.day) - days.indexOf(b.day) || a.start_time.localeCompare(b.start_time))
      .slice(0, 60);
  }, [schedule, debouncedSearch, days]);

  const activeCourseOption = courses.find((option) => option.course_year === course) ?? courses[0];
  const sourceLabel = status?.schedule?.source_kind;
  const staleNotice = status && status.source.last_result === "error" && status.schedule ? `Nu s-a putut verifica ultima versiune. Este afișat orarul actualizat la ${formatDateTime(status.schedule.downloaded_at)}.` : null;
  const seedNotice = sourceLabel === "seed" ? "Sursa oficială nu a fost accesibilă la pornire; este afișată ultima versiune publicată de FCIM inclusă în aplicație. Se reîncearcă automat." : sourceLabel === "wayback" ? "Pagina FCIM nu a răspuns direct; PDF-ul a fost preluat din arhiva publică a paginii oficiale." : null;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-900 text-sm font-bold text-white" aria-hidden="true">
              {activeCourseOption?.roman ?? "?"}
            </span>
            <span className="hidden sm:inline">Orar FCIM</span>
          </Link>
          {courses.length > 1 && (
            <nav aria-label="Anul de studii" className="flex items-center rounded-lg bg-slate-100 p-0.5 text-sm">
              {courses.map((option) => (
                <button
                  key={option.course_year}
                  type="button"
                  onClick={() => selectCourse(option.course_year)}
                  aria-pressed={option.course_year === course}
                  className={`whitespace-nowrap rounded-md px-2.5 py-1.5 font-medium transition sm:px-3 ${option.course_year === course ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
                >
                  {option.label}
                </button>
              ))}
            </nav>
          )}
          <label className="ml-auto flex items-center gap-2 text-sm">
            <span className="sr-only">Grupa</span>
            <select
              value={group ?? ""}
              onChange={(event) => selectGroup(event.target.value)}
              className="h-9 min-w-[7.5rem] rounded-lg border border-slate-300 bg-white px-2 text-sm font-medium shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            >
              <option value="">Alege grupa…</option>
              {schedule?.groups.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <nav aria-label="Mod de afișare" className="hidden items-center rounded-lg bg-slate-100 p-0.5 text-sm md:flex">
            {(["today", "week", "all"] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                aria-pressed={view === mode}
                className={`rounded-md px-3 py-1.5 font-medium transition ${view === mode ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
              >
                {mode === "today" ? "Azi" : mode === "week" ? "Săptămâna" : "Toate grupele"}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 pb-24 pt-4 md:pb-10" style={{ "--status-footer-height": `${footerSpace}px` } as CSSProperties}>
        {loadError && !schedule && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-semibold">Orarul nu este disponibil momentan.</p>
            <p className="mt-1">{loadError === "Schedule not available yet" ? "Se descarcă și se procesează PDF-ul oficial FCIM. Pagina se va actualiza automat." : "Încercăm din nou în câteva secunde."}</p>
          </div>
        )}
        {!schedule && !loadError && (
          <div className="animate-pulse space-y-3" aria-live="polite">
            <div className="h-6 w-48 rounded bg-slate-200" />
            <div className="h-24 rounded-xl bg-slate-200" />
            <div className="h-24 rounded-xl bg-slate-200" />
          </div>
        )}

        {schedule && (
          <>
            {(staleNotice || seedNotice) && (
              <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{staleNotice ?? seedNotice}</div>
            )}

            <section aria-label="Căutare" className="mb-4">
              <div className="relative">
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Caută profesor, disciplină, sală sau grupă…"
                  className="h-11 w-full rounded-xl border border-slate-300 bg-white pl-10 pr-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
                  aria-label="Căutare"
                />
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true">
                  ⌕
                </span>
              </div>
              {debouncedSearch.length >= 2 && (
                <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                    {searchResults.length ? `${searchResults.length} rezultate pentru „${debouncedSearch}”` : `Nimic găsit pentru „${debouncedSearch}”`}
                  </p>
                  <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {searchResults.map((lesson) => (
                      <li key={lesson.id}>
                        <p className="mb-1 text-xs text-slate-500">
                          {lesson.day} · {lesson.groups.length > 6 ? `${lesson.groups.length} grupe` : lesson.groups.join(", ")}
                        </p>
                        <LessonCard lesson={lesson} showTime compact otherWeek={isOtherWeek(lesson, week.parity)} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            {view === "all" ? (
              <AllGroupsView
                groups={schedule.groups}
                days={days}
                timeSlots={schedule.time_slots}
                lessons={schedule.lessons}
                today={todayName}
                week={week}
              />
            ) : !group ? (
              <GroupPicker groups={schedule.groups} courseLabel={activeCourseOption?.label ?? ""} onPick={selectGroup} />
            ) : (
              <GroupSchedule
                group={group}
                days={days}
                lessons={groupLessons}
                view={view}
                activeDay={activeDay}
                todayName={todayName}
                onSelectDay={setSelectedDay}
                now={now}
                week={week}
              />
            )}

            <StatusFooter status={status} week={week} ref={measureFooter} />
          </>
        )}
      </main>

      <nav aria-label="Mod de afișare" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-slate-200 bg-white/95 text-xs backdrop-blur md:hidden">
        {(["today", "week", "all"] as ViewMode[]).map((mode) => (
          <button key={mode} type="button" onClick={() => setView(mode)} aria-pressed={view === mode} className={`py-3 font-medium ${view === mode ? "text-blue-700" : "text-slate-500"}`}>
            {mode === "today" ? "Azi" : mode === "week" ? "Săptămâna" : "Toate"}
          </button>
        ))}
      </nav>
    </div>
  );
}

function fold(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function GroupPicker({ groups, courseLabel, onPick }: { groups: string[]; courseLabel: string; onPick: (group: string) => void }) {
  const byProgram = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const name of groups) {
      const program = name.split("-")[0];
      map.set(program, [...(map.get(program) ?? []), name]);
    }
    return [...map.entries()];
  }, [groups]);
  return (
    <section aria-labelledby="pick-title" className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-8">
      <h1 id="pick-title" className="text-xl font-semibold tracking-tight sm:text-2xl">
        Alege grupa ta{courseLabel ? ` · ${courseLabel}` : ""}
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        Grupa se salvează pe acest dispozitiv, separat pentru fiecare an – data viitoare orarul se deschide direct.
      </p>
      <div className="mt-6 space-y-5">
        {byProgram.map(([program, names]) => (
          <div key={program}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{program}</h2>
            <div className="flex flex-wrap gap-2">
              {names.map((name) => (
                <button key={name} type="button" onClick={() => onPick(name)} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700">
                  {name}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

interface GroupScheduleProps {
  group: string;
  days: DayName[];
  lessons: Lesson[];
  view: ViewMode;
  activeDay: DayName | null;
  todayName: DayName | null;
  onSelectDay: (day: DayName) => void;
  now: ReturnType<typeof localNow>;
  week: WeekInfo;
}

function GroupSchedule({ group, days, lessons, view, activeDay, todayName, onSelectDay, now, week }: GroupScheduleProps) {
  const lessonsFor = (day: DayName) => lessons.filter((lesson) => lesson.day === day);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{group}</h1>
        <p className="text-sm text-slate-500">
          {now.dateLabel} · {now.timeLabel} (Chișinău)
        </p>
        <WeekBadge week={week} />
      </div>

      {view === "today" && (
        <>
          <p className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{todayBanner(lessonsThisWeek(lessons, week.parity).filter((lesson) => lesson.day == now.day), now)}</p>
          <nav aria-label="Ziua" className="sticky top-14 z-20 -mx-4 mb-4 flex gap-1 overflow-x-auto bg-slate-50/95 px-4 py-2 backdrop-blur sm:mx-0 sm:px-0">
            {days.map((day) => (
              <button
                key={day}
                type="button"
                onClick={() => onSelectDay(day)}
                aria-pressed={day === activeDay}
                className={`min-w-[3.2rem] flex-1 rounded-lg px-2 py-2 text-sm font-medium transition sm:flex-none sm:px-4 ${day === activeDay ? "bg-slate-900 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"}`}
              >
                <span className="sm:hidden">{DAY_SHORT[day]}</span>
                <span className="hidden sm:inline">{day}</span>
                {day === todayName && <span className={`ml-1 text-[10px] uppercase ${day === activeDay ? "opacity-80" : "text-blue-600"}`}>azi</span>}
              </button>
            ))}
          </nav>
          {!todayName && activeDay && <p className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">Azi este weekend – afișăm ziua de {activeDay}.</p>}
          {activeDay && <DayTimeline day={activeDay} lessons={lessonsFor(activeDay)} now={now} focusGroup={group} activeParity={week.parity} />}
        </>
      )}

      {view === "week" && (
        <div className="grid gap-6 lg:grid-cols-2 2xl:grid-cols-5">
          {days.map((day) => (
            <div key={day} className={`rounded-2xl border p-4 ${day === todayName ? "border-blue-200 bg-blue-50/40" : "border-slate-200 bg-white"}`}>
              <DayTimeline day={day} lessons={lessonsFor(day)} now={now} focusGroup={group} activeParity={week.parity} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function StatusFooter({ status, week, ref }: { status: StatusResponse | null; week: WeekInfo; ref?: Ref<HTMLElement> }) {
  if (!status?.schedule) return null;
  const { schedule, source } = status;
  return (
    // The pinned "Toate grupele" matrix leaves room for this footer (see --status-footer-height);
    // z-10 keeps the footer on top for the frame it takes to re-measure after a resize.
    <footer ref={ref} className="relative z-10 mt-10 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Actualizat</p>
        <p className="font-medium text-slate-900">{formatDateTime(schedule.downloaded_at)}</p>
        <p className="text-xs">Verificat: {formatDateTime(source.last_check_at)} · la fiecare {source.refresh_interval_minutes} min</p>
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Sursa</p>
        <p className="font-medium text-slate-900">FCIM UTM · {status.course_label}</p>
        <p className="text-xs">
          {schedule.academic_year ?? "—"} · {schedule.semester ?? "—"} · {schedule.groups} grupe · {schedule.lessons} lecții
        </p>
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Documente</p>
        <a href={schedule.source_pdf_url} target="_blank" rel="noopener noreferrer" className="block font-medium text-blue-700 hover:underline">
          PDF oficial ↗
        </a>
        <a href={source.page_url} target="_blank" rel="noopener noreferrer" className="block text-xs text-blue-700 hover:underline">
          Pagina oficială a orarului ↗
        </a>
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Notă</p>
        <p className="text-xs">
          Acum: săptămâna {week.number} ({WEEK_PARITY_LABEL[week.parity]}).
        </p>
        <p className="text-xs">{source.parity_note ?? "Săptămâna pară/impară: vezi anunțul de pe pagina oficială."}</p>
        {schedule.uncertain_lessons > 0 && <p className="text-xs">{schedule.uncertain_lessons} celule marcate ca incerte.</p>}
      </div>
    </footer>
  );
}
