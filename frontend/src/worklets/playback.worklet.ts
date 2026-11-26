/**
 * Agent audio playback. Runs in a 24 kHz AudioContext, so chunks play as-is.
 * `{ type: 'flush' }` drops everything queued at once (barge-in).
 */

export type PlaybackMessage = { type: 'chunk'; samples: Float32Array } | { type: 'flush' };

class PlaybackProcessor extends AudioWorkletProcessor {
  private queue: Float32Array[] = [];
  private offset = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<PlaybackMessage>) => {
      if (event.data.type === 'flush') {
        this.queue = [];
        this.offset = 0;
      } else {
        this.queue.push(event.data.samples);
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (out === undefined) return true;
    let written = 0;
    while (written < out.length) {
      const head = this.queue[0];
      if (head === undefined) break;
      const count = Math.min(out.length - written, head.length - this.offset);
      out.set(head.subarray(this.offset, this.offset + count), written);
      written += count;
      this.offset += count;
      if (this.offset >= head.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    out.fill(0, written);
    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
