/**
 * Mic capture: resamples the context rate (usually 44.1/48 kHz) to 16 kHz mono PCM16
 * and posts ~40 ms chunks plus an RMS level to the main thread.
 */

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 640; // 40 ms at 16 kHz

export interface CaptureMessage {
  pcm: ArrayBuffer;
  level: number;
}

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly step = sampleRate / TARGET_RATE;
  /** Position of the next output sample, in input samples relative to the current block (-1 = last sample of the previous block). */
  private pos = 0;
  private prev = 0;
  private chunk = new Int16Array(CHUNK_SAMPLES);
  private filled = 0;
  private sumSquares = 0;

  process(inputs: Float32Array[][]): boolean {
    const block = inputs[0]?.[0];
    if (block === undefined || block.length === 0) return true;
    const n = block.length;

    // Linear interpolation; `pos` stays in [-1, n - 1) so both neighbours are known.
    while (this.pos < n - 1) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i < 0 ? this.prev : (block[i] ?? 0);
      const b = block[i + 1] ?? 0;
      this.push(a + (b - a) * frac);
      this.pos += this.step;
    }
    this.pos -= n;
    this.prev = block[n - 1] ?? 0;
    return true;
  }

  private push(sample: number): void {
    const s = Math.max(-1, Math.min(1, sample));
    this.chunk[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    this.sumSquares += s * s;
    if (this.filled < CHUNK_SAMPLES) return;

    const message: CaptureMessage = { pcm: this.chunk.buffer, level: Math.sqrt(this.sumSquares / CHUNK_SAMPLES) };
    this.port.postMessage(message, [this.chunk.buffer]);
    this.chunk = new Int16Array(CHUNK_SAMPLES);
    this.filled = 0;
    this.sumSquares = 0;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
