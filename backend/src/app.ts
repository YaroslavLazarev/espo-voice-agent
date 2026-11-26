import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { Config } from './config.ts';

export interface AppOptions {
  logger?: boolean;
}

export async function buildApp(config: Config, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  await app.register(websocket);

  app.get('/health', () => ({ status: 'ok', espocrmUrl: config.ESPOCRM_URL }));

  app.get('/ws', { websocket: true }, (socket, request) => {
    // Stub: ClientConnection is wired in T3 (specs/design.md §1).
    request.log.info('ws client connected');
    socket.on('close', () => {
      request.log.info('ws client disconnected');
    });
  });

  return app;
}
