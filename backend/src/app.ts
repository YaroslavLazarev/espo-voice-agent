import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { GoogleGenAI } from '@google/genai';
import type { Browser } from 'playwright';
import type { LiveClient } from './agent/GeminiSession.ts';
import { launchBrowser } from './browser/BrowserController.ts';
import { ClientConnection } from './ClientConnection.ts';
import type { Config } from './config.ts';

export interface AppOptions {
  logger?: boolean;
  /** Gemini Live client; defaults to the real SDK. Tests inject a fake. */
  liveClient?: LiveClient;
  /** Built frontend (`frontend/dist`) to serve at `/`; in dev, Vite serves it instead. */
  staticDir?: string;
}

export async function buildApp(config: Config, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  await app.register(websocket);
  // SDK 3.x defaults to API v1, where the Live WS endpoint is a 404; Live is served on v1beta.
  const liveClient =
    options.liveClient ?? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY, httpOptions: { apiVersion: 'v1beta' } }).live;

  // One Chromium process, launched on first client; each client gets its own context.
  let browser: Promise<Browser> | null = null;
  const getBrowser = (): Promise<Browser> => {
    browser ??= launchBrowser(config.BROWSER_HEADLESS).catch((error: unknown) => {
      browser = null;
      throw error;
    });
    return browser;
  };
  app.addHook('onClose', async () => {
    const current = browser;
    browser = null;
    if (current !== null) await (await current.catch(() => null))?.close();
  });

  if (options.staticDir !== undefined) await app.register(fastifyStatic, { root: options.staticDir });

  app.get('/health', () => ({ status: 'ok', espocrmUrl: config.ESPOCRM_URL }));

  app.get('/ws', { websocket: true }, (socket, request) => {
    request.log.info('ws client connected');
    const connection = new ClientConnection({ socket, getBrowser, liveClient, config, log: request.log });
    socket.on('close', () => {
      request.log.info('ws client disconnected');
    });
    void connection.start();
  });

  return app;
}
