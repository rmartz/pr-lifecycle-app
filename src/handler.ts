import type { IgnoreReason } from './events.js';
import { decideEvent } from './events.js';
import type { Logger } from './logger.js';
import type { Payload } from './payload.js';
import { parsePayload } from './payload.js';
import type { PrLifecycleConfig } from './run-target.js';
import type { RunDeps } from './run-target.js';
import { runTarget } from './run-target.js';
import { verifySignature } from './signature.js';

/** The parts of an HTTP request the handler reads. */
export interface WebhookRequest {
  readonly header: (name: string) => string | null;
  /** The raw body, exactly as received: the signature covers these bytes. */
  readonly body: string;
}

/**
 * What to send back, plus the reconcile to finish after responding. GitHub gives a
 * delivery 10 seconds, less than a reconcile (with its settle wait) can take, so
 * the host keeps `background` running past the response (Vercel's `waitUntil`).
 */
export interface WebhookResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly background: Promise<void> | undefined;
}

export interface HandlerDeps extends RunDeps {
  readonly webhookSecret: string;
  readonly botLogin: string;
  /** pr-lifecycle's settings for a repo, or undefined when it is unlisted or `off`. */
  readonly prLifecycleConfig: (fullName: string) => PrLifecycleConfig | undefined;
}

export function respond(status: number, body: Readonly<Record<string, unknown>>): WebhookResponse {
  return { status, body, background: undefined };
}

function ignored(reason: IgnoreReason): WebhookResponse {
  return respond(200, { ignored: reason });
}

/** A delivery that passed the signature check and parsed, or the response rejecting it. */
export type Delivery =
  | {
      readonly kind: 'verified';
      readonly eventName: string;
      readonly deliveryId: string;
      readonly payload: Payload;
    }
  | { readonly kind: 'rejected'; readonly response: WebhookResponse };

/**
 * Checks a delivery's signature before anything reads its body, then parses it.
 * An unsigned or mis-signed delivery gets `401`; a signed body that isn't a
 * webhook payload gets `400`. Every role's handler starts here.
 */
export function readDelivery(request: WebhookRequest, secret: string, log: Logger): Delivery {
  if (!verifySignature(secret, request.body, request.header('x-hub-signature-256'))) {
    log.warn('rejected a delivery with a bad signature', {
      delivery: request.header('x-github-delivery'),
    });
    return { kind: 'rejected', response: respond(401, { error: 'bad signature' }) };
  }
  const eventName = request.header('x-github-event');
  const payload = parsePayload(request.body);
  if (eventName === null || payload === undefined) {
    return { kind: 'rejected', response: respond(400, { error: 'not a webhook delivery' }) };
  }
  const deliveryId = request.header('x-github-delivery') ?? 'unknown';
  return { kind: 'verified', eventName, deliveryId, payload };
}

/**
 * Handles one webhook delivery. The signature is checked before anything else
 * reads the body; an unsigned or mis-signed delivery is rejected and does nothing.
 * A valid delivery for a repo that isn't enabled, or that the App caused itself, is
 * acknowledged and ignored.
 */
export function handleWebhook(request: WebhookRequest, deps: HandlerDeps): WebhookResponse {
  const delivery = readDelivery(request, deps.webhookSecret, deps.log);
  if (delivery.kind === 'rejected') {
    return delivery.response;
  }
  const { eventName, deliveryId, payload } = delivery;
  const decision = decideEvent(eventName, payload, {
    botLogin: deps.botLogin,
    isEnabled: (fullName) => deps.prLifecycleConfig(fullName) !== undefined,
  });
  switch (decision.kind) {
    case 'ignore':
      return ignored(decision.reason);
    case 'reconcile': {
      const config = deps.prLifecycleConfig(decision.target.repository.fullName);
      if (config === undefined) {
        return ignored('repo-not-enabled');
      }
      deps.log.info('accepted', {
        delivery: deliveryId,
        event: eventName,
        repo: decision.target.repository.fullName,
        prs: decision.target.prs,
      });
      return {
        status: 202,
        body: { accepted: true },
        background: runTarget(decision.target, config, deliveryId, deps),
      };
    }
  }
}
