import { onBeforeUnmount, onMounted, readonly, ref } from 'vue';
import { parseServerMessage, type ClientMessage, type ServerMessage, type Status } from '@espo/shared';

export type SocketStatus = 'connecting' | 'open' | 'reconnecting';

const BACKOFF_MS = [500, 1000, 2000, 4000];

/**
 * Frontend ↔ backend WebSocket (specs/design.md §9): reconnects with a short backoff,
 * zod-parses every incoming message and hands it to `onMessage`.
 */
export function useAgentSocket(onMessage: (message: ServerMessage) => void) {
  const socketStatus = ref<SocketStatus>('connecting');
  const browserStatus = ref<Status>('connecting');
  const geminiStatus = ref<Status>('closed');
  const lastError = ref<string | null>(null);

  let ws: WebSocket | null = null;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const url = (): string => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

  function connect(): void {
    const socket = new WebSocket(url());
    ws = socket;
    socket.onopen = () => {
      attempt = 0;
      socketStatus.value = 'open';
      lastError.value = null;
    };
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      const parsed = parseServerMessage(event.data);
      if (!parsed.ok) {
        console.warn('invalid server message', parsed.error);
        return;
      }
      const message = parsed.message;
      if (message.type === 'connection.status') {
        browserStatus.value = message.browser;
        geminiStatus.value = message.gemini;
        // A session that came up fine makes an earlier connect error stale.
        if (message.browser !== 'error' && message.gemini === 'ready') lastError.value = null;
      } else if (message.type === 'error') {
        lastError.value = message.message;
      }
      onMessage(message);
    };
    socket.onclose = () => {
      if (ws !== socket || disposed) return;
      ws = null;
      socketStatus.value = 'reconnecting';
      browserStatus.value = 'connecting';
      geminiStatus.value = 'closed';
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 1000;
      attempt++;
      retryTimer = setTimeout(connect, delay);
    };
  }

  function send(message: ClientMessage): boolean {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  onMounted(connect);
  onBeforeUnmount(() => {
    disposed = true;
    clearTimeout(retryTimer);
    ws?.close();
    ws = null;
  });

  return {
    socketStatus: readonly(socketStatus),
    browserStatus: readonly(browserStatus),
    geminiStatus: readonly(geminiStatus),
    lastError: readonly(lastError),
    clearError: (): void => {
      lastError.value = null;
    },
    send,
  };
}
