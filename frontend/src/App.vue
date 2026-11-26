<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ServerMessage, Status } from '@espo/shared';
import BrowserViewport from './components/BrowserViewport.vue';
import ConnectionStatus from './components/ConnectionStatus.vue';
import EventLog from './components/EventLog.vue';
import VoiceControls from './components/VoiceControls.vue';
import { useAgentSocket } from './composables/useAgentSocket.ts';
import { useAudioStream } from './composables/useAudioStream.ts';
import { useEventLog } from './composables/useEventLog.ts';

const viewport = ref<InstanceType<typeof BrowserViewport> | null>(null);
const log = useEventLog();

const audio = useAudioStream((data) => {
  send({ type: 'audio.input', data });
});

let lastGemini: Status = 'closed';

function onServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'screencast.frame':
      viewport.value?.pushFrame(message);
      break;
    case 'audio.output':
      audio.play(message.data);
      break;
    case 'audio.interrupted':
      audio.flush();
      break;
    case 'transcript':
      log.transcript(message.role, message.text, message.final);
      break;
    case 'connection.status':
      onGeminiStatus(message.gemini);
      break;
    case 'error':
      log.add('error', message.message);
      break;
    default:
      break;
  }
}

function onGeminiStatus(status: Status): void {
  const previous = lastGemini;
  lastGemini = status;
  if (status === previous) return;
  if (status === 'reconnecting') log.add('system', 'Gemini connection lost, reconnecting…');
  else if (status === 'ready') log.add('system', previous === 'reconnecting' ? 'Gemini reconnected (earlier context may be lost)' : 'Voice session started');
  else if (status === 'closed' && previous !== 'connecting') log.add('system', 'Voice session ended');
  // The session is gone: release the mic too.
  if ((status === 'error' || status === 'closed') && audio.active.value) audio.stop();
}

const { socketStatus, browserStatus, geminiStatus, lastError, send } = useAgentSocket(onServerMessage);

// The backend drops the Gemini session with the socket; stop the mic so the UI matches.
watch(socketStatus, (status) => {
  if (status !== 'open' && audio.active.value) {
    audio.stop();
    log.add('system', 'Server connection lost; voice session stopped');
  }
});

async function start(): Promise<void> {
  try {
    await audio.start();
  } catch (error) {
    log.add('error', `Microphone unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  send({ type: 'session.start' });
}

function stop(): void {
  audio.stop();
  send({ type: 'session.stop' });
}

function sendText(text: string): void {
  send({ type: 'text.input', text });
}
</script>

<template>
  <main>
    <header>
      <h1>EspoCRM Voice Agent</h1>
      <ConnectionStatus
        :socket="socketStatus"
        :browser="browserStatus"
        :gemini="geminiStatus"
      />
    </header>
    <p
      v-if="lastError"
      class="error"
    >
      {{ lastError }}
    </p>
    <VoiceControls
      :active="audio.active.value"
      :gemini="geminiStatus"
      :level="audio.level.value"
      :online="socketStatus === 'open'"
      @start="start"
      @stop="stop"
      @text="sendText"
    />
    <div class="layout">
      <BrowserViewport ref="viewport" />
      <EventLog :entries="log.entries.value" />
    </div>
  </main>
</template>

<style scoped>
main {
  max-width: 1720px;
  margin: 0 auto;
  padding: 16px;
  font-family: system-ui, sans-serif;
}
header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
h1 {
  font-size: 20px;
  margin: 0;
}
.error {
  color: #b91c1c;
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 16px;
  align-items: start;
}
@media (max-width: 1000px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
