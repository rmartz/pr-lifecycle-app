import { describe, expect, it } from 'vitest';
import { createOpenPullsFinder } from '../src/open-pulls.js';

const REPO = 'firebase-nextjs-template';

function pull(number: number, state: string, fullName: string) {
  return { number, state, base: { repo: { full_name: fullName } } };
}

describe('createOpenPullsFinder', () => {
  it("queries the commit's PRs with the given token", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const find = createOpenPullsFinder({
      fetch: (input, init) => {
        seen.push({
          url: input instanceof Request ? input.url : input.toString(),
          auth: new Headers(init?.headers).get('authorization'),
        });
        return Promise.resolve(Response.json([]));
      },
    });
    await find('ghs_x', 'rmartz', REPO, 'abc123');
    expect(seen).toEqual([
      {
        url: `https://api.github.com/repos/rmartz/${REPO}/commits/abc123/pulls?per_page=100`,
        auth: 'Bearer ghs_x',
      },
    ]);
  });

  it('keeps only open PRs whose base is this repository', async () => {
    const find = createOpenPullsFinder({
      fetch: () =>
        Promise.resolve(
          Response.json([
            pull(1, 'open', 'rmartz/Firebase-NextJS-Template'),
            pull(2, 'closed', `rmartz/${REPO}`),
            pull(3, 'open', `someone/${REPO}`),
          ]),
        ),
    });
    await expect(find('ghs_x', 'rmartz', REPO, 'abc123')).resolves.toEqual([1]);
  });

  it('throws on an HTTP error', async () => {
    const find = createOpenPullsFinder({
      fetch: () => Promise.resolve(new Response('', { status: 502 })),
    });
    await expect(find('ghs_x', 'rmartz', REPO, 'abc123')).rejects.toThrow('HTTP 502');
  });
});
