import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(res.json()).toEqual({ status: 'ok', espocrmUrl: 'https://demo.eu.espocrm.com/' });
  });

  it('serves the built frontend from staticDir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'espo-static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
    app = await buildApp(parseConfig({ GEMINI_API_KEY: 'k' }), { logger: false, staticDir: dir });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>app</title>');
  });
});
