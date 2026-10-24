import { describe, expect, it } from 'vitest';

import { healthReport } from '../src/health.js';

describe('healthReport', () => {
  it('reports the service as ok', () => {
    expect(healthReport()).toEqual({ service: 'pr-lifecycle-app', status: 'ok' });
  });
});
