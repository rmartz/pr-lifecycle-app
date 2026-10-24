import { decideGateEvent } from './gate-events.js';
import type { WebhookRequest, WebhookResponse } from './handler.js';
import { readDelivery, respond } from './handler.js';
import type { PrPolicyConfig, PrPolicyDeps } from './run-pr-policy.js';
import { runPrPolicy } from './run-pr-policy.js';

export interface GateHandlerDeps extends PrPolicyDeps {
  readonly webhookSecret: string;
  readonly botLogin: string;
  /** pr-policy's settings for a repo, or undefined when it is unlisted or `off`. */
  readonly prPolicyConfig: (fullName: string) => PrPolicyConfig | undefined;
}

/**
 * Handles one delivery for the gate App. The signature is checked first, as for
 * the actor. A delivery that changes what pr-policy judges, for a repo where
 * pr-policy is enabled, is acknowledged (`202`) and evaluated in the background;
 * anything else, including the gate's own writes, is acknowledged and ignored.
 */
export function handleGateWebhook(request: WebhookRequest, deps: GateHandlerDeps): WebhookResponse {
  const delivery = readDelivery(request, deps.webhookSecret, deps.log);
  if (delivery.kind === 'rejected') {
    return delivery.response;
  }
  const { eventName, deliveryId, payload } = delivery;
  const decision = decideGateEvent(eventName, payload, {
    botLogin: deps.botLogin,
    isEnabled: (fullName) => deps.prPolicyConfig(fullName) !== undefined,
  });
  switch (decision.kind) {
    case 'ignore':
      return respond(200, { ignored: decision.reason });
    case 'evaluate': {
      const { target } = decision;
      const config = deps.prPolicyConfig(target.repository.fullName);
      if (config === undefined) {
        return respond(200, { ignored: 'repo-not-enabled' });
      }
      deps.log.info('accepted', {
        delivery: deliveryId,
        event: eventName,
        repo: target.repository.fullName,
        tool: 'pr-policy',
        prs: target.prs,
        sha: target.headSha ?? null,
      });
      return {
        status: 202,
        body: { accepted: true },
        background: runPrPolicy(target, config, deliveryId, deps),
      };
    }
  }
}
