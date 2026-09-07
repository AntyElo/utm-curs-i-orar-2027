/** Next.js server hook: bootstrap the cache and start the periodic refresh loop once per process. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SCHEDULE_DISABLE_SCHEDULER === "1") return;
  const { bootstrapScheduleState, startScheduler } = await import("@/lib/services/updater");
  await bootstrapScheduleState();
  startScheduler();
}
