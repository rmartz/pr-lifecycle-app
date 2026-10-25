import { describe, expect, it } from 'vitest';
import type { EventTarget } from '../src/events.js';
import { PR_POLICY_SHADOW_NAME, runPrPolicy, verdictName } from '../src/run-pr-policy.js';
import { INSTALLATION_ID, REPO_ID } from './fixtures.js';
import { LIVE_CONFIG, makeFacts, makeGateDeps, SHADOW_CONFIG } from './gate-fixtures.js';

function makeTarget(overrides: Partial<EventTarget> = {}): EventTarget {
  return {
    repository: {
      installationId: INSTALLATION_ID,
      id: REPO_ID,
      owner: 'rmartz',
      name: 'firebase-nextjs-template',
      fullName: 'rmartz/firebase-nextjs-template',
    },
    prs: [31],
    headSha: undefined,
    ...overrides,
  };
}

const ops = (deps: ReturnType<typeof makeGateDeps>) =>
  deps.calls.map(({ op }) => op).filter((op) => op !== 'getJson');
const call = (deps: ReturnType<typeof makeGateDeps>, op: string) =>
  deps.calls.find((entry) => entry.op === op)?.args;

const PRETTIER_BUMP = makeFacts({
  title: 'chore(deps-dev): bump prettier from 3.1.0 to 3.2.0',
  author: { login: 'dependabot[bot]', type: 'Bot' },
  changedFiles: ['package.json'],
  manifestChanges: [
    {
      path: 'package.json',
      baseText: JSON.stringify({ devDependencies: { prettier: '3.1.0' } }),
      headText: JSON.stringify({ devDependencies: { prettier: '3.2.0' } }),
    },
  ],
});

describe('runPrPolicy: tokens', () => {
  it("mints the gate token for the event's installation and repository only", async () => {
    const deps = makeGateDeps();
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect(deps.minted).toEqual([{ installationId: 777, repo: 'firebase-nextjs-template' }]);
  });

  it('logs a token failure and evaluates nothing', async () => {
    const deps = makeGateDeps({
      overrides: { mintToken: () => Promise.reject(new Error('HTTP 404')) },
    });
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect([deps.calls, deps.log.entries[0]?.message]).toEqual([
      [],
      'could not prepare the pr-policy evaluation',
    ]);
  });
});

describe('runPrPolicy: shadow', () => {
  it('posts the verdict under pr-policy (app), never pr-policy', async () => {
    const deps = makeGateDeps();
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect(call(deps, 'postVerdict')).toEqual([31, 'head1', 'failure', 'pr-policy (app)']);
  });

  it('posts the per-check statuses under the same shadow prefix', async () => {
    const deps = makeGateDeps();
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect(call(deps, 'postCheckStatuses')?.[3]).toBe('pr-policy (app)');
  });

  it('never edits labels', async () => {
    const deps = makeGateDeps();
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect(ops(deps)).not.toContain('applyLabelEdits');
  });

  it('judges the retitled title without renaming the PR', async () => {
    const deps = makeGateDeps({ facts: PRETTIER_BUMP });
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect([call(deps, 'evaluatePolicy'), ops(deps)]).toEqual([
      ['ci(deps-dev): bump prettier from 3.1.0 to 3.2.0'],
      ['gatherFacts', 'evaluatePolicy', 'postVerdict', 'postCheckStatuses'],
    ]);
  });

  it('logs the verdict for comparison with the action', async () => {
    const deps = makeGateDeps();
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect(deps.log.entries.at(-1)).toMatchObject({
      message: 'evaluated',
      fields: { pr: 31, mode: 'shadow', outcome: 'failure' },
    });
  });
});

describe('runPrPolicy: live', () => {
  it('posts the verdict under the real pr-policy name', async () => {
    const deps = makeGateDeps();
    await runPrPolicy(makeTarget(), LIVE_CONFIG, 'd-1', deps);
    expect(call(deps, 'postVerdict')?.[3]).toBe('pr-policy');
  });

  it('applies the planned label edits before posting the verdict', async () => {
    const deps = makeGateDeps();
    await runPrPolicy(makeTarget(), LIVE_CONFIG, 'd-1', deps);
    expect(ops(deps)).toEqual([
      'gatherFacts',
      'evaluatePolicy',
      'applyLabelEdits',
      'postVerdict',
      'postCheckStatuses',
    ]);
  });

  it('retitles a Dependabot ci bump through the gate token, then judges the new title', async () => {
    const deps = makeGateDeps({ facts: PRETTIER_BUMP });
    await runPrPolicy(makeTarget(), LIVE_CONFIG, 'd-1', deps);
    expect([call(deps, 'send'), call(deps, 'evaluatePolicy')]).toEqual([
      [
        'PATCH',
        'repos/rmartz/firebase-nextjs-template/pulls/31',
        { title: 'ci(deps-dev): bump prettier from 3.1.0 to 3.2.0' },
      ],
      ['ci(deps-dev): bump prettier from 3.1.0 to 3.2.0'],
    ]);
  });

  it('judges the original title when the retitle is refused', async () => {
    const deps = makeGateDeps({ facts: PRETTIER_BUMP, sendOk: false });
    await runPrPolicy(makeTarget(), LIVE_CONFIG, 'd-1', deps);
    expect(call(deps, 'evaluatePolicy')).toEqual([
      'chore(deps-dev): bump prettier from 3.1.0 to 3.2.0',
    ]);
  });

  it("doesn't retitle when the repo hasn't opted in", async () => {
    const deps = makeGateDeps({ facts: PRETTIER_BUMP });
    const config = {
      ...LIVE_CONFIG,
      policy: { ...LIVE_CONFIG.policy, retitleDependabotCi: false },
    };
    await runPrPolicy(makeTarget(), config, 'd-1', deps);
    expect(ops(deps)).not.toContain('send');
  });
});

describe('runPrPolicy: targets', () => {
  it("looks up the open PRs at a status event's commit", async () => {
    const deps = makeGateDeps({ openPrs: [52, 51] });
    await runPrPolicy(makeTarget({ prs: [], headSha: 'abc123' }), SHADOW_CONFIG, 'd-1', deps);
    expect(deps.calls.filter(({ op }) => op === 'gatherFacts').map(({ args }) => args)).toEqual([
      ['rmartz/firebase-nextjs-template', 51],
      ['rmartz/firebase-nextjs-template', 52],
    ]);
  });

  it('logs and evaluates nothing when no PR is open at the commit', async () => {
    const deps = makeGateDeps({ openPrs: [] });
    await runPrPolicy(makeTarget({ prs: [], headSha: 'abc123' }), SHADOW_CONFIG, 'd-1', deps);
    expect(deps.log.entries.map(({ message }) => message)).toEqual([
      'no open pull request to evaluate',
    ]);
  });

  it('logs a failed evaluation and moves on to the next PR', async () => {
    const base = makeGateDeps();
    const deps = makeGateDeps({
      overrides: {
        policy: {
          ...base.policy,
          gatherFacts: (target) =>
            target.pr === 1 ? Promise.reject(new Error('boom')) : base.policy.gatherFacts(target),
        },
      },
    });
    await runPrPolicy(makeTarget({ prs: [1, 2] }), SHADOW_CONFIG, 'd-1', deps);
    expect(deps.log.entries.map(({ message, fields }) => [message, fields['pr']])).toEqual([
      ['pr-policy evaluation failed', 1],
      ['evaluated', 2],
    ]);
  });

  it('warns when the per-check statuses cannot be posted', async () => {
    const deps = makeGateDeps({ statusesOk: false });
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect(deps.log.entries.some(({ level }) => level === 'warn')).toBe(true);
  });
});

describe('runPrPolicy: settings', () => {
  const checkCount = (deps: ReturnType<typeof makeGateDeps>) =>
    call(deps, 'postCheckStatuses')?.[2];

  it("runs the checks the repo's server config selects, uat-label included", async () => {
    const deps = makeGateDeps();
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect(checkCount(deps)).toBe(7);
  });

  it('drops the UAT checks when the server config skips UAT', async () => {
    const deps = makeGateDeps();
    const config = {
      ...SHADOW_CONFIG,
      policy: { ...SHADOW_CONFIG.policy, skipUat: true, requireUatLabel: false },
    };
    await runPrPolicy(makeTarget(), config, 'd-1', deps);
    expect(checkCount(deps)).toBe(5);
  });

  it("ignores a PR's own attempt to configure the gate", async () => {
    // The PR's body and labels are facts the checks judge, never settings.
    const deps = makeGateDeps({
      facts: makeFacts({ body: 'skip-uat: true', labels: ['skip-uat', 'no UAT needed'] }),
    });
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect(checkCount(deps)).toBe(7);
  });
});

describe('runPrPolicy: unchanged verdicts', () => {
  // What makeEvaluation() and SHADOW_CONFIG produce, as GitHub would list it.
  const posted = (overrides: Record<string, string> = {}, login = 'rmartz-pr-gate[bot]') =>
    [
      { context: 'pr-policy (app)', state: 'failure', description: 'Title type is wrong' },
      ...['merge-block', 'base-branch', 'title', 'ci-change', 'uat', 'uat-label', 'dependabot'].map(
        (check) => ({
          context: `pr-policy (app) / ${check}`,
          state: check === 'title' ? 'failure' : 'success',
          description: check === 'title' ? 'Title type is wrong' : 'Passed',
        }),
      ),
    ].map((status) => ({
      ...status,
      creator: { login },
      ...(overrides[status.context] === undefined
        ? {}
        : { description: overrides[status.context] }),
    }));

  it('posts nothing when the verdict and every per-check status are already posted', async () => {
    const deps = makeGateDeps({ combinedStatus: posted() });
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect(ops(deps)).toEqual(['gatherFacts', 'evaluatePolicy']);
  });

  it('posts again when one per-check status differs', async () => {
    const deps = makeGateDeps({ combinedStatus: posted({ 'pr-policy (app) / uat': 'Waiting' }) });
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect(ops(deps)).toContain('postVerdict');
  });

  it("posts its own verdict over another poster's identical statuses", async () => {
    const deps = makeGateDeps({ combinedStatus: posted({}, 'github-actions[bot]') });
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect(ops(deps)).toContain('postVerdict');
  });

  it('logs whether it posted', async () => {
    const deps = makeGateDeps({ combinedStatus: posted() });
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect(deps.log.entries.at(-1)?.fields['posted']).toBe(false);
  });

  it("reads the head's combined status once", async () => {
    const deps = makeGateDeps({ combinedStatus: posted() });
    await runPrPolicy(makeTarget(), SHADOW_CONFIG, 'd-1', deps);
    expect(deps.calls.filter(({ op }) => op === 'getJson').map(({ args }) => args)).toEqual([
      ['repos/rmartz/firebase-nextjs-template/commits/head1/statuses?per_page=100'],
    ]);
  });
});

describe('verdictName', () => {
  it('is the shadow name in shadow mode', () => {
    expect(verdictName(SHADOW_CONFIG)).toBe(PR_POLICY_SHADOW_NAME);
  });

  it('is pr-policy in live mode', () => {
    expect(verdictName(LIVE_CONFIG)).toBe('pr-policy');
  });
});
