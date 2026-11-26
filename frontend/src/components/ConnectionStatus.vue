<script setup lang="ts">
import type { Status } from '@espo/shared';
import type { SocketStatus } from '../composables/useAgentSocket.ts';

defineProps<{
  socket: SocketStatus;
  browser: Status;
  gemini: Status;
}>();

const tone = (status: string): string => {
  if (status === 'open' || status === 'ready') return 'ok';
  if (status === 'error') return 'bad';
  if (status === 'closed') return 'off';
  return 'wait';
};
</script>

<template>
  <ul class="status">
    <li :class="tone(socket)">
      Server: {{ socket }}
    </li>
    <li :class="tone(browser)">
      Browser: {{ browser }}
    </li>
    <li :class="tone(gemini)">
      Gemini: {{ gemini }}
    </li>
  </ul>
</template>

<style scoped>
.status {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  list-style: none;
  padding: 0;
  margin: 0;
}
li {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 13px;
  border: 1px solid currentColor;
}
.ok { color: #15803d; }
.wait { color: #b45309; }
.bad { color: #b91c1c; }
.off { color: #6b7280; }
</style>
