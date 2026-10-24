/**
 * Which App a deployment serves. Each role runs from its own Vercel project and
 * holds only its own App's credentials:
 * - `actor`: `rmartz-pr-lifecycle`, the reconciler (labels, sign-off, arming).
 * - `gate`: the gate App that posts the `pr-policy` and `merge-safety` checks.
 *   It has no merge-capable permission.
 */
export type AppRole = 'actor' | 'gate';

/** The secrets and settings the server reads from its environment. */
export interface ServerConfig {
  readonly role: AppRole;
  readonly clientId: string;
  readonly privateKey: string;
  readonly webhookSecret: string;
  readonly botLogin: string;
}

/** The variable that selects a deployment's role. */
export const ROLE_VARIABLE = 'PR_APP_ROLE';

interface RoleVariables {
  readonly clientId: string;
  readonly privateKey: string;
  readonly webhookSecret: string;
  readonly slug: string;
  /** The App's slug when the slug variable is unset; its bot login is `<slug>[bot]`. */
  readonly defaultSlug: string;
}

/** The environment variables each role reads. A role never reads the other's. */
export const ROLE_VARIABLES: Readonly<Record<AppRole, RoleVariables>> = {
  actor: {
    clientId: 'PR_LIFECYCLE_CLIENT_ID',
    privateKey: 'PR_LIFECYCLE_PRIVATE_KEY',
    webhookSecret: 'PR_LIFECYCLE_WEBHOOK_SECRET',
    slug: 'PR_LIFECYCLE_APP_SLUG',
    defaultSlug: 'rmartz-pr-lifecycle',
  },
  gate: {
    clientId: 'PR_GATE_CLIENT_ID',
    privateKey: 'PR_GATE_PRIVATE_KEY',
    webhookSecret: 'PR_GATE_WEBHOOK_SECRET',
    slug: 'PR_GATE_APP_SLUG',
    defaultSlug: 'rmartz-pr-gate',
  },
};

export type ConfigResult =
  | { readonly kind: 'ok'; readonly config: ServerConfig }
  | { readonly kind: 'missing'; readonly names: readonly string[] };

type Env = Readonly<Record<string, string | undefined>>;

function readRole(env: Env): AppRole | undefined {
  const value = env[ROLE_VARIABLE];
  return value === 'actor' || value === 'gate' ? value : undefined;
}

/**
 * Reads the server config from the environment: the role first, then that
 * role's App credentials only. A missing or unknown role, or a missing secret,
 * is reported by name (never by value) so the server can refuse deliveries
 * rather than run half-configured. A private key stored with escaped newlines
 * (`\n`) is unescaped.
 */
export function readServerConfig(env: Env): ConfigResult {
  const role = readRole(env);
  if (role === undefined) {
    return { kind: 'missing', names: [ROLE_VARIABLE] };
  }
  const names = ROLE_VARIABLES[role];
  const required = [names.clientId, names.privateKey, names.webhookSecret];
  const missing = required.filter((name) => (env[name] ?? '') === '');
  if (missing.length > 0) {
    return { kind: 'missing', names: missing };
  }
  const slug = env[names.slug] ?? '';
  return {
    kind: 'ok',
    config: {
      role,
      clientId: env[names.clientId] ?? '',
      privateKey: (env[names.privateKey] ?? '').replaceAll('\\n', '\n'),
      webhookSecret: env[names.webhookSecret] ?? '',
      botLogin: `${slug === '' ? names.defaultSlug : slug}[bot]`,
    },
  };
}
