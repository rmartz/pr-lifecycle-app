import type {
  CheckStatus,
  GitHubClient,
  PolicyEvaluation,
  PullRequestFacts,
} from '@rmartz/pr-policy';
import type { GateHandlerDeps } from '../src/gate-handler.js';
import type { Payload } from '../src/payload.js';
import type { MergeSafetyConfig } from '../src/merge-safety-evaluate.js';
import type { PrPolicyConfig } from '../src/run-pr-policy.js';
import { INSTALLATION_ID, makeLogger, makeRepository, SECRET } from './fixtures.js';

export const GATE_BOT = 'rmartz-pr-gate[bot]';

export const SHADOW_CONFIG: PrPolicyConfig = {
  mode: 'shadow',
  policy: {
    skipUat: false,
    requireUatLabel: true,
    retitleDependabotCi: true,
    signOffStatusCreators: ['rmartz-pr-lifecycle[bot]'],
  },
};

export const LIVE_CONFIG: PrPolicyConfig = { ...SHADOW_CONFIG, mode: 'live' };

export function makeStatusEvent(overrides: Payload = {}): Payload {
  return {
    installation: { id: INSTALLATION_ID },
    repository: makeRepository(),
    sender: { login: 'rmartz-pr-lifecycle[bot]' },
    context: 'pr-lifecycle/sign-off',
    state: 'success',
    sha: 'abc123',
    ...overrides,
  };
}

export function makeFacts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    title: 'feat: add a thing',
    body: 'Adds a thing.',
    author: { login: 'rmartz', type: 'User' },
    labels: ['no UAT needed'],
    changedFiles: ['src/a.ts'],
    workflowChanges: [],
    manifestChanges: [],
    signOffs: [],
    ...overrides,
  };
}

export function makeEvaluation(overrides: Partial<PolicyEvaluation> = {}): PolicyEvaluation {
  return {
    outcome: 'failure',
    title: 'Title type is wrong',
    summary: 'summary',
    findings: [{ check: 'title', effect: 'block', message: 'Title type is wrong' }],
    labelsToAdd: ['CI approval needed'],
    labelsToRemove: [],
    ...overrides,
  };
}

/** One call to the fake GitHub I/O: which operation, and its arguments. */
export interface IoCall {
  readonly op: string;
  readonly args: readonly unknown[];
}

/** A client whose only write the runner makes itself (the retitle) is recorded. */
export function makeClient(token: string, calls: IoCall[], sendOk = true): GitHubClient {
  const unused = () => Promise.reject(new Error(`not expected for ${token}`));
  return {
    getJson: unused,
    list: unused,
    getRaw: unused,
    send: (method, path, body) => {
      calls.push({ op: 'send', args: [method, path, body] });
      return Promise.resolve(sendOk ? {} : null);
    },
    addLabels: unused,
    removeLabel: unused,
  };
}

export interface FakeGateDeps extends GateHandlerDeps {
  readonly log: ReturnType<typeof makeLogger>;
  readonly minted: { installationId: number; repo: string }[];
  readonly calls: IoCall[];
}

export interface GateOptions {
  readonly facts?: PullRequestFacts;
  readonly evaluation?: PolicyEvaluation;
  readonly openPrs?: readonly number[];
  readonly statusesOk?: boolean;
  readonly sendOk?: boolean;
  readonly config?: PrPolicyConfig | undefined;
  /** merge-safety's config for the template; off unless given. */
  readonly mergeSafety?: MergeSafetyConfig;
  /** The client merge-safety (and the retitle) run against; a recording fake by default. */
  readonly client?: GitHubClient;
  readonly overrides?: Partial<GateHandlerDeps>;
}

export function makeGateDeps(options: GateOptions = {}): FakeGateDeps {
  const minted: FakeGateDeps['minted'] = [];
  const calls: IoCall[] = [];
  const log = makeLogger();
  const record = (op: string, args: readonly unknown[]) => calls.push({ op, args });
  const config = 'config' in options ? options.config : SHADOW_CONFIG;
  return {
    webhookSecret: SECRET,
    botLogin: GATE_BOT,
    prPolicyConfig: (fullName) =>
      fullName.toLowerCase() === 'rmartz/firebase-nextjs-template' ? config : undefined,
    mintToken: (installationId, repo) => {
      minted.push({ installationId, repo });
      return Promise.resolve(`gate-token-for-${installationId}-${repo}`);
    },
    mergeSafetyConfig: (fullName) =>
      fullName.toLowerCase() === 'rmartz/firebase-nextjs-template'
        ? options.mergeSafety
        : undefined,
    createClient: (token) => options.client ?? makeClient(token, calls, options.sendOk ?? true),
    rateLimitRemaining: () => 4321,
    apiCalls: () => 17,
    lastFailure: () => ({ status: 403, path: '/repos/rmartz/firebase-nextjs-template/pulls' }),
    sleep: () => Promise.resolve(),
    now: () => new Date('2026-10-24T12:00:00Z'),
    policy: {
      gatherFacts: (target) => {
        record('gatherFacts', [target.repo, target.pr]);
        // A fresh copy per call, so a runner's edit to one can't leak into the next.
        return Promise.resolve({ facts: { ...(options.facts ?? makeFacts()) }, headSha: 'head1' });
      },
      openPullRequestsAtHead: (target, sha) => {
        record('openPullRequestsAtHead', [target.repo, sha]);
        return Promise.resolve([...(options.openPrs ?? [51])]);
      },
      evaluatePolicy: (facts) => {
        record('evaluatePolicy', [facts.title]);
        return Promise.resolve(options.evaluation ?? makeEvaluation());
      },
      applyLabelEdits: (target, evaluation) => {
        record('applyLabelEdits', [target.pr, evaluation.labelsToAdd]);
        return Promise.resolve();
      },
      postVerdict: (target, headSha, evaluation, verdict) => {
        record('postVerdict', [target.pr, headSha, evaluation.outcome, verdict.name]);
        return Promise.resolve();
      },
      postCheckStatuses: (target, sha, statuses: readonly CheckStatus[], opts) => {
        record('postCheckStatuses', [target.repo, sha, statuses.length, opts.context]);
        return Promise.resolve(options.statusesOk ?? true);
      },
    },
    ...options.overrides,
    log,
    minted,
    calls,
  };
}
