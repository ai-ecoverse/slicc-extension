const WAKE = { format: 'jpeg', quality: 1, maxWidth: 16, maxHeight: 16 };
const CASTS = new Set([
  'Page.startScreencast',
  'Page.stopScreencast',
  'Page.startScreenRecording',
  'Page.stopScreenRecording',
]);
const KEEP = 32;

export class Wake {
  constructor(send) {
    this.send = send;
    this.count = 0;
    this.awake = false;
    this.stopping = false;
    this.cast = false;
    this.ours = [];
    this.waking = Promise.resolve();
    this.calm = Promise.resolve();
    this.resting = Promise.resolve();
  }

  async command(method, params, forward) {
    if (CASTS.has(method)) return this.casting(method, params, forward);
    if (method !== 'Page.captureScreenshot' || this.cast) return forward(method, params);
    await this.rise();
    try {
      return await forward(method, params);
    } finally {
      this.settle();
    }
  }

  async rise() {
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

  settle() {
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

  async casting(method, params, forward) {
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

  hides(method, params) {
    if (!method.startsWith('Page.screencast')) return false;
    const id = params?.sessionId;
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
