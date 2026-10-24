/** The body of the server's liveness probe. */
export interface HealthReport {
  readonly service: string;
  readonly status: 'ok';
}

/** The service name the health probe reports. */
export const SERVICE_NAME = 'pr-lifecycle-app';

/**
 * Builds the liveness report. The webhook server (rmartz/pr-lifecycle#134) will
 * serve it from its health route; until then it is the placeholder that keeps the
 * toolchain exercising real source.
 */
export function healthReport(): HealthReport {
  return { service: SERVICE_NAME, status: 'ok' };
}
