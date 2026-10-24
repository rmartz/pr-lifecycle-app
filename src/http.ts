import { createHttpClient, reconcilePullRequest } from '@rmartz/pr-lifecycle';
import type { GateHandlerDeps } from './gate-handler.js';
import { handleGateWebhook } from './gate-handler.js';
import type { HandlerDeps, WebhookRequest, WebhookResponse } from './handler.js';
import { handleWebhook } from './handler.js';
import { createTokenMinter, PR_LIFECYCLE_PERMISSIONS } from './installation-token.js';
import type { Logger } from './logger.js';
import { createJsonLogger } from './logger.js';
import { createOpenPullsFinder } from './open-pulls.js';
import { toolConfig } from './repos.js';
import type { ServerConfig } from './server-config.js';
import { readServerConfig } from './server-config.js';

/** Keeps a promise running after the response is sent (Vercel's `waitUntil`). */
export type WaitUntil = (promise: Promise<unknown>) => void;

/** Wires the actor role's production dependencies around its handler. */
export function productionDeps(config: ServerConfig, log: Logger): HandlerDeps {
  return {
    webhookSecret: config.webhookSecret,
    botLogin: config.botLogin,
    prLifecycleConfig: (fullName) => toolConfig(fullName, 'prLifecycle'),
    mintToken: createTokenMinter({
      clientId: config.clientId,
      privateKey: config.privateKey,
      permissions: PR_LIFECYCLE_PERMISSIONS,
    }),
    createClient: createHttpClient,
    findOpenPulls: createOpenPullsFinder(),
    reconcile: reconcilePullRequest,
    log,
  };
}

/** Wires the gate role's production dependencies around its handler. */
export function gateDeps(config: ServerConfig, log: Logger): GateHandlerDeps {
  return { webhookSecret: config.webhookSecret, botLogin: config.botLogin, log };
}

export interface HttpOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly waitUntil: WaitUntil;
  readonly log?: Logger;
  /** Overrides the actor's production wiring; tests inject fakes. */
  readonly deps?: (config: ServerConfig, log: Logger) => HandlerDeps;
  /** Overrides the gate's production wiring; tests inject fakes. */
  readonly gateDeps?: (config: ServerConfig, log: Logger) => GateHandlerDeps;
}

/**
 * Hands a delivery to the handler of the deployment's role, wired with that
 * role's credentials only. A deployment never runs the other role's handler.
 */
function route(
  request: WebhookRequest,
  config: ServerConfig,
  log: Logger,
  options: HttpOptions,
): WebhookResponse {
  switch (config.role) {
    case 'actor':
      return handleWebhook(request, (options.deps ?? productionDeps)(config, log));
    case 'gate':
      return handleGateWebhook(request, (options.gateDeps ?? gateDeps)(config, log));
  }
}

/**
 * The webhook route over the Fetch API's Request/Response, served by the
 * deployment's role (`PR_APP_ROLE`). Refuses every delivery (500) while the role
 * or one of its secrets is missing, rather than running half-configured.
 */
export async function handleHttpRequest(request: Request, options: HttpOptions): Promise<Response> {
  const log = options.log ?? createJsonLogger((line) => console.log(line));
  const read = readServerConfig(options.env);
  if (read.kind === 'missing') {
    log.error('server is missing configuration', { missing: read.names });
    return Response.json({ error: 'server not configured' }, { status: 500 });
  }
  const body = await request.text();
  const webhook = { header: (name: string) => request.headers.get(name), body };
  const result = route(webhook, read.config, log, options);
  if (result.background !== undefined) {
    options.waitUntil(result.background);
  }
  return Response.json(result.body, { status: result.status });
}
