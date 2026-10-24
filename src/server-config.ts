/** The secrets and settings the server reads from its environment. */
export interface ServerConfig {
  readonly clientId: string;
  readonly privateKey: string;
  readonly webhookSecret: string;
  readonly botLogin: string;
}

/** The App's slug; its bot login is `<slug>[bot]`. */
export const DEFAULT_APP_SLUG = 'rmartz-pr-lifecycle';

const REQUIRED = [
  'PR_LIFECYCLE_CLIENT_ID',
  'PR_LIFECYCLE_PRIVATE_KEY',
  'PR_LIFECYCLE_WEBHOOK_SECRET',
] as const;

export type ConfigResult =
  | { readonly kind: 'ok'; readonly config: ServerConfig }
  | { readonly kind: 'missing'; readonly names: readonly string[] };

/**
 * Reads the server config from the environment. A missing secret is reported by
 * name (never by value) so the server can refuse deliveries rather than run
 * half-configured. A private key stored with escaped newlines (`\n`) is unescaped.
 */
export function readServerConfig(env: Readonly<Record<string, string | undefined>>): ConfigResult {
  const missing = REQUIRED.filter((name) => (env[name] ?? '') === '');
  if (missing.length > 0) {
    return { kind: 'missing', names: missing };
  }
  const slug = env['PR_LIFECYCLE_APP_SLUG'] ?? '';
  return {
    kind: 'ok',
    config: {
      clientId: env['PR_LIFECYCLE_CLIENT_ID'] ?? '',
      privateKey: (env['PR_LIFECYCLE_PRIVATE_KEY'] ?? '').replaceAll('\\n', '\n'),
      webhookSecret: env['PR_LIFECYCLE_WEBHOOK_SECRET'] ?? '',
      botLogin: `${slug === '' ? DEFAULT_APP_SLUG : slug}[bot]`,
    },
  };
}
