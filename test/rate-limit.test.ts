import { describe, expect, it } from 'vitest';
import {
  createRateLimitMeter,
  forEachBounded,
  isStarved,
  RATE_LIMIT_FLOOR,
} from '../src/rate-limit.js';

function respondingWith(headers: Record<string, string>): typeof fetch {
  return () => Promise.resolve(new Response('{}', { headers }));
}

describe('createRateLimitMeter', () => {
  it('knows nothing before any response', () => {
    expect(createRateLimitMeter(respondingWith({})).remaining()).toBeUndefined();
  });

  it('records the latest x-ratelimit-remaining', async () => {
    const meter = createRateLimitMeter(respondingWith({ 'x-ratelimit-remaining': '4242' }));
    await meter.fetch('https://api.github.com/x');
    expect(meter.remaining()).toBe(4242);
  });

  it('keeps the last count when a response carries none', async () => {
    let call = 0;
    const meter = createRateLimitMeter(() =>
      Promise.resolve(
        new Response('{}', { headers: call++ === 0 ? { 'x-ratelimit-remaining': '99' } : {} }),
      ),
    );
    await meter.fetch('https://api.github.com/a');
    await meter.fetch('https://api.github.com/b');
    expect(meter.remaining()).toBe(99);
  });

  it('passes the response through unchanged', async () => {
    const meter = createRateLimitMeter(respondingWith({ etag: 'abc' }));
    const response = await meter.fetch('https://api.github.com/x');
    expect(response.headers.get('etag')).toBe('abc');
  });
});

describe('createRateLimitMeter: failures', () => {
  it('records the status and path of a failed response, never the query', async () => {
    const meter = createRateLimitMeter(() => Promise.resolve(new Response('{}', { status: 403 })));
    await meter.fetch('https://api.github.com/repos/o/r/pulls?state=open');
    expect(meter.lastFailure()).toEqual({ status: 403, path: '/repos/o/r/pulls' });
  });

  it('records no failure for a successful response', async () => {
    const meter = createRateLimitMeter(respondingWith({}));
    await meter.fetch('https://api.github.com/repos/o/r');
    expect(meter.lastFailure()).toBeUndefined();
  });

  it('records a failure for a Request input too', async () => {
    const meter = createRateLimitMeter(() => Promise.resolve(new Response('', { status: 404 })));
    await meter.fetch(new Request('https://api.github.com/repos/o/r/pulls/9'));
    expect(meter.lastFailure()?.path).toBe('/repos/o/r/pulls/9');
  });
});

describe('createRateLimitMeter: calls', () => {
  it('counts every request the client makes', async () => {
    const meter = createRateLimitMeter(respondingWith({}));
    await meter.fetch('https://api.github.com/a');
    await meter.fetch('https://api.github.com/b');
    expect(meter.calls()).toBe(2);
  });
});

describe('isStarved', () => {
  it('is false with budget to spare and no failure', () => {
    expect(isStarved(4000, undefined)).toBe(false);
  });

  it('is true below the floor', () => {
    expect(isStarved(RATE_LIMIT_FLOOR - 1, undefined)).toBe(true);
  });

  it('is true after a 429', () => {
    expect(isStarved(undefined, { status: 429, path: '/x' })).toBe(true);
  });

  it('is true after a 403 with nothing left', () => {
    expect(isStarved(0, { status: 403, path: '/x' })).toBe(true);
  });

  it('is false after a 403 with budget left, which is a permission error', () => {
    expect(isStarved(3000, { status: 403, path: '/x' })).toBe(false);
  });
});

describe('forEachBounded', () => {
  it('visits every item', async () => {
    const seen: number[] = [];
    await forEachBounded([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
      await Promise.resolve();
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await forEachBounded([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });
    expect(peak).toBe(3);
  });

  it('does nothing for no items', async () => {
    let called = false;
    await forEachBounded([], 4, async () => {
      called = true;
      await Promise.resolve();
    });
    expect(called).toBe(false);
  });
});
