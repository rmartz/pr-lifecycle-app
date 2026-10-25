import { describe, expect, it } from 'vitest';
import { alreadyPosted, wantedStatuses } from '../src/pr-policy-statuses.js';
import { makeFakeClient } from './fake-client.js';
import { makeEvaluation } from './gate-fixtures.js';

const PATH = 'repos/o/r/commits/s1/status?per_page=100';

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
  const wanted = [{ context: 'p', state: 'success', description: 'Passed' }];

  it('is true when each wanted status is the latest of its context', async () => {
    const client = makeFakeClient({
      [PATH]: { statuses: [{ context: 'p', state: 'success', description: 'Passed' }] },
    });
    expect(await alreadyPosted(client, 'o/r', 's1', wanted)).toBe(true);
  });

  it('is false when a state differs', async () => {
    const client = makeFakeClient({
      [PATH]: { statuses: [{ context: 'p', state: 'pending', description: 'Passed' }] },
    });
    expect(await alreadyPosted(client, 'o/r', 's1', wanted)).toBe(false);
  });

  it('is false when a wanted context was never posted', async () => {
    const client = makeFakeClient({ [PATH]: { statuses: [] } });
    expect(await alreadyPosted(client, 'o/r', 's1', wanted)).toBe(false);
  });

  it('reads a missing description as empty', async () => {
    const client = makeFakeClient({
      [PATH]: { statuses: [{ context: 'p', state: 'success', description: null }] },
    });
    const empty = [{ context: 'p', state: 'success', description: '' }];
    expect(await alreadyPosted(client, 'o/r', 's1', empty)).toBe(true);
  });

  it('is false when the status cannot be read, so the verdict is posted', async () => {
    expect(await alreadyPosted(makeFakeClient(), 'o/r', 's1', wanted)).toBe(false);
  });
});
