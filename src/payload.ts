/**
 * Narrow readers over an untrusted webhook payload. The signature proves GitHub
 * sent it, not that every field has the shape we expect, so each read checks the
 * type and returns undefined rather than trusting a cast.
 */

export type Payload = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses a request body into a payload object, or undefined if it isn't one. */
export function parsePayload(body: string): Payload | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The object at `key`, or undefined. */
export function objectAt(payload: Payload | undefined, key: string): Payload | undefined {
  const value = payload?.[key];
  return isRecord(value) ? value : undefined;
}

/** The string at `key`, or undefined. */
export function stringAt(payload: Payload | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** The positive integer at `key`, or undefined. */
export function idAt(payload: Payload | undefined, key: string): number | undefined {
  const value = payload?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The objects in the array at `key` (non-objects dropped), or an empty list. */
export function objectsAt(payload: Payload | undefined, key: string): readonly Payload[] {
  const value = payload?.[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
