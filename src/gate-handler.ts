import type { WebhookRequest, WebhookResponse } from './handler.js';
import { readDelivery, respond } from './handler.js';
import type { Logger } from './logger.js';

export interface GateHandlerDeps {
  readonly webhookSecret: string;
  readonly botLogin: string;
  readonly log: Logger;
}

/**
 * Handles one delivery for the gate App. The signature is checked first, as for
 * the actor. No gate tool is routed yet (pr-policy and merge-safety arrive with
 * their own routes), so every verified delivery is acknowledged and ignored.
 */
export function handleGateWebhook(request: WebhookRequest, deps: GateHandlerDeps): WebhookResponse {
  const delivery = readDelivery(request, deps.webhookSecret, deps.log);
  if (delivery.kind === 'rejected') {
    return delivery.response;
  }
  return respond(200, { ignored: 'unsubscribed-event' });
}
