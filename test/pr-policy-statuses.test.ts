import { describe, expect, it } from 'vitest';
import { alreadyPosted, wantedStatuses } from '../src/pr-policy-statuses.js';
import { makeFakeClient } from './fake-client.js';
import { makeEvaluation } from './gate-fixtures.js';

const PATH = 'repos/o/r/commits/s1/statuses?per_page=100';

describe('wantedStatuses', () => {
  it('lists the verdict, then one status per check under the name', () => {
    const wanted = wantedStatuses('pr-policy (app)', makeEvaluation(), [
      { check: 'title', state: 'failure', description: 'bad' },
    ]);
    expect(wanted).toEqual([
      { context: 'pr-policy (app)', state: 'failure', description: 'Title type is wrong' },
      { context: 'pr-policy (app) / title', state: 'failure', description: 'bad' },
    ]);
  });

  it('truncates the verdict description as the library does', () => {
    const wanted = wantedStatuses('p', makeEvaluation({ title: 'x'.repeat(200) }), []);
    expect(wanted[0]?.description).toHaveLength(140);
  });
});

describe('alreadyPosted', () => {
  const BOT = 'rmartz-pr-lifecycle-gate[bot]';
  const wanted = [{ context: 'p', state: 'success', description: 'Passed' }];
  const status = (state: string, description: string | null, login = BOT) => ({
    context: 'p',
    state,
    description,
    creator: { login },
  });
  const check = (statuses: unknown) =>
    alreadyPosted(makeFakeClient({ [PATH]: statuses }), 'o/r', 's1', BOT, wanted);

  it('is true when the gate posted each wanted status as the latest of its context', async () => {
    expect(await check([status('success', 'Passed')])).toBe(true);
  });

  it("is false when the latest is another poster's identical status, as during a cutover", async () => {
    expect(await check([status('success', 'Passed', 'github-actions[bot]')])).toBe(false);
  });

  it('judges only the newest status of a context', async () => {
    expect(await check([status('pending', 'Passed'), status('success', 'Passed')])).toBe(false);
  });

  it('is false when a wanted context was never posted', async () => {
    expect(await check([])).toBe(false);
  });

  it('reads a missing description as empty', async () => {
    const empty = [{ context: 'p', state: 'success', description: '' }];
    const client = makeFakeClient({ [PATH]: [status('success', null)] });
    expect(await alreadyPosted(client, 'o/r', 's1', BOT, empty)).toBe(true);
  });

  it('is false when the statuses cannot be read, so the verdict is posted', async () => {
    expect(await alreadyPosted(makeFakeClient(), 'o/r', 's1', BOT, wanted)).toBe(false);
  });
});
