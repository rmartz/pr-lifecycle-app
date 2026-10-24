import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';

/**
 * Checks GitHub's `X-Hub-Signature-256` header against the raw request body. The
 * header is `sha256=` followed by the hex HMAC-SHA256 of the body under the
 * webhook secret. Anything else (missing, wrong prefix, wrong length, wrong
 * digest) is rejected, and the digests are compared in constant time.
 */
export function verifySignature(secret: string, body: string, header: string | null): boolean {
  if (secret === '' || header === null || !header.startsWith(PREFIX)) {
    return false;
  }
  const expected = Buffer.from(createHmac('sha256', secret).update(body, 'utf8').digest('hex'));
  const received = Buffer.from(header.slice(PREFIX.length));
  return received.length === expected.length && timingSafeEqual(received, expected);
}
