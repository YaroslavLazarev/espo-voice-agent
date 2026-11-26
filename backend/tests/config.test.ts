import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_ESPOCRM_URL, DEFAULT_GEMINI_MODEL, parseConfig } from '../src/config.ts';

const valid = { GEMINI_API_KEY: 'key' };

function issuesOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected ConfigError');
}

describe('parseConfig', () => {
  it('applies defaults; credentials are optional (public demo)', () => {
    expect(parseConfig(valid)).toEqual({
      GEMINI_API_KEY: 'key',
      GEMINI_MODEL: DEFAULT_GEMINI_MODEL,
      ESPOCRM_URL: DEFAULT_ESPOCRM_URL,
      PORT: 3000,
      BROWSER_HEADLESS: true,
    });
  });

  it('treats empty strings as unset', () => {
    const config = parseConfig({
      ...valid,
      ESPOCRM_URL: '',
      PORT: ' ',
      BROWSER_HEADLESS: '',
      ESPOCRM_USERNAME: '',
      ESPOCRM_PASSWORD: '',
    });
    expect(config.ESPOCRM_URL).toBe(DEFAULT_ESPOCRM_URL);
    expect(config.PORT).toBe(3000);
    expect(config.BROWSER_HEADLESS).toBe(true);
    expect(config.ESPOCRM_USERNAME).toBeUndefined();
    expect(config.ESPOCRM_PASSWORD).toBeUndefined();
  });

  it('parses overrides', () => {
    const config = parseConfig({
      ...valid,
      ESPOCRM_URL: 'http://localhost:8080/',
      ESPOCRM_USERNAME: 'admin',
      ESPOCRM_PASSWORD: 'secret',
      PORT: '4000',
      BROWSER_HEADLESS: 'false',
      GEMINI_MODEL: 'some-model',
    });
    expect(config).toMatchObject({
      ESPOCRM_URL: 'http://localhost:8080/',
      ESPOCRM_USERNAME: 'admin',
      ESPOCRM_PASSWORD: 'secret',
      PORT: 4000,
      BROWSER_HEADLESS: false,
      GEMINI_MODEL: 'some-model',
    });
  });

  it('requires GEMINI_API_KEY', () => {
    expect(issuesOf({})).toEqual([expect.stringContaining('GEMINI_API_KEY is required')]);
    expect(issuesOf({ GEMINI_API_KEY: '   ' })).toEqual([expect.stringContaining('GEMINI_API_KEY is required')]);
  });

  it.each([
    ['ESPOCRM_URL', 'not a url', 'must be a valid http(s) URL'],
    ['ESPOCRM_URL', 'ftp://example.com', 'must be a valid http(s) URL'],
    ['PORT', 'abc', 'must be a number'],
    ['PORT', '1.5', 'must be an integer'],
    ['PORT', '70000', 'between 1 and 65535'],
    ['BROWSER_HEADLESS', 'maybe', 'must be true or false'],
  ])('rejects invalid %s=%s', (key, value, message) => {
    const issues = issuesOf({ ...valid, [key]: value });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(key);
    expect(issues[0]).toContain(message);
  });

  it('reports all problems at once in a readable message', () => {
    expect(() => parseConfig({ PORT: 'abc' })).toThrow(
      /^Invalid configuration:\n {2}- GEMINI_API_KEY is required\n {2}- PORT must be a number\nSee \.env\.example\.$/,
    );
  });
});
