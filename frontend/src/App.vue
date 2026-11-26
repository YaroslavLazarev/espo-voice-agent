<script setup lang="ts">
import { onMounted, ref } from 'vue';

type HealthState = 'checking' | 'ok' | 'unreachable';

const health = ref<HealthState>('checking');

onMounted(async () => {
  try {
    const res = await fetch('/health');
    health.value = res.ok ? 'ok' : 'unreachable';
  } catch {
    health.value = 'unreachable';
  }
});
</script>

<template>
  <main>
    <h1>EspoCRM Voice Agent</h1>
    <p>Backend: {{ health }}</p>
  </main>
</template>
