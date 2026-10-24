import { createHmac } from 'node:crypto';
import type {
  GitHubClient,
  HttpClientOptions,
  ReconcileOptions,
  ReconcilePolicy,
  ReconcileResult,
} from '@rmartz/pr-lifecycle';
import type { HandlerDeps } from '../src/handler.js';
import type { LogFields, Logger } from '../src/logger.js';
import type { Payload } from '../src/payload.js';
import type { PrLifecycleConfig } from '../src/run-target.js';
import type { SandboxGit } from '../src/sandbox-git.js';

export const BOT_LOGIN = 'rmartz-pr-lifecycle[bot]';
export const SECRET = 'webhook-secret-for-tests';
export const REPO_ID = 4242;
export const INSTALLATION_ID = 777;

export function sign(body: string, secret: string = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

export function makeRepository(overrides: Payload = {}): Payload {
  return {
    id: REPO_ID,
    name: 'firebase-nextjs-template',
    full_name: 'rmartz/firebase-nextjs-template',
    owner: { login: 'rmartz' },
    ...overrides,
  };
}

function base(overrides: Payload): Payload {
  return {
    installation: { id: INSTALLATION_ID },
    repository: makeRepository(),
    sender: { login: 'rmartz' },
    ...overrides,
  };
}

export function makePullRequestEvent(overrides: Payload = {}): Payload {
  return base({ action: 'opened', pull_request: { number: 31 }, ...overrides });
}

export function makeReviewEvent(overrides: Payload = {}): Payload {
  return base({ action: 'submitted', pull_request: { number: 32 }, ...overrides });
}

export function makePullRef(number: number, baseRepoId: number = REPO_ID): Payload {
  return { number, base: { repo: { id: baseRepoId } } };
}

export function makeCheckSuiteEvent(suite: Payload = {}, overrides: Payload = {}): Payload {
  return base({
    action: 'completed',
    check_suite: { head_sha: 'abc123', pull_requests: [makePullRef(33)], ...suite },
    ...overrides,
  });
}

export function makeWorkflowRunEvent(run: Payload = {}, overrides: Payload = {}): Payload {
  return base({
    action: 'completed',
    workflow_run: { head_sha: 'def456', pull_requests: [makePullRef(34)], ...run },
    ...overrides,
  });
}

export interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: LogFields;
}

export function makeLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at =
    (level: LogEntry['level']) =>
    (message: string, fields: LogFields): void => {
      entries.push({ level, message, fields });
    };
  return { entries, info: at('info'), warn: at('warn'), error: at('error') };
}

export function makeReconcileResult(): ReconcileResult {
  return {
    plan: {
      state: 'review-requested',
      addLabels: ['review requested'],
      removeLabels: ['changes requested'],
      autoMerge: 'none',
      update: 'none',
    },
    botEligibility: {
      eligible: false,
      reason: 'not a bot PR',
      prType: undefined,
      updateType: undefined,
    },
    lineage: undefined,
    skippedAutoMerge: undefined,
    skippedUpdate: undefined,
    skippedSignOffStatus: false,
    settledMs: 0,
    autoMerge: 'none',
    deferredAutoMerge: undefined,
  };
}

export interface ReconcileCall {
  readonly client: GitHubClient;
  readonly pr: number;
  readonly policy: ReconcilePolicy;
  readonly options: ReconcileOptions;
}

export interface FakeDeps extends HandlerDeps {
  readonly log: ReturnType<typeof makeLogger>;
  readonly minted: { installationId: number; repo: string }[];
  readonly clients: HttpClientOptions[];
  readonly lookups: { token: string; owner: string; repo: string; sha: string }[];
  readonly reconciles: ReconcileCall[];
  /** The token of each `createGit` call, and `closed` once its `close` ran. */
  readonly gits: { token: string; closed: boolean }[];
}

/** A carry-over git that never runs a command, as for a PR with no earlier review. */
export function makeSandboxGit(onClose: () => string | undefined = () => undefined): SandboxGit {
  return {
    git: { run: () => Promise.reject(new Error('no git in this test')) },
    close: () => Promise.resolve(onClose()),
  };
}

export const TEMPLATE_CONFIG: PrLifecycleConfig = {
  mode: 'shadow',
  policy: { uat: 'on', armAutoMerge: false },
};

export function makeDeps(overrides: Partial<HandlerDeps> = {}): FakeDeps {
  const minted: FakeDeps['minted'] = [];
  const clients: HttpClientOptions[] = [];
  const lookups: FakeDeps['lookups'] = [];
  const reconciles: ReconcileCall[] = [];
  const gits: FakeDeps['gits'] = [];
  const log = makeLogger();
  return {
    webhookSecret: SECRET,
    botLogin: BOT_LOGIN,
    prLifecycleConfig: (fullName) =>
      fullName.toLowerCase() === 'rmartz/firebase-nextjs-template' ? TEMPLATE_CONFIG : undefined,
    mintToken: (installationId, repo) => {
      minted.push({ installationId, repo });
      return Promise.resolve(`token-for-${installationId}-${repo}`);
    },
    createClient: (options) => {
      clients.push(options);
      return { token: options.token } as unknown as GitHubClient;
    },
    findOpenPulls: (token, owner, repo, sha) => {
      lookups.push({ token, owner, repo, sha });
      return Promise.resolve([51]);
    },
    createGit: (token) => {
      const entry = { token, closed: false };
      gits.push(entry);
      return makeSandboxGit(() => {
        entry.closed = true;
        return undefined;
      });
    },
    reconcile: (client, pr, policy, options) => {
      reconciles.push({ client, pr, policy, options });
      return Promise.resolve(makeReconcileResult());
    },
    ...overrides,
    log,
    minted,
    clients,
    lookups,
    reconciles,
    gits,
  };
}
