import { describe, expect, it } from 'vitest';
import { verifySignature } from '../src/signature.js';
import { SECRET, sign } from './fixtures.js';

const BODY = '{"action":"opened"}';

describe('verifySignature', () => {
  it('accepts the HMAC of the body under the secret', () => {
    expect(verifySignature(SECRET, BODY, sign(BODY))).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(verifySignature(SECRET, BODY, null)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifySignature(SECRET, BODY, sign(BODY, 'another-secret'))).toBe(false);
  });

  it('rejects a signature over a different body', () => {
    expect(verifySignature(SECRET, '{"action":"closed"}', sign(BODY))).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    expect(verifySignature(SECRET, BODY, sign(BODY).replace('sha256=', 'sha1='))).toBe(false);
  });

  it('rejects a truncated digest', () => {
    expect(verifySignature(SECRET, BODY, sign(BODY).slice(0, -2))).toBe(false);
  });

  it('rejects everything when the secret is empty', () => {
    expect(verifySignature('', BODY, sign(BODY, ''))).toBe(false);
  });
});
