<script setup lang="ts">
import { ref } from 'vue';

export interface Frame {
  /** base64 JPEG */
  data: string;
  width: number;
  height: number;
}

const canvas = ref<HTMLCanvasElement | null>(null);
const hasFrame = ref(false);

// Decode one frame at a time and keep only the latest pending one, so slow decoding never queues up.
let decoding = false;
let pending: Frame | null = null;

function base64ToBlob(data: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

async function draw(frame: Frame): Promise<void> {
  const el = canvas.value;
  if (el === null) return;
  const bitmap = await createImageBitmap(base64ToBlob(frame.data));
  if (el.width !== bitmap.width || el.height !== bitmap.height) {
    el.width = bitmap.width;
    el.height = bitmap.height;
  }
  el.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  hasFrame.value = true;
}

async function pump(): Promise<void> {
  decoding = true;
  while (pending !== null) {
    const frame = pending;
    pending = null;
    await draw(frame).catch((error: unknown) => {
      console.warn('frame decode failed', error);
    });
  }
  decoding = false;
}

function pushFrame(frame: Frame): void {
  pending = frame;
  if (!decoding) void pump();
}

defineExpose({ pushFrame });
</script>

<template>
  <div class="viewport">
    <canvas
      v-show="hasFrame"
      ref="canvas"
    />
    <p
      v-if="!hasFrame"
      class="placeholder"
    >
      Waiting for the browser…
    </p>
  </div>
</template>

<style scoped>
.viewport {
  position: relative;
  aspect-ratio: 1280 / 800;
  width: 100%;
  background: #111;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
canvas {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.placeholder {
  color: #aaa;
}
</style>
