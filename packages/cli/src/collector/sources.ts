/**
 * The collector's rule for every source that runs external commands (spec A10.1): at most one run
 * at a time per source (single-flight). A tick that finds the previous run still going is skipped,
 * and that is logged once until the source completes again. Commands inside a source carry their
 * own timeouts, so a hung command ends the run instead of blocking the source for good.
 */
export class Sources {
  private readonly running = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly skipping = new Set<string>();
  /** Skipped ticks since start, per source (self-monitoring). */
  readonly skipped = new Map<string, number>();

  constructor(private readonly log: (msg: string) => void) {}

  isRunning(name: string): boolean {
    return this.running.has(name);
  }

  /** How many sources are running now. */
  get active(): number {
    return this.running.size;
  }

  async run(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.running.has(name)) {
      this.skipped.set(name, (this.skipped.get(name) ?? 0) + 1);
      if (!this.skipping.has(name)) {
        this.skipping.add(name);
        this.log(`${name}: the previous run is still going; skipping ticks until it ends`);
      }
      return;
    }
    this.running.add(name);
    const run = (async () => {
      try {
        await fn();
      } catch (err) {
        this.log(`${name} failed: ${(err as Error).message}`);
      } finally {
        this.running.delete(name);
        if (this.skipping.delete(name)) this.log(`${name}: running again`);
      }
    })();
    this.inFlight.add(run);
    try {
      await run;
    } finally {
      this.inFlight.delete(run);
    }
  }

  /** Wait for the running sources to finish (on stop, before the database closes), at most `ms`. */
  async drain(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all([...this.inFlight]), new Promise((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
  }
}

/** Timeouts for the collector's commands (ms). */
export const TIMEOUT = { fast: 3_000, ps: 5_000, docker: 10_000, diskutil: 10_000, tailscale: 5_000, du: 120_000, auth: 60_000 } as const;
