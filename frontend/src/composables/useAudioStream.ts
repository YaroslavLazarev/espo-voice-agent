import { onBeforeUnmount, readonly, ref } from 'vue';
import captureWorkletUrl from '../worklets/capture.worklet.ts?worker&url';
import playbackWorkletUrl from '../worklets/playback.worklet.ts?worker&url';
import type { CaptureMessage } from '../worklets/capture.worklet.ts';
import type { PlaybackMessage } from '../worklets/playback.worklet.ts';
import { base64Pcm16ToFloat32, bytesToBase64 } from './pcm.ts';

const PLAYBACK_RATE = 24000;

/**
 * Mic capture (16 kHz PCM16 base64 chunks → `onChunk`) and agent playback (24 kHz queue with
 * instant `flush()`), both through AudioWorklets (specs/design.md §9).
 */
export function useAudioStream(onChunk: (base64Pcm16: string) => void) {
  const active = ref(false);
  const level = ref(0);

  let stream: MediaStream | null = null;
  let captureCtx: AudioContext | null = null;
  let playbackCtx: AudioContext | null = null;
  let playbackNode: AudioWorkletNode | null = null;

  /** Must be called from a user gesture (AudioContext autoplay policy). Throws if the mic is denied. */
  async function start(): Promise<void> {
    if (active.value) return;
    try {
      playbackCtx = new AudioContext({ sampleRate: PLAYBACK_RATE });
      await playbackCtx.audioWorklet.addModule(playbackWorkletUrl);
      playbackNode = new AudioWorkletNode(playbackCtx, 'playback-processor');
      playbackNode.connect(playbackCtx.destination);

      // Echo cancellation is mandatory: otherwise the agent hears itself and barges in on itself.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      captureCtx = new AudioContext();
      await captureCtx.audioWorklet.addModule(captureWorkletUrl);
      const source = captureCtx.createMediaStreamSource(stream);
      // No outputs: the node is still processed, and nothing is played back locally.
      const captureNode = new AudioWorkletNode(captureCtx, 'capture-processor', { numberOfOutputs: 0 });
      captureNode.port.onmessage = (event: MessageEvent<CaptureMessage>) => {
        level.value = event.data.level;
        onChunk(bytesToBase64(new Uint8Array(event.data.pcm)));
      };
      source.connect(captureNode);
      active.value = true;
    } catch (error) {
      stop();
      throw error;
    }
  }

  function stop(): void {
    active.value = false;
    level.value = 0;
    stream?.getTracks().forEach((track) => {
      track.stop();
    });
    stream = null;
    void captureCtx?.close();
    captureCtx = null;
    void playbackCtx?.close();
    playbackCtx = null;
    playbackNode = null;
  }

  function play(base64Pcm16: string): void {
    const samples = base64Pcm16ToFloat32(base64Pcm16);
    const message: PlaybackMessage = { type: 'chunk', samples };
    playbackNode?.port.postMessage(message, [samples.buffer]);
  }

  /** Drops all queued agent audio immediately (barge-in). */
  function flush(): void {
    const message: PlaybackMessage = { type: 'flush' };
    playbackNode?.port.postMessage(message);
  }

  onBeforeUnmount(stop);

  return { active: readonly(active), level: readonly(level), start, stop, play, flush };
}
