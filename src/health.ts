/** The body of the server's liveness probe. */
export interface HealthReport {
  readonly service: string;
  readonly status: 'ok';
}

/** The service name the health probe reports. */
export const SERVICE_NAME = 'pr-lifecycle-app';

/** Builds the liveness report, served by `GET /api/webhook`. */
export function healthReport(): HealthReport {
  return { service: SERVICE_NAME, status: 'ok' };
}
