import type { CDPSession, Page } from 'playwright';

export interface ScreencastFrame {
  /** base64 JPEG */
  data: string;
  width: number;
  height: number;
}

export interface ScreencastOptions {
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}

/**
 * CDP `Page.startScreencast` → frames (specs/design.md §6).
 * Every frame is acked first (or Chromium stalls the stream), then forwarded
 * unless `isBackpressured()` says the transport is full, in which case it is dropped.
 */
export class ScreencastStreamer {
  private session: CDPSession | null = null;
  private dropped = 0;

  constructor(
    private readonly page: Page,
    private readonly onFrame: (frame: ScreencastFrame) => void,
    private readonly isBackpressured: () => boolean,
    private readonly options: ScreencastOptions = {},
  ) {}

  get droppedFrames(): number {
    return this.dropped;
  }

  async start(): Promise<void> {
    if (this.session !== null) return;
    const session = await this.page.context().newCDPSession(this.page);
    this.session = session;
    session.on('Page.screencastFrame', (event) => {
      session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
      if (this.isBackpressured()) {
        this.dropped++;
        return;
      }
      this.onFrame({
        data: event.data,
        width: Math.round(event.metadata.deviceWidth),
        height: Math.round(event.metadata.deviceHeight),
      });
    });
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.options.quality ?? 60,
      maxWidth: this.options.maxWidth ?? 1280,
      maxHeight: this.options.maxHeight ?? 800,
      everyNthFrame: this.options.everyNthFrame ?? 1,
    });
  }

  async stop(): Promise<void> {
    const session = this.session;
    if (session === null) return;
    this.session = null;
    await session.send('Page.stopScreencast').catch(() => undefined);
    await session.detach().catch(() => undefined);
  }
}
