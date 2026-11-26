import { describe, expect, it } from 'vitest';
import { describeConnectError } from '../src/agent/GeminiSession.ts';

describe('describeConnectError', () => {
  it.each([
    ['API key not valid. Please pass a valid API key.', 'check GEMINI_API_KEY'],
    ['models/foo is not found for API version v1beta', 'check GEMINI_MODEL'],
    ['429 RESOURCE_EXHAUSTED', 'quota or rate limit'],
    ['getaddrinfo ENOTFOUND generativelanguage.googleapis.com', 'check the network'],
    ['boom', 'Could not connect to Gemini'],
  ])('maps %j to a hint', (raw, hint) => {
    const message = describeConnectError(new Error(raw), 'foo');
    expect(message).toContain(hint);
    expect(message).toContain(raw);
  });
});
