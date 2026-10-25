/**
 * Watches GitHub's `x-ratelimit-remaining` header on every response a client
 * gets, so a fan-out can log what is left of the installation's hourly budget
 * and stop before exhausting it. One meter per delivery.
 */
export interface RateLimitMeter {
  /** A `fetch` that records the header, for the GitHub client to use. */
  readonly fetch: typeof fetch;
  /** The latest remaining count seen, or undefined before any response carried one. */
  readonly remaining: () => number | undefined;
  /**
   * The latest response that wasn't OK: its status and API path (no query, no
   * token), so a failed read can be logged with why it failed.
   */
  readonly lastFailure: () => RequestFailure | undefined;
  /** How many requests this meter's client has made: the delivery's API cost. */
  readonly calls: () => number;
}

/**
 * Below this many requests left in the installation's hour, the gate does no
 * new work: it posts nothing and logs the skip. A quota-starved gate must never
 * post a red required check, and keeping a reserve leaves room for the PR
 * events that matter most.
 */
export const RATE_LIMIT_FLOOR = 500;

/** Whether the installation's remaining budget is below the floor. */
export function isBelowFloor(remaining: number | undefined): boolean {
  return remaining !== undefined && remaining < RATE_LIMIT_FLOOR;
}

/**
 * Whether the client is out of budget: below the floor, or its last failure
 * was a rate-limit response (429, or 403 with nothing left). A read that
 * failed this way says nothing about the PR, so the gate must not post a
 * verdict built on it.
 */
export function isStarved(
  remaining: number | undefined,
  failure: RequestFailure | undefined,
): boolean {
  if (isBelowFloor(remaining)) return true;
  return failure?.status === 429 || (failure?.status === 403 && remaining === 0);
}

export interface RequestFailure {
  readonly status: number;
  readonly path: string;
}

function pathOf(input: Parameters<typeof fetch>[0]): string {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(href).pathname;
  } catch {
    return '';
  }
}

export function createRateLimitMeter(base: typeof fetch = fetch): RateLimitMeter {
  let remaining: number | undefined;
  let lastFailure: RequestFailure | undefined;
  let calls = 0;
  return {
    fetch: async (input, init) => {
      calls += 1;
      const response = await base(input, init);
      if (!response.ok) {
        lastFailure = { status: response.status, path: pathOf(input) };
      }
      const header = Number(response.headers.get('x-ratelimit-remaining') ?? Number.NaN);
      if (Number.isFinite(header)) {
        remaining = header;
      }
      return response;
    },
    remaining: () => remaining,
    lastFailure: () => lastFailure,
    calls: () => calls,
  };
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) {
        await fn(item);
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
}
