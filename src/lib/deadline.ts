/**
 * A shared wall-clock deadline.
 *
 * An `AbortController` whose signal nobody propagates is a timeout in name only: the timer fires,
 * the flag flips, and the work carries on. A `Deadline` is the propagated version — it hands out
 * the remaining budget, aborts every request that took its signal, and `race()` bounds any step
 * that cannot be aborted at all, so the caller returns at the deadline whatever the step is doing.
 */

export class DeadlineExceededError extends Error {
  constructor(totalMs: number) {
    super(`Deadline of ${totalMs}ms elapsed`);
    this.name = "DeadlineExceededError";
  }
}

export class Deadline {
  /** Epoch ms at which the deadline was created. */
  readonly startedAt: number;
  /** Epoch ms at which every operation under this deadline must be finished. */
  readonly deadlineAt: number;

  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly expiry: Promise<never>;

  constructor(totalMs: number) {
    const budget = Math.max(0, totalMs);
    this.startedAt = Date.now();
    this.deadlineAt = this.startedAt + budget;

    let expire: () => void = () => {};
    this.expiry = new Promise<never>((_resolve, reject) => {
      expire = () => reject(new DeadlineExceededError(budget));
    });
    // Nothing may observe this rejection until someone races against it, and an unobserved
    // rejection would take down the process.
    this.expiry.catch(() => {});

    this.timer = setTimeout(() => {
      this.controller.abort();
      expire();
    }, budget);
  }

  /** Aborts everything that took this signal, the moment the deadline passes. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Milliseconds left; zero or negative once the deadline has passed. */
  remaining(): number {
    return this.deadlineAt - Date.now();
  }

  get expired(): boolean {
    return this.controller.signal.aborted || this.remaining() <= 0;
  }

  /** Milliseconds spent so far. */
  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  /**
   * Bound one step by the deadline. Rejects with `DeadlineExceededError` if the deadline passes
   * first — the step itself is not cancelled, it is simply no longer waited on.
   */
  race<T>(work: Promise<T>): Promise<T> {
    return Promise.race([work, this.expiry]);
  }

  /** Release the timer. Always call this, or the process keeps a handle alive. */
  dispose(): void {
    clearTimeout(this.timer);
  }
}
