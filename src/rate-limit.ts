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
}

export function createRateLimitMeter(base: typeof fetch = fetch): RateLimitMeter {
  let remaining: number | undefined;
  return {
    fetch: async (input, init) => {
      const response = await base(input, init);
      const header = Number(response.headers.get('x-ratelimit-remaining') ?? Number.NaN);
      if (Number.isFinite(header)) {
        remaining = header;
      }
      return response;
    },
    remaining: () => remaining,
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
