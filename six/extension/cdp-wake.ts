import type { CDPPayload } from '@slicc/shared-ts';

type Send = (method: string, params?: CDPPayload) => Promise<CDPPayload>;

const WAKE: CDPPayload = { format: 'jpeg', quality: 1, maxWidth: 16, maxHeight: 16 };
const CASTS = new Set([
  'Page.startScreencast',
  'Page.stopScreencast',
  'Page.startScreenRecording',
  'Page.stopScreenRecording',
]);
const KEEP = 32;

export class Wake {
  private count = 0;
  private awake = false;
  private stopping = false;
  private cast = false;
  private readonly ours: unknown[] = [];
  private waking: Promise<void> = Promise.resolve();
  private calm: Promise<void> = Promise.resolve();
  private calmed!: () => void;
  private resting: Promise<void> = Promise.resolve();

  constructor(private readonly send: Send) {}

  async command(
    method: string,
    params: CDPPayload | undefined,
    forward: Send
  ): Promise<CDPPayload> {
    if (CASTS.has(method)) return this.casting(method, params, forward);
    if (method !== 'Page.captureScreenshot' || this.cast) return forward(method, params);
    await this.rise();
    try {
      return await forward(method, params);
    } finally {
      this.settle();
    }
  }

  private async rise(): Promise<void> {
    this.count += 1;
    if (this.count === 1) {
      this.calm = new Promise((resolve) => {
        this.calmed = resolve;
      });
      const rested = this.resting;
      this.waking = rested.then(() =>
        this.send('Page.startScreencast', WAKE).then(
          () => {
            this.awake = true;
          },
          () => undefined
        )
      );
    }
    await this.waking;
  }

  private settle(): void {
    this.count -= 1;
    if (this.count > 0) return;
    const calmed = this.calmed;
    if (!this.awake) {
      calmed();
      return;
    }
    this.awake = false;
    this.stopping = true;
    this.resting = this.send('Page.stopScreencast', {})
      .catch(() => undefined)
      .then(() => {
        this.stopping = false;
        calmed();
      });
  }

  private async casting(
    method: string,
    params: CDPPayload | undefined,
    forward: Send
  ): Promise<CDPPayload> {
    const starts = method.startsWith('Page.start');
    const before = this.cast;
    if (starts) this.cast = true;
    while (this.count > 0) await this.calm;
    await this.resting;
    try {
      const result = await forward(method, params);
      if (!starts) this.cast = false;
      return result;
    } catch (error) {
      if (starts) this.cast = before;
      throw error;
    }
  }

  hides(method: string, params: CDPPayload | undefined): boolean {
    if (!method.startsWith('Page.screencast')) return false;
    const id = params?.['sessionId'];
    if (!this.cast || this.count > 0 || this.awake || this.stopping) {
      if (id !== undefined && !this.ours.includes(id)) {
        this.ours.push(id);
        if (this.ours.length > KEEP) this.ours.shift();
      }
      return true;
    }
    return id !== undefined && this.ours.includes(id);
  }
}
