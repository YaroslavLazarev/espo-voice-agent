<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Status } from '@espo/shared';

const props = defineProps<{
  /** Mic + session are running. */
  active: boolean;
  gemini: Status;
  /** Mic RMS level, 0..1. */
  level: number;
  /** The server socket is open. */
  online: boolean;
}>();

const emit = defineEmits<{
  start: [];
  stop: [];
  text: [text: string];
}>();

const draft = ref('');

// Speech RMS is usually well below 0.3; scale so normal speech fills most of the bar.
const meter = computed(() => `${Math.min(100, Math.round(props.level * 400))}%`);

function sendText(): void {
  const text = draft.value.trim();
  if (text === '') return;
  emit('text', text);
  draft.value = '';
}
</script>

<template>
  <section class="voice">
    <button
      v-if="!active"
      type="button"
      class="start"
      :disabled="!online"
      @click="emit('start')"
    >
      Start
    </button>
    <button
      v-else
      type="button"
      class="stop"
      @click="emit('stop')"
    >
      Stop
    </button>
    <div
      class="meter"
      title="Mic level"
    >
      <div
        class="bar"
        :style="{ width: meter }"
      />
    </div>
    <span class="state">{{ active ? `Gemini: ${gemini}` : 'Idle' }}</span>
    <form
      class="text"
      @submit.prevent="sendText"
    >
      <input
        v-model="draft"
        type="text"
        placeholder="Or type a message…"
        :disabled="!active || gemini !== 'ready'"
      >
    </form>
  </section>
</template>

<style scoped>
.voice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
button {
  padding: 6px 18px;
  border-radius: 6px;
  border: none;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.start { background: #15803d; }
.stop { background: #b91c1c; }
.meter {
  width: 120px;
  height: 8px;
  border-radius: 4px;
  background: #e5e7eb;
  overflow: hidden;
}
.bar {
  height: 100%;
  background: #22c55e;
  transition: width 60ms linear;
}
.state {
  font-size: 13px;
  color: #374151;
}
.text {
  flex: 1 1 220px;
}
.text input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  font-size: 14px;
}
</style>
