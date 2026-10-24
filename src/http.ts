import { createHttpClient, reconcilePullRequest } from '@rmartz/pr-lifecycle';
import type { HandlerDeps } from './handler.js';
import { handleWebhook } from './handler.js';
import { createTokenMinter } from './installation-token.js';
import type { Logger } from './logger.js';
import { createJsonLogger } from './logger.js';
import { createOpenPullsFinder } from './open-pulls.js';
import { toolConfig } from './repos.js';
import { createSandboxGit } from './sandbox-git.js';
import type { ServerConfig } from './server-config.js';
import { readServerConfig } from './server-config.js';
import { createVercelSandboxOpener } from './vercel-sandbox.js';

/** Keeps a promise running after the response is sent (Vercel's `waitUntil`). */
export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * One sandboxed git command, the VM's boot included before the first. Measured
 * at about 0.25–0.5 s to boot and 0.5 s for a fetch (rmartz/pr-lifecycle-app#8);
 * a minute means the sandbox is stuck, not slow.
 */
export const GIT_COMMAND_TIMEOUT_MS = 60_000;

/** Wires the production dependencies around the handler. */
export function productionDeps(config: ServerConfig, log: Logger): HandlerDeps {
  return {
    webhookSecret: config.webhookSecret,
    botLogin: config.botLogin,
    prLifecycleConfig: (fullName) => toolConfig(fullName, 'prLifecycle'),
    mintToken: createTokenMinter({ clientId: config.clientId, privateKey: config.privateKey }),
    createClient: createHttpClient,
    findOpenPulls: createOpenPullsFinder(),
    createGit: (token) =>
      createSandboxGit(token, createVercelSandboxOpener(), {
        commandTimeoutMs: GIT_COMMAND_TIMEOUT_MS,
      }),
    reconcile: reconcilePullRequest,
    log,
  };
}

export interface HttpOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly waitUntil: WaitUntil;
  readonly log?: Logger;
  /** Overrides the production wiring; tests inject fakes. */
  readonly deps?: (config: ServerConfig, log: Logger) => HandlerDeps;
}

/**
 * The webhook route over the Fetch API's Request/Response. Refuses every delivery
 * (500) while a secret is missing, rather than running half-configured.
 */
export async function handleHttpRequest(request: Request, options: HttpOptions): Promise<Response> {
  const log = options.log ?? createJsonLogger((line) => console.log(line));
  const read = readServerConfig(options.env);
  if (read.kind === 'missing') {
    log.error('server is missing configuration', { missing: read.names });
    return Response.json({ error: 'server not configured' }, { status: 500 });
  }
  const deps = (options.deps ?? productionDeps)(read.config, log);
  const body = await request.text();
  const result = handleWebhook({ header: (name) => request.headers.get(name), body }, deps);
  if (result.background !== undefined) {
    options.waitUntil(result.background);
  }
  return Response.json(result.body, { status: result.status });
}
