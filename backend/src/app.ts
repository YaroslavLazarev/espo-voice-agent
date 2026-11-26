import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { Browser } from 'playwright';
import { launchBrowser } from './browser/BrowserController.ts';
import { ClientConnection } from './ClientConnection.ts';
import type { Config } from './config.ts';

export interface AppOptions {
  logger?: boolean;
}

export async function buildApp(config: Config, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  await app.register(websocket);

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

  app.get('/health', () => ({ status: 'ok', espocrmUrl: config.ESPOCRM_URL }));

  app.get('/ws', { websocket: true }, (socket, request) => {
    request.log.info('ws client connected');
    const connection = new ClientConnection({ socket, getBrowser, config, log: request.log });
    socket.on('close', () => {
      request.log.info('ws client disconnected');
    });
    void connection.start();
  });

  return app;
}
