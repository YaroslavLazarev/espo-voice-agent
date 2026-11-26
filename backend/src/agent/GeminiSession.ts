import {
  LiveSendToolResponseParameters,
  Modality,
  type FunctionCall,
  type FunctionDeclaration,
  type FunctionResponse,
  type LiveConnectConfig,
  type LiveConnectParameters,
  type LiveServerMessage,
  type Session,
} from '@google/genai';
import type { Status } from '@espo/shared';

/** The part of the SDK's `ai.live` the session needs; tests pass a fake. */
export interface LiveClient {
  connect(params: LiveConnectParameters): Promise<LiveSession>;
}
export type LiveSession = Pick<Session, 'sendRealtimeInput' | 'sendClientContent' | 'sendToolResponse' | 'close'>;

export type GeminiEvent =
  | { type: 'status'; status: Status }
  | { type: 'reconnected' }
  | { type: 'audio'; data: string }
  | { type: 'interrupted' }
  | { type: 'transcript'; role: 'user' | 'agent'; text: string; final: boolean }
  | { type: 'toolCall'; calls: FunctionCall[] }
  | { type: 'toolCancelled'; ids: string[] }
  | { type: 'error'; message: string };

export interface GeminiSessionOptions {
  client: LiveClient;
  model: string;
  systemInstruction: string;
  /** Function declarations offered to the model (design §4). */
  tools?: FunctionDeclaration[];
  onEvent: (event: GeminiEvent) => void;
  /** Text sent to a fresh session after a reconnect, e.g. the current screen state. */
  getResumeHint?: () => Promise<string | undefined>;
  /** Delays between reconnect attempts (design §7). */
  reconnectDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const INPUT_MIME = 'audio/pcm;rate=16000';
const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 4000] as const;

/**
 * One Gemini Live session per client (specs/design.md §7). Knows nothing about the frontend
 * socket: it turns Live server messages into typed `GeminiEvent`s and reconnects on unexpected close.
 */
export class GeminiSession {
  private session: LiveSession | null = null;
  /** Bumped on every connect/stop, so callbacks of an old socket are ignored. */
  private generation = 0;
  private stopped = true;
  private reconnecting = false;
  private readonly transcript = { user: '', agent: '' };

  constructor(private readonly options: GeminiSessionOptions) {}

  get isActive(): boolean {
    return !this.stopped;
  }

  /** Opens the session. A failed first connect is reported as `error` without retries. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.emit({ type: 'status', status: 'connecting' });
    try {
      await this.connect();
      this.emit({ type: 'status', status: 'ready' });
    } catch (error) {
      if (this.isStopped()) return;
      this.stopped = true;
      this.emit({ type: 'status', status: 'error' });
      this.emit({ type: 'error', message: `Could not connect to Gemini: ${errorMessage(error)}` });
    }
  }

  /** A method, not the field, so TS does not narrow it across awaits. */
  private isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    this.flushTranscripts();
    const session = this.session;
    this.session = null;
    session?.close();
    this.emit({ type: 'status', status: 'closed' });
  }

  sendAudio(base64Pcm16: string): void {
    this.session?.sendRealtimeInput({ audio: { data: base64Pcm16, mimeType: INPUT_MIME } });
  }

  sendText(text: string): void {
    if (this.session === null) return;
    this.flushTranscript('agent');
    this.emit({ type: 'transcript', role: 'user', text, final: true });
    this.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true });
  }

  sendToolResponse(functionResponses: FunctionResponse[]): void {
    if (this.session === null || functionResponses.length === 0) return;
    this.session.sendToolResponse(Object.assign(new LiveSendToolResponseParameters(), { functionResponses }));
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const isCurrent = (): boolean => generation === this.generation && !this.stopped;
    const session = await this.options.client.connect({
      model: this.options.model,
      config: this.liveConfig(),
      callbacks: {
        onmessage: (message) => {
          if (isCurrent()) this.onMessage(message);
        },
        onclose: () => {
          if (isCurrent()) void this.onUnexpectedClose();
        },
      },
    });
    if (generation !== this.generation || this.isStopped()) {
      session.close();
      return;
    }
    this.session = session;
  }

  private liveConfig(): LiveConnectConfig {
    const { tools } = this.options;
    return {
      responseModalities: [Modality.AUDIO],
      systemInstruction: this.options.systemInstruction,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      ...(tools !== undefined && tools.length > 0 ? { tools: [{ functionDeclarations: tools }] } : {}),
    };
  }

  private async onUnexpectedClose(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.session = null;
    this.flushTranscripts();
    this.emit({ type: 'status', status: 'reconnecting' });
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    try {
      for (const delay of this.options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS) {
        await sleep(delay);
        if (this.isStopped()) return;
        try {
          await this.connect();
        } catch {
          continue;
        }
        if (this.isStopped()) return;
        this.emit({ type: 'status', status: 'ready' });
        this.emit({ type: 'reconnected' });
        await this.sendResumeHint();
        return;
      }
      this.stopped = true;
      this.generation++;
      this.emit({ type: 'status', status: 'error' });
      this.emit({ type: 'error', message: 'Lost the connection to Gemini; press Start to try again' });
    } finally {
      this.reconnecting = false;
    }
  }

  private async sendResumeHint(): Promise<void> {
    const hint = await this.options.getResumeHint?.().catch(() => undefined);
    if (hint === undefined || this.session === null) return;
    // No turnComplete: the hint is context, the model should wait for the user.
    this.session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: `[The connection was restored; earlier context is lost.] ${hint}` }] }],
      turnComplete: false,
    });
  }

  private onMessage(message: LiveServerMessage): void {
    const content = message.serverContent;
    if (content !== undefined) {
      if (content.interrupted === true) {
        this.flushTranscript('agent');
        this.emit({ type: 'interrupted' });
      }
      const input = content.inputTranscription;
      if (input?.text !== undefined && input.text !== '') this.appendTranscript('user', input.text);
      if (input?.finished === true) this.flushTranscript('user');

      const output = content.outputTranscription;
      if (output?.text !== undefined && output.text !== '') {
        this.flushTranscript('user');
        this.appendTranscript('agent', output.text);
      }
      for (const part of content.modelTurn?.parts ?? []) {
        const data = part.inlineData?.data;
        if (data !== undefined && data !== '' && part.inlineData?.mimeType?.startsWith('audio/') !== false) {
          this.flushTranscript('user');
          this.emit({ type: 'audio', data });
        }
      }
      if (content.turnComplete === true) this.flushTranscripts();
    }
    const calls = message.toolCall?.functionCalls;
    if (calls !== undefined && calls.length > 0) this.emit({ type: 'toolCall', calls });
    const cancelled = message.toolCallCancellation?.ids;
    if (cancelled !== undefined && cancelled.length > 0) this.emit({ type: 'toolCancelled', ids: cancelled });
  }

  private appendTranscript(role: 'user' | 'agent', text: string): void {
    this.transcript[role] += text;
    this.emit({ type: 'transcript', role, text: this.transcript[role], final: false });
  }

  private flushTranscript(role: 'user' | 'agent'): void {
    const text = this.transcript[role];
    if (text === '') return;
    this.transcript[role] = '';
    this.emit({ type: 'transcript', role, text, final: true });
  }

  private flushTranscripts(): void {
    this.flushTranscript('user');
    this.flushTranscript('agent');
  }

  private emit(event: GeminiEvent): void {
    this.options.onEvent(event);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
