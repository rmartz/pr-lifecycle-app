import type { GitHubClient } from '@rmartz/pr-policy';

/** One write a fake client received. */
export interface ClientWrite {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/**
 * A `GitHubClient` over a table of raw API responses keyed by exact path. An
 * unlisted path reads as a failure (`null`), as the real clients report one.
 * Writes are recorded and succeed unless their path is in `failing`.
 */
export interface FakeClient extends GitHubClient {
  readonly routes: Map<string, unknown>;
  readonly writes: ClientWrite[];
  readonly reads: string[];
  readonly failing: Set<string>;
}

export function makeFakeClient(routes: Record<string, unknown> = {}): FakeClient {
  const table = new Map(Object.entries(routes));
  const writes: ClientWrite[] = [];
  const reads: string[] = [];
  const failing = new Set<string>();
  const read = (path: string): unknown => {
    reads.push(path);
    return table.has(path) ? table.get(path) : null;
  };
  const write = (method: string, path: string, body: unknown): unknown => {
    writes.push({ method, path, body });
    return failing.has(path) ? null : {};
  };
  return {
    routes: table,
    writes,
    reads,
    failing,
    getJson: (path) => Promise.resolve(read(path)),
    list: (path, key) => {
      const value = read(path);
      if (value === null) return Promise.resolve(null);
      const items = key === undefined ? value : (value as Record<string, unknown>)[key];
      return Promise.resolve(Array.isArray(items) ? (items as unknown[]) : null);
    },
    getRaw: (path) => {
      const value = read(path);
      return Promise.resolve(typeof value === 'string' ? value : null);
    },
    send: (method, path, body) => Promise.resolve(write(method, path, body)),
    addLabels: (repo, issue, labels) => {
      write('POST', `repos/${repo}/issues/${issue}/labels`, { labels });
      return Promise.resolve();
    },
    removeLabel: (repo, issue, label) => {
      const path = `repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`;
      write('DELETE', path, undefined);
      return Promise.resolve();
    },
  };
}
