import type { FastifyBaseLogger } from 'fastify';
import type { Browser } from 'playwright';
import type { RawData } from 'ws';
import { parseClientMessage, type ServerMessage, type Status } from '@espo/shared';
import { GeminiSession, type GeminiEvent, type LiveClient } from './agent/GeminiSession.ts';
import { SYSTEM_PROMPT } from './agent/systemPrompt.ts';
import { ToolDispatcher, type DispatcherEvent } from './agent/ToolDispatcher.ts';
import { BrowserActionError, BrowserController } from './browser/BrowserController.ts';
import { ScreencastStreamer } from './browser/ScreencastStreamer.ts';
import type { Config } from './config.ts';
import { toolDeclarations } from './schemas/tools.ts';

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
  liveClient: LiveClient;
  config: Config;
  log: FastifyBaseLogger;
}

/**
 * One per frontend WebSocket: owns a browser context + screencast and a Gemini Live session.
 * Maps internal events to protocol messages; the browser layer knows nothing about the socket.
 */
export class ClientConnection {
  private controller: BrowserController | null = null;
  private streamer: ScreencastStreamer | null = null;
  private readonly gemini: GeminiSession;
  private readonly tools: ToolDispatcher;
  private closed = false;
  private status: { browser: Status; gemini: Status } = { browser: 'connecting', gemini: 'closed' };

  constructor(private readonly deps: ClientConnectionDeps) {
    this.tools = new ToolDispatcher({
      getBrowser: () => (this.status.browser === 'ready' ? this.controller : null),
      onEvent: (event) => {
        this.onToolEvent(event);
      },
    });
    this.gemini = new GeminiSession({
      client: deps.liveClient,
      model: deps.config.GEMINI_MODEL,
      systemInstruction: SYSTEM_PROMPT,
      tools: toolDeclarations(),
      onEvent: (event) => {
        this.onGeminiEvent(event);
      },
      getResumeHint: async () => {
        const state = await this.controller?.getScreenState();
        if (state === undefined) return undefined;
        return `Agent state: ${this.tools.currentState}. Current screen state: ${JSON.stringify(state)}`;
      },
    });
    deps.socket.on('message', (data, isBinary) => {
      this.onMessage(data, isBinary);
    });
    deps.socket.on('close', () => {
      void this.close();
    });
  }

  async start(): Promise<void> {
    this.sendStatus({ browser: 'connecting' });
    this.send({ type: 'agent.state', state: this.tools.currentState });
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
    this.gemini.stop();
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
    const message = parsed.message;
    switch (message.type) {
      case 'session.start':
        void this.gemini.start();
        break;
      case 'session.stop':
        this.gemini.stop();
        break;
      case 'audio.input':
        this.gemini.sendAudio(message.data);
        break;
      case 'text.input':
        if (!this.gemini.isActive) {
          this.send({ type: 'error', message: 'Start the voice session first' });
          break;
        }
        this.gemini.sendText(message.text);
        break;
    }
  }

  private onGeminiEvent(event: GeminiEvent): void {
    switch (event.type) {
      case 'status':
        this.sendStatus({ gemini: event.status });
        break;
      case 'reconnected':
        // The frontend logs "reconnected" from the reconnecting → ready status change.
        this.deps.log.info('gemini session reconnected');
        break;
      case 'audio':
        this.send({ type: 'audio.output', data: event.data });
        break;
      case 'interrupted':
        this.send({ type: 'audio.interrupted' });
        break;
      case 'transcript':
        this.send({ type: 'transcript', role: event.role, text: event.text, final: event.final });
        break;
      case 'toolCall':
        this.tools
          .runCalls(event.calls)
          .then((responses) => {
            this.gemini.sendToolResponse(responses);
          })
          .catch((error: unknown) => {
            this.deps.log.error({ err: error }, 'tool dispatch failed');
          });
        break;
      case 'toolCancelled':
        this.tools.cancel(event.ids);
        break;
      case 'error':
        this.deps.log.warn({ message: event.message }, 'gemini error');
        this.send({ type: 'error', message: event.message });
        break;
    }
  }

  private onToolEvent(event: DispatcherEvent): void {
    switch (event.type) {
      case 'state':
        this.send({ type: 'agent.state', state: event.state });
        break;
      case 'toolCall':
        this.send({ type: 'tool.call', id: event.id, name: event.name, args: event.args });
        break;
      case 'toolResult': {
        const { result } = event;
        this.send(
          result.ok
            ? { type: 'tool.result', id: event.id, name: event.name, ok: true, result }
            : { type: 'tool.result', id: event.id, name: event.name, ok: false, error: result.error },
        );
        break;
      }
      case 'cancelledAfterEffect':
        this.gemini.sendContext(
          `[System note: your ${event.name} call was cancelled, but Save had already been clicked. ` +
            `It completed: ${JSON.stringify(event.result)}. Do not save again.]`,
        );
        break;
    }
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
