/**
 * WebSocket protocol between frontend and backend (specs/design.md §2).
 * JSON text frames; both sides parse every message with these schemas.
 */
import { z } from 'zod';

export const statusSchema = z.enum(['connecting', 'ready', 'reconnecting', 'closed', 'error']);
export type Status = z.infer<typeof statusSchema>;

export const agentStateSchema = z.enum([
  'idle',
  'form_open',
  'filling',
  'awaiting_confirmation',
  'saving',
  'saved',
  'duplicate_dialog',
  'error',
]);
export type AgentState = z.infer<typeof agentStateSchema>;

const base64 = z.string().min(1);

// ------------------------------------------------------------ client → server

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.start') }),
  z.object({ type: z.literal('session.stop') }),
  z.object({ type: z.literal('audio.input'), data: base64 }),
  z.object({ type: z.literal('text.input'), text: z.string().trim().min(1) }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ------------------------------------------------------------ server → client

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connection.status'), browser: statusSchema, gemini: statusSchema }),
  z.object({
    type: z.literal('screencast.frame'),
    data: base64,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({ type: z.literal('audio.output'), data: base64 }),
  z.object({ type: z.literal('audio.interrupted') }),
  z.object({
    type: z.literal('transcript'),
    role: z.enum(['user', 'agent']),
    text: z.string(),
    final: z.boolean(),
  }),
  z.object({ type: z.literal('agent.state'), state: agentStateSchema }),
  z.object({ type: z.literal('tool.call'), id: z.string(), name: z.string(), args: z.unknown() }),
  z.object({
    type: z.literal('tool.result'),
    id: z.string(),
    name: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** The record link in a `tool.result` (saveContact / resolveDuplicate / openContact). http(s) only, so it is safe as an href. */
export const recordLinkSchema = z.object({ url: z.url({ protocol: /^https?$/ }) });

export type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string };

function parseJson<T>(schema: z.ZodType<T>, raw: string): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const result = schema.safeParse(json);
  return result.success ? { ok: true, message: result.data } : { ok: false, error: z.prettifyError(result.error) };
}

export const parseClientMessage = (raw: string): ParseResult<ClientMessage> => parseJson(clientMessageSchema, raw);
export const parseServerMessage = (raw: string): ParseResult<ServerMessage> => parseJson(serverMessageSchema, raw);
