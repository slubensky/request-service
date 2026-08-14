/**
 * Minimal in-memory fixed-window rate limiter (see SDD.md §5).
 *
 * Applied to public QR resolution to blunt brute-force token enumeration. It is
 * deliberately small and dependency-free; hardened, distributed rate limiting
 * is out of scope for the MVP (SDD §1.5). The clock is injectable so the policy
 * is deterministically testable.
 *
 * Fail-safe: this limiter only ever *denies* extra requests. It never grants
 * authority and never alters a response's contents, so a limiter fault cannot
 * weaken the neutral public page's privacy guarantees.
 */

export interface RateLimiterOptions {
  /** Maximum requests permitted per key within a window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable clock (epoch ms); defaults to Date.now. */
  now?: () => number;
}

interface WindowState {
  windowStart: number;
  count: number;
}

/**
 * Counts requests per key in discrete windows. `check(key)` returns true when
 * the request is within budget (and records it), false when the key has
 * exhausted its window.
 */
export class FixedWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, WindowState>();

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => Date.now());
  }

  /** Records a request for `key`, returning whether it is within the window budget. */
  check(key: string): boolean {
    const current = this.now();
    const existing = this.windows.get(key);

    if (!existing || current - existing.windowStart >= this.windowMs) {
      this.windows.set(key, { windowStart: current, count: 1 });
      return true;
    }

    if (existing.count >= this.limit) {
      return false;
    }

    existing.count += 1;
    return true;
  }
}
