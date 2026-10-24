import { MERGE_SAFETY_CHECK_NAME } from '@rmartz/merge-safety';
import type { IgnoreReason } from './events.js';
import { decideGateEvent } from './gate-events.js';
import type { WebhookRequest, WebhookResponse } from './handler.js';
import { readDelivery, respond } from './handler.js';
import type { LogFields } from './logger.js';
import { decideMergeSafetyEvent } from './merge-safety-events.js';
import type { Payload } from './payload.js';
import type { MergeSafetyConfig, MergeSafetyDeps } from './run-merge-safety.js';
import {
  MERGE_SAFETY_SHADOW_NAME,
  runMergeSafetyEvaluate,
  runMergeSafetyInvalidate,
} from './run-merge-safety.js';
import type { PrPolicyConfig, PrPolicyDeps } from './run-pr-policy.js';
import { runPrPolicy } from './run-pr-policy.js';

export interface GateHandlerDeps extends PrPolicyDeps, MergeSafetyDeps {
  readonly webhookSecret: string;
  readonly botLogin: string;
  /** pr-policy's settings for a repo, or undefined when it is unlisted or `off`. */
  readonly prPolicyConfig: (fullName: string) => PrPolicyConfig | undefined;
  /** merge-safety's settings for a repo, or undefined when it is unlisted or `off`. */
  readonly mergeSafetyConfig: (fullName: string) => MergeSafetyConfig | undefined;
}

/** What one tool made of a delivery: the work it started, or why it ignored it. */
type ToolOutcome =
  | { readonly accepted: true; readonly work: Promise<void> }
  | { readonly accepted: false; readonly reason: IgnoreReason };

function ignored(reason: IgnoreReason): ToolOutcome {
  return { accepted: false, reason };
}

function prPolicyOutcome(
  eventName: string,
  payload: Payload,
  deliveryId: string,
  deps: GateHandlerDeps,
): ToolOutcome {
  const decision = decideGateEvent(eventName, payload, {
    botLogin: deps.botLogin,
    isEnabled: (fullName) => deps.prPolicyConfig(fullName) !== undefined,
  });
  if (decision.kind === 'ignore') return ignored(decision.reason);
  const config = deps.prPolicyConfig(decision.target.repository.fullName);
  if (config === undefined) return ignored('repo-not-enabled');
  return { accepted: true, work: runPrPolicy(decision.target, config, deliveryId, deps) };
}

function mergeSafetyOutcome(
  eventName: string,
  payload: Payload,
  deliveryId: string,
  deps: GateHandlerDeps,
): ToolOutcome {
  const decision = decideMergeSafetyEvent(eventName, payload, {
    botLogin: deps.botLogin,
    checkNames: [MERGE_SAFETY_CHECK_NAME, MERGE_SAFETY_SHADOW_NAME],
    isEnabled: (fullName) => deps.mergeSafetyConfig(fullName) !== undefined,
  });
  switch (decision.kind) {
    case 'ignore':
      return ignored(decision.reason);
    case 'evaluate': {
      const config = deps.mergeSafetyConfig(decision.target.repository.fullName);
      if (config === undefined) return ignored('repo-not-enabled');
      return {
        accepted: true,
        work: runMergeSafetyEvaluate(decision.target, config, deliveryId, deps),
      };
    }
    case 'invalidate': {
      const config = deps.mergeSafetyConfig(decision.repository.fullName);
      if (config === undefined) return ignored('repo-not-enabled');
      return {
        accepted: true,
        work: runMergeSafetyInvalidate(
          decision.repository,
          decision.baseBranch,
          config,
          deliveryId,
          deps,
        ),
      };
    }
  }
}

async function settle(work: readonly Promise<void>[]): Promise<void> {
  await Promise.all(work);
}

function summary(outcome: ToolOutcome): string {
  return outcome.accepted ? 'accepted' : outcome.reason;
}

/**
 * Handles one delivery for the gate App. The signature is checked first, as for
 * the actor. Each gate tool (pr-policy, merge-safety) decides on its own whether
 * the delivery concerns it; any accepted work runs in the background after a
 * `202`, and a delivery neither tool wants is acknowledged with a `200`. The
 * body says what each tool made of it.
 */
export function handleGateWebhook(request: WebhookRequest, deps: GateHandlerDeps): WebhookResponse {
  const delivery = readDelivery(request, deps.webhookSecret, deps.log);
  if (delivery.kind === 'rejected') {
    return delivery.response;
  }
  const { eventName, deliveryId, payload } = delivery;
  const prPolicy = prPolicyOutcome(eventName, payload, deliveryId, deps);
  const mergeSafety = mergeSafetyOutcome(eventName, payload, deliveryId, deps);
  const body = { prPolicy: summary(prPolicy), mergeSafety: summary(mergeSafety) };
  const work = [prPolicy, mergeSafety].flatMap((outcome) =>
    outcome.accepted ? [outcome.work] : [],
  );
  if (work.length === 0) {
    return respond(200, body);
  }
  const fields: LogFields = { delivery: deliveryId, event: eventName, ...body };
  deps.log.info('accepted', fields);
  return { status: 202, body, background: settle(work) };
}
