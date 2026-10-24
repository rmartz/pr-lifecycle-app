import { describe, expect, it } from 'vitest';
import { createJsonLogger } from '../src/logger.js';

describe('createJsonLogger', () => {
  it('writes one JSON line with the level, message and fields', () => {
    const lines: string[] = [];
    createJsonLogger((line) => lines.push(line)).warn('slow', { pr: 7 });
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { level: 'warn', message: 'slow', pr: 7 },
    ]);
  });
});
