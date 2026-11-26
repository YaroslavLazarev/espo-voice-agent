<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { LogEntry } from '../composables/useEventLog.ts';

const props = defineProps<{ entries: readonly Readonly<LogEntry>[] }>();

const list = ref<HTMLOListElement | null>(null);

const label: Record<LogEntry['kind'], string> = { user: 'You', agent: 'Agent', system: 'System', tool: 'Tool', error: 'Error' };

// Keep the newest line in view unless the user scrolled up.
watch(
  () => props.entries.map((e) => e.text.length).join(),
  async () => {
    const el = list.value;
    if (el === null) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    await nextTick();
    if (atBottom) el.scrollTop = el.scrollHeight;
  },
);
</script>

<template>
  <section class="log">
    <h2>Event log</h2>
    <ol ref="list">
      <li
        v-for="entry in entries"
        :key="entry.id"
        :class="[entry.kind, { pending: !entry.final }]"
      >
        <span class="meta">{{ entry.time }} · {{ label[entry.kind] }}</span>
        <span class="text">{{ entry.text }}</span>
      </li>
      <li
        v-if="entries.length === 0"
        class="empty"
      >
        Press Start and say hello.
      </li>
    </ol>
  </section>
</template>

<style scoped>
.log {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
h2 {
  font-size: 14px;
  margin: 0 0 6px;
}
ol {
  list-style: none;
  margin: 0;
  padding: 8px;
  overflow-y: auto;
  height: 320px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
  background: #fafafa;
}
li {
  display: flex;
  flex-direction: column;
  padding: 4px 0;
  border-bottom: 1px solid #eee;
}
.meta {
  font-size: 11px;
  color: #6b7280;
}
.user .text { color: #1d4ed8; }
.agent .text { color: #111827; }
.system .text { color: #6b7280; font-style: italic; }
.tool .text { color: #047857; font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; }
.error .text { color: #b91c1c; }
.pending .text { opacity: 0.65; }
.empty { color: #9ca3af; border: none; }
</style>
