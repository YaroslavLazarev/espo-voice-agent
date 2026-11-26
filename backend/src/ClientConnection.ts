import type { FastifyBaseLogger } from 'fastify';
import type { Browser } from 'playwright';
import type { RawData } from 'ws';
import { parseClientMessage, type ServerMessage, type Status } from '@espo/shared';
import { BrowserActionError, BrowserController } from './browser/BrowserController.ts';
import { ScreencastStreamer } from './browser/ScreencastStreamer.ts';
import type { Config } from './config.ts';

/** Frames are dropped while this many bytes are still queued on the socket. */
const MAX_BUFFERED_BYTES = 1_000_000;

const WS_OPEN = 1;

/** The subset of a `ws` WebSocket that the connection needs. */
export interface ClientSocket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: string): void;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

export interface ClientConnectionDeps {
  socket: ClientSocket;
  getBrowser: () => Promise<Browser>;
  config: Config;
  log: FastifyBaseLogger;
}

/**
 * One per frontend WebSocket: owns a browser context + screencast (and, from T4, a Gemini session).
 * Maps internal events to protocol messages; the browser layer knows nothing about the socket.
 */
export class ClientConnection {
  private controller: BrowserController | null = null;
  private streamer: ScreencastStreamer | null = null;
  private closed = false;
  private status: { browser: Status; gemini: Status } = { browser: 'connecting', gemini: 'closed' };

  constructor(private readonly deps: ClientConnectionDeps) {
    deps.socket.on('message', (data, isBinary) => {
      this.onMessage(data, isBinary);
    });
    deps.socket.on('close', () => {
      void this.close();
    });
  }

  async start(): Promise<void> {
    this.sendStatus({ browser: 'connecting' });
    try {
      const browser = await this.deps.getBrowser();
      const controller = await BrowserController.create(browser, {
        espocrmUrl: this.deps.config.ESPOCRM_URL,
        username: this.deps.config.ESPOCRM_USERNAME,
        password: this.deps.config.ESPOCRM_PASSWORD,
      });
      this.controller = controller;
      if (this.isClosed()) {
        await this.close();
        return;
      }

      // Stream before logging in, so the user sees the login page too.
      this.streamer = new ScreencastStreamer(
        controller.page,
        (frame) => {
          this.send({ type: 'screencast.frame', ...frame });
        },
        () => this.deps.socket.bufferedAmount > MAX_BUFFERED_BYTES,
      );
      await this.streamer.start();
      await controller.login();
      if (this.isClosed()) return;
      this.sendStatus({ browser: 'ready' });
    } catch (error) {
      if (this.isClosed()) return;
      this.deps.log.error({ err: error }, 'browser setup failed');
      const message = error instanceof BrowserActionError ? error.message : 'Could not open EspoCRM in the browser';
      this.sendStatus({ browser: 'error' });
      this.send({ type: 'error', message });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const { streamer, controller } = this;
    this.streamer = null;
    this.controller = null;
    await streamer?.stop();
    await controller?.close().catch(() => undefined);
  }

  /** A method, not the field, so TS does not narrow it across awaits. */
  private isClosed(): boolean {
    return this.closed;
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.send({ type: 'error', message: 'binary frames are not supported' });
      return;
    }
    const parsed = parseClientMessage(rawToString(data));
    if (!parsed.ok) {
      this.send({ type: 'error', message: `invalid message: ${parsed.error}` });
      return;
    }
    // Voice session messages are handled from T4 (GeminiSession).
    this.send({ type: 'error', message: `${parsed.message.type} is not supported yet` });
  }

  private sendStatus(patch: Partial<{ browser: Status; gemini: Status }>): void {
    this.status = { ...this.status, ...patch };
    this.send({ type: 'connection.status', ...this.status });
  }

  private send(message: ServerMessage): void {
    if (this.closed || this.deps.socket.readyState !== WS_OPEN) return;
    this.deps.socket.send(JSON.stringify(message));
  }
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
