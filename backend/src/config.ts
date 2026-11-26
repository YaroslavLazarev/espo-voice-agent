import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const DEFAULT_ESPOCRM_URL = 'https://demo.eu.espocrm.com/';
// Verified against the Gemini Live docs in T4.
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';

const requiredString = (name: string) =>
  z.string({ error: `${name} is required` }).trim().min(1, `${name} is required`);

/** Empty strings in .env mean "not set", so defaults apply. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

export const configSchema = z.object({
  GEMINI_API_KEY: requiredString('GEMINI_API_KEY'),
  GEMINI_MODEL: optional(z.string().trim().min(1).default(DEFAULT_GEMINI_MODEL)),
  ESPOCRM_URL: optional(z.url({ protocol: /^https?$/, error: 'ESPOCRM_URL must be a valid http(s) URL' }).default(DEFAULT_ESPOCRM_URL)),
  // Optional: the public demo pre-fills the username and has no password.
  ESPOCRM_USERNAME: optional(z.string().trim().min(1).optional()),
  ESPOCRM_PASSWORD: optional(z.string().min(1).optional()),
  PORT: optional(
    z.coerce.number({ error: 'PORT must be a number' }).int('PORT must be an integer').min(1, 'PORT must be between 1 and 65535').max(65535, 'PORT must be between 1 and 65535').default(3000),
  ),
  BROWSER_HEADLESS: optional(z.stringbool({ error: 'BROWSER_HEADLESS must be true or false' }).default(true)),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}\nSee .env.example.`);
    this.name = 'ConfigError';
  }
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const key = issue.path.join('.');
        return issue.message.startsWith(key) ? issue.message : `${key}: ${issue.message}`;
      }),
    );
  }
  return result.data;
}

/** Loads the repo-root .env (if present) into process.env, then validates. */
export function loadConfig(): Config {
  const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  return parseConfig(process.env);
}
