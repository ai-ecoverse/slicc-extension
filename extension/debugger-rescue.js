const KEY = 'slicc:debugger:675';
const ALARM = 'slicc:debugger:675';
const managers = new WeakMap();

function bounded(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('debugger rescue timed out')), 2000);
    }),
  ]).finally(() => clearTimeout(timer));
}

class Rescue {
  constructor(api) {
    this.api = api;
    this.records = {};
    this.live = new Map();
    this.chain = Promise.resolve();
    this.ready = this.start();
    api.alarms?.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM)
        void this.ready
          .catch(() => undefined)
          .then(() => this.recover())
          .catch(() => undefined);
    });
  }

  async start() {
    const stored = await bounded(this.api.storage.session.get(KEY));
    this.records = stored[KEY] ?? {};
    await this.recover();
  }

  save() {
    const records = structuredClone(this.records);
    this.chain = this.chain.then(() => bounded(this.api.storage.session.set({ [KEY]: records })));
    return this.chain;
  }

  async recover() {
    for (const [key, record] of Object.entries(this.records)) {
      if (this.live.has(key)) continue;
      await this.release(Number(key));
      if (this.records[key] === record) delete this.records[key];
    }
    await this.save();
    if (Object.keys(this.records).length === 0) await this.api.alarms.clear(ALARM);
  }

  async release(tabId) {
    for (const method of ['Debugger.resume', 'Debugger.disable']) {
      await bounded(this.api.debugger.sendCommand({ tabId }, method, {})).catch(() => undefined);
    }
    await bounded(this.api.debugger.detach({ tabId })).catch((error) => {
      if (!/not attached|No tab with id/i.test(String(error?.message))) throw error;
    });
  }

  async own(tabId, token, document = {}) {
    await this.ready;
    const key = String(tabId);
    if (this.live.has(key) && this.live.get(key) !== token)
      throw new Error('debugger already owned');
    this.records[key] = { ...document, token, deadline: 0 };
    this.live.set(key, token);
    await this.save();
    await this.api.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  }

  async pause(tabId, token, deadline, document = {}) {
    const key = String(tabId);
    if (this.live.get(key) !== token) throw new Error('debugger owner lost');
    this.records[key] = { ...this.records[key], ...document, token, deadline };
    await this.save();
  }

  abandon(tabId, token) {
    const key = String(tabId);
    if (this.live.get(key) === token) this.live.delete(key);
  }

  async forget(tabId, token) {
    const key = String(tabId);
    if (this.live.get(key) !== token) return;
    this.live.delete(key);
    delete this.records[key];
    await this.save();
    if (Object.keys(this.records).length === 0) await this.api.alarms.clear(ALARM);
  }
}

export function debuggerRescue(api) {
  let manager = managers.get(api);
  if (!manager) {
    manager = new Rescue(api);
    managers.set(api, manager);
    void manager.ready.catch(() => undefined);
  }
  return manager;
}
