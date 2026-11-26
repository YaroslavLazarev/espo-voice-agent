import { LiveServerMessage, Modality, type LiveCallbacks, type LiveConnectParameters, type LiveServerContent } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { GeminiSession, type GeminiEvent, type LiveClient, type LiveSession } from '../src/agent/GeminiSession.ts';

interface FakeSession extends LiveSession {
  sendRealtimeInput: ReturnType<typeof vi.fn<LiveSession['sendRealtimeInput']>>;
  sendClientContent: ReturnType<typeof vi.fn<LiveSession['sendClientContent']>>;
  sendToolResponse: ReturnType<typeof vi.fn<LiveSession['sendToolResponse']>>;
  close: ReturnType<typeof vi.fn<LiveSession['close']>>;
}

/** Fake `ai.live`: each connect() records its params and callbacks; `failNext` makes connects reject. */
function fakeLive() {
  const connects: { params: LiveConnectParameters; session: FakeSession }[] = [];
  let failures = 0;
  const client: LiveClient = {
    connect(params) {
      if (failures > 0) {
        failures--;
        return Promise.reject(new Error('boom'));
      }
      const session: FakeSession = {
        sendRealtimeInput: vi.fn<LiveSession['sendRealtimeInput']>(),
        sendClientContent: vi.fn<LiveSession['sendClientContent']>(),
        sendToolResponse: vi.fn<LiveSession['sendToolResponse']>(),
        close: vi.fn<LiveSession['close']>(),
      };
      connects.push({ params, session });
      return Promise.resolve(session);
    },
  };
  const last = () => {
    const entry = connects.at(-1);
    if (entry === undefined) throw new Error('not connected');
    return entry;
  };
  const callbacks = (): LiveCallbacks => last().params.callbacks;
  return {
    client,
    connects,
    last,
    failNext(n: number) {
      failures = n;
    },
    server(content: LiveServerContent) {
      callbacks().onmessage(Object.assign(new LiveServerMessage(), { serverContent: content }));
    },
    message(fields: Partial<LiveServerMessage>) {
      callbacks().onmessage(Object.assign(new LiveServerMessage(), fields));
    },
    dropConnection() {
      callbacks().onclose?.(new CloseEvent('close', { code: 1011 }));
    },
  };
}

function setup(options: { getResumeHint?: () => Promise<string | undefined> } = {}) {
  const live = fakeLive();
  const events: GeminiEvent[] = [];
  const session = new GeminiSession({
    client: live.client,
    model: 'test-model',
    systemInstruction: 'be brief',
    onEvent: (e) => events.push(e),
    sleep: () => Promise.resolve(),
    ...options,
  });
  const statuses = () => events.flatMap((e) => (e.type === 'status' ? [e.status] : []));
  const transcripts = () => events.filter((e) => e.type === 'transcript');
  return { live, events, session, statuses, transcripts };
}

describe('GeminiSession', () => {
  it('connects with the Live config from design §7', async () => {
    const { live, session, statuses } = setup();
    await session.start();

    expect(statuses()).toEqual(['connecting', 'ready']);
    const { model, config } = live.last().params;
    expect(model).toBe('test-model');
    expect(config).toEqual({
      responseModalities: [Modality.AUDIO],
      systemInstruction: 'be brief',
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
    });
    // Native-audio models do not support an explicit language code.
    expect(config?.speechConfig).toBeUndefined();
  });

  it('streams mic audio as 16 kHz PCM and forwards agent audio', async () => {
    const { live, session, events } = setup();
    await session.start();

    session.sendAudio('AAAA');
    expect(live.last().session.sendRealtimeInput).toHaveBeenCalledWith({
      audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' },
    });

    live.server({ modelTurn: { parts: [{ inlineData: { data: 'BBBB', mimeType: 'audio/pcm;rate=24000' } }] } });
    expect(events).toContainEqual({ type: 'audio', data: 'BBBB' });
  });

  it('accumulates transcripts and finalizes them at turn boundaries', async () => {
    const { live, session, transcripts } = setup();
    await session.start();

    live.server({ inputTranscription: { text: 'Hello ' } });
    live.server({ inputTranscription: { text: 'there' } });
    live.server({ outputTranscription: { text: 'Hi!' } });
    live.server({ outputTranscription: { text: ' How can I help?' } });
    live.server({ turnComplete: true });

    expect(transcripts()).toEqual([
      { type: 'transcript', role: 'user', text: 'Hello ', final: false },
      { type: 'transcript', role: 'user', text: 'Hello there', final: false },
      { type: 'transcript', role: 'user', text: 'Hello there', final: true },
      { type: 'transcript', role: 'agent', text: 'Hi!', final: false },
      { type: 'transcript', role: 'agent', text: 'Hi! How can I help?', final: false },
      { type: 'transcript', role: 'agent', text: 'Hi! How can I help?', final: true },
    ]);
  });

  it('emits interrupted and closes the agent transcript line', async () => {
    const { live, session, events } = setup();
    await session.start();

    live.server({ outputTranscription: { text: 'Let me read' } });
    live.server({ interrupted: true });

    expect(events.slice(-2)).toEqual([
      { type: 'transcript', role: 'agent', text: 'Let me read', final: true },
      { type: 'interrupted' },
    ]);
  });

  it('emits tool calls and cancellations', async () => {
    const { live, session, events } = setup();
    await session.start();

    live.message({ toolCall: { functionCalls: [{ id: 'c1', name: 'getScreenState', args: {} }] } });
    live.message({ toolCallCancellation: { ids: ['c1'] } });

    expect(events).toContainEqual({ type: 'toolCall', calls: [{ id: 'c1', name: 'getScreenState', args: {} }] });
    expect(events).toContainEqual({ type: 'toolCancelled', ids: ['c1'] });
  });

  it('sends typed text as a complete user turn', async () => {
    const { live, session, events } = setup();
    await session.start();

    session.sendText('hello');
    expect(live.last().session.sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: 'user', parts: [{ text: 'hello' }] }],
      turnComplete: true,
    });
    expect(events).toContainEqual({ type: 'transcript', role: 'user', text: 'hello', final: true });
  });

  it('reconnects with the same config after an unexpected close and sends a resume hint', async () => {
    const { live, session, events, statuses } = setup({ getResumeHint: () => Promise.resolve('on #Contact/create') });
    await session.start();
    const first = live.last();

    live.dropConnection();
    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: 'reconnected' });
    });

    expect(live.connects).toHaveLength(2);
    expect(live.last().params.config).toEqual(first.params.config);
    expect(statuses()).toEqual(['connecting', 'ready', 'reconnecting', 'ready']);
    const hint = live.last().session.sendClientContent.mock.calls[0]?.[0];
    expect(hint?.turnComplete).toBe(false);
    expect(JSON.stringify(hint?.turns)).toContain('on #Contact/create');

    // Audio now goes to the new session.
    session.sendAudio('CCCC');
    expect(live.last().session.sendRealtimeInput).toHaveBeenCalledTimes(1);
    expect(first.session.sendRealtimeInput).not.toHaveBeenCalled();
  });

  it('gives up after 3 failed reconnect attempts', async () => {
    const { live, session, statuses } = setup();
    await session.start();

    live.failNext(3);
    live.dropConnection();
    await vi.waitFor(() => {
      expect(statuses().at(-1)).toBe('error');
    });

    expect(statuses()).toEqual(['connecting', 'ready', 'reconnecting', 'error']);
    expect(live.connects).toHaveLength(1);
    expect(session.isActive).toBe(false);
  });

  it('recovers when a later reconnect attempt succeeds', async () => {
    const { live, session, statuses } = setup();
    await session.start();

    live.failNext(2);
    live.dropConnection();
    await vi.waitFor(() => {
      expect(statuses().at(-1)).toBe('ready');
    });
    expect(live.connects).toHaveLength(2);
  });

  it('does not reconnect after stop()', async () => {
    const { live, session, statuses } = setup();
    await session.start();

    const { params, session: liveSession } = live.last();
    session.stop();
    params.callbacks.onclose?.(new CloseEvent('close'));
    await Promise.resolve();

    expect(liveSession.close).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual(['connecting', 'ready', 'closed']);
    expect(live.connects).toHaveLength(1);
  });

  it('reports a failed first connect as an error without retrying', async () => {
    const { live, session, statuses, events } = setup();
    live.failNext(1);
    await session.start();

    expect(statuses()).toEqual(['connecting', 'error']);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('boom') as string });
    expect(live.connects).toHaveLength(0);
  });
});
