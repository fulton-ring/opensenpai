interface Waiter {
  grant: () => void;
  signal: AbortSignal;
  abort: () => void;
}
/** Native orchestration exposes no concurrency option in pinned Mastra 1.78. */
export function concurrencyLimit(value = 2): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(8, Math.floor(value))) : 2;
}
/** Bound in-process work with abortable FIFO acquisition and idempotent release. */
export class Concurrency {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.release());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        grant: () => resolve(this.release()),
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason);
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.signal.removeEventListener("abort", next.abort);
        next.grant();
      } else this.active--;
    };
  }
}
