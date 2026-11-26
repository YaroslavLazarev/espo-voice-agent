<script setup lang="ts">
import { ref } from 'vue';
import type { ServerMessage } from '@espo/shared';
import BrowserViewport from './components/BrowserViewport.vue';
import ConnectionStatus from './components/ConnectionStatus.vue';
import { useAgentSocket } from './composables/useAgentSocket.ts';

const viewport = ref<InstanceType<typeof BrowserViewport> | null>(null);

const { socketStatus, browserStatus, geminiStatus, lastError } = useAgentSocket((message: ServerMessage) => {
  if (message.type === 'screencast.frame') viewport.value?.pushFrame(message);
});
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
    <BrowserViewport ref="viewport" />
  </main>
</template>

<style scoped>
main {
  max-width: 1320px;
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
</style>
