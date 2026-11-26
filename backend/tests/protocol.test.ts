import { describe, expect, it } from 'vitest';
import { parseClientMessage, parseServerMessage, serverMessageSchema } from '@espo/shared';

describe('client → server messages', () => {
  it.each([
    { type: 'session.start' },
    { type: 'session.stop' },
    { type: 'audio.input', data: 'AAAA' },
    { type: 'text.input', text: 'hello' },
  ])('accepts $type', (msg) => {
    expect(parseClientMessage(JSON.stringify(msg))).toEqual({ ok: true, message: msg });
  });

  it.each([
    ['not JSON', '{nope'],
    ['unknown type', JSON.stringify({ type: 'browser.click' })],
    ['missing type', JSON.stringify({ data: 'AAAA' })],
    ['empty audio', JSON.stringify({ type: 'audio.input', data: '' })],
    ['blank text', JSON.stringify({ type: 'text.input', text: '   ' })],
    ['server message', JSON.stringify({ type: 'audio.interrupted' })],
  ])('rejects %s', (_label, raw) => {
    expect(parseClientMessage(raw).ok).toBe(false);
  });
});

describe('server → client messages', () => {
  it.each([
    { type: 'connection.status', browser: 'ready', gemini: 'closed' },
    { type: 'screencast.frame', data: '/9j/', width: 1280, height: 800 },
    { type: 'audio.output', data: 'AAAA' },
    { type: 'audio.interrupted' },
    { type: 'transcript', role: 'agent', text: 'Hi', final: false },
    { type: 'agent.state', state: 'awaiting_confirmation' },
    { type: 'tool.call', id: '1', name: 'getScreenState', args: {} },
    { type: 'tool.result', id: '1', name: 'saveContact', ok: false, error: 'form changed since confirmation' },
    { type: 'error', message: 'boom' },
  ])('accepts $type', (msg) => {
    expect(parseServerMessage(JSON.stringify(msg))).toEqual({ ok: true, message: msg });
  });

  it.each([
    { type: 'connection.status', browser: 'ready', gemini: 'sleeping' },
    { type: 'screencast.frame', data: '/9j/', width: 0, height: 800 },
    { type: 'transcript', role: 'system', text: 'x', final: true },
    { type: 'agent.state', state: 'done' },
    { type: 'tool.result', id: '1', name: 'x' },
  ])('rejects invalid $type', (msg) => {
    expect(serverMessageSchema.safeParse(msg).success).toBe(false);
  });
});
