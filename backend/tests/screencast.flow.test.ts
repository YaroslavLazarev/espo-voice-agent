/**
 * Real-browser check of T3 against ESPOCRM_URL: a WS client connects → the backend logs into
 * EspoCRM and streams JPEG screencast frames (R2.1).
 */
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseServerMessage, type ServerMessage } from '@espo/shared';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';

let app: FastifyInstance;
let url: string;

beforeAll(async () => {
  app = await buildApp(parseConfig({ ...process.env, GEMINI_API_KEY: 'test', BROWSER_HEADLESS: 'true' }), {
    logger: false,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
});

afterAll(async () => {
  await app.close();
});

function collect(ws: WebSocket, until: (seen: ServerMessage[]) => boolean, timeoutMs: number): Promise<ServerMessage[]> {
  const seen: ServerMessage[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout; saw: ${seen.map((m) => m.type).join(', ')}`));
    }, timeoutMs);
    ws.on('message', (data: Buffer) => {
      const parsed = parseServerMessage(data.toString('utf8'));
      if (!parsed.ok) {
        reject(new Error(parsed.error));
        return;
      }
      seen.push(parsed.message);
      if (until(seen)) {
        clearTimeout(timer);
        resolve(seen);
      }
    });
  });
}

const isReady = (m: ServerMessage): boolean => m.type === 'connection.status' && m.browser === 'ready';

describe('live browser view', { timeout: 60_000 }, () => {
  it('logs in and streams frames; rejects invalid client messages', async () => {
    const ws = new WebSocket(url);
    const seen = await collect(
      ws,
      (s) => s.some(isReady) && s.some((m) => m.type === 'screencast.frame'),
      50_000,
    );

    expect(seen[0]).toEqual({ type: 'connection.status', browser: 'connecting', gemini: 'closed' });
    const frame = seen.find((m) => m.type === 'screencast.frame');
    if (frame?.type !== 'screencast.frame') throw new Error('no frame');
    // base64 JPEG starts with FF D8 → "/9j/"
    expect(frame.data.startsWith('/9j/')).toBe(true);
    expect(frame.width).toBeGreaterThan(0);

    const errors = collect(ws, (s) => s.some((m) => m.type === 'error'), 5_000);
    ws.send('{"type":"nope"}');
    expect((await errors).find((m) => m.type === 'error')).toMatchObject({ message: expect.stringMatching(/^invalid message/) as unknown });

    ws.close();
  });
});
