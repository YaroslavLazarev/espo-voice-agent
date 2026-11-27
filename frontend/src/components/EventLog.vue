<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { LogEntry } from '../composables/useEventLog.ts';

const props = defineProps<{ entries: readonly Readonly<LogEntry>[] }>();

const list = ref<HTMLOListElement | null>(null);
const showTools = ref(true);

const label: Record<LogEntry['kind'], string> = { user: 'You', agent: 'Agent', system: 'System', tool: 'Tool', error: 'Error' };

const visible = computed(() => (showTools.value ? props.entries : props.entries.filter((e) => e.kind !== 'tool')));

// Keep the newest line in view unless the user scrolled up.
watch(
  () => visible.value.map((e) => e.text.length).join(),
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
    <header>
      <h2>Event log</h2>
      <label class="toggle">
        <input
          v-model="showTools"
          type="checkbox"
        >
        Tool calls
      </label>
    </header>
    <ol ref="list">
      <li
        v-for="entry in visible"
        :key="entry.id"
        :class="[entry.kind, { pending: !entry.final }]"
      >
        <span class="meta">
          <span class="tag">{{ label[entry.kind] }}</span>
          <time>{{ entry.time }}</time>
        </span>
        <span class="text">{{ entry.text }}</span>
        <a
          v-if="entry.href"
          class="link"
          :href="entry.href"
          target="_blank"
          rel="noopener noreferrer"
        >{{ entry.href }}</a>
      </li>
      <li
        v-if="visible.length === 0"
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
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
h2 {
  font-size: 14px;
  margin: 0;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #4b5563;
  cursor: pointer;
}
ol {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  height: clamp(320px, calc(100vh - 180px), 800px);
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.4;
  background: #fafafa;
}
li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 4px;
  padding: 4px 8px;
  border-left: 3px solid transparent;
  border-radius: 4px;
}
.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #9ca3af;
}
.tag {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.user { border-left-color: #2563eb; background: #eff6ff; }
.user .tag { color: #1d4ed8; }
.agent { border-left-color: #6b7280; background: #fff; }
.agent .tag { color: #374151; }
.system { padding-top: 2px; padding-bottom: 2px; }
.system .text { color: #6b7280; font-style: italic; font-size: 12px; }
.tool { border-left-color: #10b981; }
.tool .tag { color: #047857; }
.tool .text { color: #065f46; font-family: ui-monospace, monospace; font-size: 12px; }
.error { border-left-color: #dc2626; background: #fef2f2; }
.error .tag, .error .text { color: #b91c1c; }
.pending .text { opacity: 0.6; }
.pending .text::after { content: ' …'; }
.link { font-size: 12px; color: #1d4ed8; overflow-wrap: anywhere; }
.empty { color: #9ca3af; border: none; font-style: italic; }
</style>
