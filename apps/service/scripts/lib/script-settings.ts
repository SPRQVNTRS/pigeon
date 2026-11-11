/**
 * Deployment-specific values the AWS scripts need.
 *
 * They name buckets, a receiving domain and a public URL that belong to one
 * deployment, so the repo carries no defaults for them. This is the only file
 * that reads them from the environment. A script asks for the settings it
 * needs before its first AWS call, and a missing one stops it with a message
 * that names the variable.
 */

const SETTINGS = {
  publicUrl: {
    envName: 'PIGEON_PUBLIC_URL',
    meaning: 'public https base URL of this pigeon deployment, for example https://pigeon.example.com',
  },
  inboundBucket: {
    envName: 'PIGEON_INBOUND_BUCKET',
    meaning: 'S3 bucket that holds received tenant mail',
  },
  dmarcBucket: {
    envName: 'PIGEON_DMARC_BUCKET',
    meaning: 'S3 bucket that holds received DMARC aggregate reports',
  },
  dmarcDomain: {
    envName: 'PIGEON_DMARC_DOMAIN',
    meaning: 'domain that receives DMARC aggregate reports, for example dmarc.example.com',
  },
} as const;

export type SettingName = keyof typeof SETTINGS;

export type ScriptSettings<Name extends SettingName> = Record<Name, string>;

export type SettingsEnv = Readonly<Record<string, string | undefined>>;

function normalisePublicUrl(raw: string): string {
  const envName = SETTINGS.publicUrl.envName;
  const trimmed = raw.trim().replace(/\/+$/, '');
  const parsed = URL.canParse(trimmed) ? new URL(trimmed) : null;
  if (!parsed || parsed.protocol !== 'https:') {
    throw new Error(`${envName} must be an https URL such as https://pigeon.example.com, got "${raw}"`);
  }
  return trimmed;
}

/**
 * Read the named settings from the environment. Throws one error that lists
 * every missing variable. `publicUrl` comes back without a trailing slash.
 */
export function readScriptSettings<Name extends SettingName>(
  names: readonly Name[],
  env: SettingsEnv = process.env,
): ScriptSettings<Name> {
  const missing = names.filter((name) => !env[SETTINGS[name].envName]?.trim());
  if (missing.length > 0) {
    const lines = missing.map((name) => `  - ${SETTINGS[name].envName}: ${SETTINGS[name].meaning}`);
    throw new Error(
      `Missing environment variables for the AWS scripts:\n${lines.join('\n')}\n` +
        'Set them before you run the script. See apps/service/scripts/README.md.',
    );
  }

  const values = {} as ScriptSettings<Name>;
  for (const name of names) {
    const raw = (env[SETTINGS[name].envName] ?? '').trim();
    values[name] = name === 'publicUrl' ? normalisePublicUrl(raw) : raw;
  }
  return values;
}
