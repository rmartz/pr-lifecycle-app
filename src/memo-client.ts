import type { GitHubClient } from '@rmartz/pr-policy';

/**
 * A client that answers each repeated read from the first response within one
 * delivery, so a fan-out reads what every PR shares once: the base tip, each
 * base commit, the base's check-runs and required checks, and the compares.
 *
 * Reads whose answer the run itself changes or waits on are never cached: a
 * PR (re-read while GitHub computes `mergeable`) and the check-run listings by
 * name (read again after the run posts). Writes always pass through. A failed
 * read isn't cached, so a later attempt still asks GitHub.
 */
export function memoizeReads(client: GitHubClient): GitHubClient {
  const cache = new Map<string, Promise<unknown>>();
  const fresh = (path: string) => /\/pulls\/\d+$/.test(path) || path.includes('check_name=');
  const remember = <T>(key: string, path: string, read: () => Promise<T>): Promise<T> => {
    if (fresh(path)) return read();
    const hit = cache.get(key);
    if (hit !== undefined) return hit as Promise<T>;
    const pending = read();
    cache.set(key, pending);
    void forgetFailure(cache, key, pending);
    return pending;
  };
  return {
    ...client,
    getJson: (path) => remember(`json ${path}`, path, () => client.getJson(path)),
    list: (path, key) => remember(`list ${key ?? ''} ${path}`, path, () => client.list(path, key)),
    getRaw: (path) => remember(`raw ${path}`, path, () => client.getRaw(path)),
    send: (method, path, body) => client.send(method, path, body),
    addLabels: (repo, issue, labels) => client.addLabels(repo, issue, labels),
    removeLabel: (repo, issue, label) => client.removeLabel(repo, issue, label),
  };
}

async function forgetFailure(
  cache: Map<string, Promise<unknown>>,
  key: string,
  pending: Promise<unknown>,
): Promise<void> {
  try {
    if ((await pending) === null) cache.delete(key);
  } catch {
    cache.delete(key);
  }
}
