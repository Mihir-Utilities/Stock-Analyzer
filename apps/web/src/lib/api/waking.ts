// "Waking up the server" state (docs/06-frontend-spec.md sections 1 and 9; UI-01).
// Tracks in-flight API requests; after WAKING_AFTER_MS the oldest one flips `waking` on.

export const WAKING_AFTER_MS = 3_000;
export const WAKING_MESSAGE =
  "Waking up the server. This can take up to a minute on the free plan.";

export interface WakingSnapshot {
  waking: boolean;
  /** Whole seconds the oldest in-flight request has been waiting; 0 when not waking. */
  elapsedSeconds: number;
}

const IDLE: WakingSnapshot = { waking: false, elapsedSeconds: 0 };

export class WakingTracker {
  private readonly started = new Map<number, number>();
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshot: WakingSnapshot = IDLE;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Register a request; call the returned function when it settles. */
  begin(): () => void {
    const id = this.nextId++;
    this.started.set(id, this.now());
    this.ensureTimer();
    this.refresh();
    return () => {
      this.started.delete(id);
      if (this.started.size === 0) this.stopTimer();
      this.refresh();
    };
  }

  getSnapshot = (): WakingSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Recompute the snapshot; exposed so tests can drive it with a fake clock. */
  refresh(): void {
    let oldest: number | null = null;
    for (const t of this.started.values()) if (oldest === null || t < oldest) oldest = t;
    const age = oldest === null ? 0 : this.now() - oldest;
    const next: WakingSnapshot =
      age >= WAKING_AFTER_MS ? { waking: true, elapsedSeconds: Math.floor(age / 1000) } : IDLE;
    if (
      next.waking !== this.snapshot.waking ||
      next.elapsedSeconds !== this.snapshot.elapsedSeconds
    ) {
      this.snapshot = next;
      this.listeners.forEach((l) => l());
    }
  }

  private ensureTimer(): void {
    if (this.timer === null) this.timer = setInterval(() => this.refresh(), 500);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

export const wakingTracker = new WakingTracker();
