import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('app', () => {
  it('GET /health returns ok', async () => {
    app = await buildApp(parseConfig({ GEMINI_API_KEY: 'k' }), { logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', espocrmUrl: 'https://demo.us.espocrm.com/' });
  });
});
