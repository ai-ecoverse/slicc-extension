import { debuggerRescue } from './debugger-rescue.js';
import { protectedRules } from './protected-rules.js';
import { frameIn, objectContext, PROFILED, unknownFrame } from './shield.js';

export const debuggerLifetimes = new Map([
  ['Debugger.enable', 'persistent'],
  ['Debugger.setInstrumentationBreakpoint', 'persistent'],
  ['Debugger.getScriptSource', 'document'],
  ['Debugger.evaluateOnCallFrame', 'document'],
  ['Debugger.disable', 'cleanup'],
  ['Debugger.removeBreakpoint', 'cleanup'],
  ['Debugger.resume', 'pause-control'],
]);

export function debuggerDomain(method) {
  return ['Debugger.', 'DOMDebugger.', 'EventBreakpoints.'].some((prefix) =>
    method.startsWith(prefix)
  );
}

function refused() {
  throw new Error(protectedRules.refusal);
}

function bounded(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('debugger proof timed out')), 2000);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class DebuggerGate {
  constructor(connection) {
    this.connection = connection;
    this.states = new Map();
    this.placements = new Map();
  }

  frameBlocked(frame) {
    const c = this.connection;
    return Boolean(
      c.protectedOrigin(frame.url) ||
        c.protectedOrigin(frame.securityOrigin) ||
        frame.errorOccurred ||
        frame.unreachableUrl ||
        frame.url?.startsWith('chrome-error:') ||
        frame.url?.startsWith('chrome-extension:') ||
        frame.securityOrigin?.startsWith('chrome-extension:')
    );
  }

  rememberFrame(tab, frame) {
    if (typeof frame.id !== 'string') return;
    tab.debuggerFrameBlocks ??= new Set();
    if (this.frameBlocked(frame)) tab.debuggerFrameBlocks.add(frame.id);
    else if (!unknownFrame(frame)) tab.debuggerFrameBlocks.delete(frame.id);
  }

  frameMarks(tab) {
    return JSON.stringify(
      [...tab.frames]
        .filter(([, hidden]) => hidden)
        .map(([id]) => id)
        .sort()
    );
  }

  childKey(tab) {
    return JSON.stringify(
      [...tab.debuggerChildren].sort().map((id) => [id, tab.debuggerChildInfo?.get(id)])
    );
  }

  knownChildren(tab) {
    const c = this.connection;
    return [...tab.debuggerChildren].every((id) => {
      const info = tab.debuggerChildInfo?.get(id);
      return Boolean(
        info &&
          typeof info.target === 'string' &&
          info.target &&
          info.generation === tab.documents.frames.get(tab.mainFrameId)?.loaderId &&
          info.revision === tab.debuggerRevision &&
          (info.type === 'iframe' || info.type === 'worker') &&
          typeof info.url === 'string' &&
          /^https?:\/\//.test(info.url) &&
          URL.canParse(info.url) &&
          !c.protectedOrigin(info.url)
      );
    });
  }

  childrenPlaced(tabId) {
    const tab = this.connection.tabState(tabId);
    if (!tab) return false;
    if (!tab.debuggerChildren.size && ![...tab.frames.values()].some(Boolean)) return true;
    const placed = this.placements.get(tabId);
    return Boolean(
      placed &&
        this.knownChildren(tab) &&
        placed.revision === tab.debuggerRevision &&
        placed.frames === tab.frameEvents &&
        placed.marks === this.frameMarks(tab) &&
        placed.generation === tab.documents.frames.get(tab.mainFrameId)?.loaderId &&
        placed.children === this.childKey(tab)
    );
  }

  async placeChildren(tabId) {
    const c = this.connection;
    const tab = c.tabState(tabId);
    if (!tab.debuggerChildren.size && ![...tab.frames.values()].some(Boolean)) return;
    if (!this.knownChildren(tab)) refused();
    const revision = tab.debuggerRevision;
    const marks = this.frameMarks(tab);
    const children = this.childKey(tab);
    const list = await bounded(c.frames(tabId));
    if (
      c.tabState(tabId) !== tab ||
      tab.debuggerRevision !== revision ||
      this.frameMarks(tab) !== marks ||
      this.childKey(tab) !== children ||
      list.revision !== tab.frameEvents ||
      list.rootFrameId !== tab.mainFrameId ||
      list.rootLoaderId !== tab.documents.frames.get(tab.mainFrameId)?.loaderId ||
      list.remoteOwners.length >= list.frames.length ||
      [...tab.frames.values()].filter(Boolean).length >= list.frames.length ||
      [...tab.debuggerChildren].filter((id) => tab.debuggerChildInfo.get(id)?.type === 'iframe')
        .length >= list.frames.length ||
      !list.frames.every((frame) => /^https?:\/\//.test(frame.url) && !c.protectedOrigin(frame.url))
    )
      refused();
    this.placements.set(tabId, {
      revision,
      frames: list.revision,
      marks,
      generation: list.rootLoaderId,
      children,
    });
  }

  unplaced(tab) {
    const entries = [...tab.worlds.ids.values()];
    if (
      !entries.some(
        (entry) =>
          entry.context?.auxData?.isDefault === true &&
          entry.context.auxData.frameId === tab.mainFrameId
      )
    )
      return true;
    return entries.some((entry) => {
      const context = entry.context;
      const document = tab.documents.contexts.get(context?.id);
      const frame = tab.documents.frames.get(context?.auxData?.frameId);
      return (
        entry.hidden ||
        !context?.uniqueId ||
        !document ||
        !frame ||
        document.uniqueId !== context.uniqueId ||
        document.loaderId !== frame.loaderId
      );
    });
  }

  placed(tab, tree) {
    return [...tab.worlds.ids.values()].every((entry) => {
      const context = entry.context;
      const document = tab.documents.contexts.get(context?.id);
      const frame = frameIn(tree, context?.auxData?.frameId);
      return (
        document &&
        frame &&
        document.loaderId === frame.loaderId &&
        typeof context.origin === 'string' &&
        /^https?:\/\//.test(context.origin) &&
        !this.connection.protectedOrigin(context.origin)
      );
    });
  }

  current(tabId, state) {
    const c = this.connection;
    const tab = c.tabState(tabId);
    return (
      !state.suspension &&
      !c.closed &&
      this.states.get(tabId) === state &&
      c.state.sessions.get(state.owner)?.tabId === tabId &&
      tab?.documents.frames.get(tab.mainFrameId)?.loaderId === state.generation &&
      tab.debuggerRevision === state.revision &&
      !tab.worlds.foreign &&
      !tab.debuggerFrameBlocks?.size &&
      tab.pendingFrames.size === 0 &&
      this.childrenPlaced(tabId) &&
      !this.unplaced(tab)
    );
  }

  convertible(tabId, state, requireWitness = true) {
    const c = this.connection;
    const tab = c.tabState(tabId);
    return (
      state?.enabled &&
      (!requireWitness || !state.suspension) &&
      !c.closed &&
      this.states.get(tabId) === state &&
      c.state.sessions.get(state.owner)?.tabId === tabId &&
      tab?.documents.frames.get(tab.mainFrameId)?.loaderId === state.generation &&
      tab.debuggerRevision === state.revision &&
      !tab.worlds.foreign &&
      (!requireWitness || this.childrenPlaced(tabId)) &&
      !tab.debuggerFrameBlocks?.size &&
      ![...tab.worlds.ids.values()].some((entry) => entry.hidden) &&
      ![...tab.documents.frames.values()].some(
        (frame) =>
          c.protectedOrigin(frame.url) ||
          c.protectedOrigin(frame.securityOrigin) ||
          frame.errorOccurred ||
          frame.unreachableUrl ||
          frame.url?.startsWith('chrome-error:')
      )
    );
  }

  async proof(tabId, state) {
    const c = this.connection;
    const tab = c.tabState(tabId);
    if (tab?.worlds.foreign) throw new Error(PROFILED);
    if (!tab?.pageObserved || tab.pendingFrames.size || tab.debuggerFrameBlocks?.size) refused();
    if (this.unplaced(tab)) refused();
    const generation = tab.documents.frames.get(tab.mainFrameId)?.loaderId;
    const revision = tab.debuggerRevision;
    await this.placeChildren(tabId);
    const [tree, frames] = await bounded(
      Promise.all([
        c.contentTree(tabId),
        c.contentFrames(tabId),
        c.admit(tabId, tab, 'Debugger.enable', {}, state?.owner),
      ])
    );
    const root = frameIn(tree.frameTree);
    if (
      c.tabState(tabId) !== tab ||
      tab.debuggerRevision !== revision ||
      !generation ||
      root.id !== tab.mainFrameId ||
      root.loaderId !== generation ||
      tab.documents.frames.get(tab.mainFrameId)?.loaderId !== generation ||
      tree.sealed ||
      tab.worlds.foreign ||
      tab.debuggerFrameBlocks?.size ||
      tab.pendingFrames.size ||
      !this.childrenPlaced(tabId) ||
      this.unplaced(tab) ||
      !this.placed(tab, tree.frameTree)
    )
      refused();
    const pending = [tree.frameTree];
    const ordinary = (frame) => {
      const url = frame?.url;
      return (
        typeof url === 'string' &&
        /^https?:\/\//.test(url) &&
        !c.protectedOrigin(url) &&
        !frame.errorOccurred &&
        !frame.unreachableUrl
      );
    };
    if (!frames.every(ordinary)) refused();
    while (pending.length) {
      const node = pending.pop();
      const frame = node?.frame;
      if (!ordinary(frame) || !ordinary({ url: frame.securityOrigin })) refused();
      if (node.childFrames !== undefined && !Array.isArray(node.childFrames)) refused();
      pending.push(...(node.childFrames ?? []));
    }
    if (state && (!this.current(tabId, state) || state.generation !== generation)) refused();
    return generation;
  }

  context(tabId, state, id, unique) {
    const tab = this.connection.tabState(tabId);
    const entry = tab?.worlds.ids.get(id);
    const document = tab?.documents.contexts.get(id);
    return (
      this.current(tabId, state) &&
      typeof unique === 'string' &&
      unique !== '' &&
      !entry?.hidden &&
      entry?.context?.uniqueId === unique &&
      entry.context.auxData?.isDefault === true &&
      entry.context.auxData.frameId === tab.mainFrameId &&
      document?.loaderId === state.generation &&
      document.uniqueId === unique
    );
  }

  valid(tabId, state, pause) {
    return (
      this.current(tabId, state) &&
      state.pause === pause &&
      pause?.published &&
      pause.generation === state.generation &&
      Date.now() < pause.deadline &&
      [...pause.contexts].every(([id, unique]) => this.context(tabId, state, id, unique))
    );
  }

  ids(tabId, state, pause, value, depth = 0) {
    if (depth > 32) return false;
    if (!value || typeof value !== 'object') return true;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'scriptId' && !pause.scripts.has(item)) return false;
      if (key === 'callFrameId' && !pause.frames.has(item)) return false;
      if (/^(objectId|\w+ObjectId)$/.test(key)) {
        const id = objectContext(item);
        if (!pause.contexts.has(id) || !this.context(tabId, state, id, pause.contexts.get(id)))
          return false;
      }
      if (!this.ids(tabId, state, pause, item, depth + 1)) return false;
    }
    return true;
  }

  async enable(tabId, owner, generation) {
    let state = this.states.get(tabId);
    if (state && state.owner !== owner) refused();
    if (state) return state;
    state = {
      owner,
      generation,
      revision: this.connection.tabState(tabId).debuggerRevision,
      token: crypto.randomUUID(),
      enabled: false,
      scripts: new Map(),
      scriptInfo: new Map(),
      publishedContexts: new Map(),
      breakpoints: new Set(),
      pause: null,
      resuming: null,
    };
    this.states.set(tabId, state);
    const rescue = debuggerRescue(this.connection.api);
    try {
      await rescue.own(tabId, state.token, { owner, generation, revision: state.revision });
    } catch (error) {
      if (rescue.live.get(String(tabId)) === state.token) await this.drop(tabId);
      else this.states.delete(tabId);
      throw error;
    }
    return state;
  }

  async command(tabId, owner, method, params) {
    const lifetime = debuggerLifetimes.get(method);
    if (!lifetime || lifetime === 'document') refused();
    const c = this.connection;
    const generation = await this.proof(tabId);
    const state =
      method === 'Debugger.enable'
        ? await this.enable(tabId, owner, generation)
        : this.states.get(tabId);
    if (
      !state ||
      state.owner !== owner ||
      state.generation !== generation ||
      !this.current(tabId, state) ||
      (method !== 'Debugger.enable' && !state.enabled)
    )
      refused();
    const pause = state.pause;
    if (lifetime === 'pause-control') {
      if (!this.valid(tabId, state, pause) || !this.ids(tabId, state, pause, params)) refused();
    }
    if (method === 'Debugger.removeBreakpoint' && !state.breakpoints.has(params.breakpointId))
      refused();
    if (method === 'Debugger.resume') {
      state.resuming = pause;
      state.pause = null;
    }
    let result;
    try {
      result = (await bounded(c.send(tabId, method, params))) ?? {};
      await this.proof(tabId, state);
      if (method === 'Debugger.enable') state.enabled = true;
      if (method === 'Debugger.setInstrumentationBreakpoint') {
        if (typeof result.breakpointId !== 'string' || !result.breakpointId) refused();
        state.breakpoints.add(result.breakpointId);
      }
      if (method === 'Debugger.removeBreakpoint') state.breakpoints.delete(params.breakpointId);
      if (method === 'Debugger.disable') await this.drop(tabId);
      return result;
    } catch (error) {
      await this.drop(tabId);
      throw error;
    }
  }

  script(tabId, state, method, params) {
    const c = this.connection;
    if (!this.convertible(tabId, state, false) || c.mentions(params)) return;
    if (
      typeof params.scriptId !== 'string' ||
      !params.scriptId ||
      !Number.isSafeInteger(params.executionContextId) ||
      params.executionContextId <= 0 ||
      state.scriptInfo.size >= 1000 ||
      JSON.stringify(params).length > 1048576
    )
      return;
    state.scriptInfo.set(params.scriptId, {
      url: params.url,
      embedderName: params.embedderName,
      context: params.executionContextId,
    });
    const tab = c.tabState(tabId);
    const context = tab.worlds.ids.get(params.executionContextId)?.context;
    const document = tab.documents.contexts.get(params.executionContextId);
    if (
      !context?.uniqueId ||
      context.auxData?.isDefault !== true ||
      context.auxData.frameId !== tab.mainFrameId ||
      document?.loaderId !== state.generation ||
      document.uniqueId !== context.uniqueId
    )
      return;
    if (
      typeof params.scriptId !== 'string' ||
      !params.scriptId ||
      state.scripts.size >= 1000 ||
      JSON.stringify(params).length > 1048576
    )
      return;
    state.scripts.set(params.scriptId, {
      method,
      params: structuredClone(params),
      context: context.id,
      unique: context.uniqueId,
    });
  }

  async resume(tabId, state, publish = false) {
    const c = this.connection;
    const pause = state?.pause;
    if (state) {
      state.resuming = publish && this.valid(tabId, state, pause) ? pause : null;
      state.pause = null;
    }
    if (pause?.timer) clearTimeout(pause.timer);
    try {
      await bounded(c.api.debugger.sendCommand({ tabId }, 'Debugger.resume', {}));
    } catch (error) {
      if (
        /not paused|not enabled|Can only perform operation while paused/i.test(
          String(error?.message)
        )
      )
        return;
      await bounded(c.api.debugger.detach({ tabId })).catch(() => {
        debuggerRescue(c.api).abandon(tabId, state?.token);
      });
    }
  }

  async drop(tabId, owner) {
    const state = this.states.get(tabId);
    if (!state || (owner !== undefined && state.owner !== owner)) return;
    if (state.suspension) clearTimeout(state.suspension.timer);
    this.placements.delete(tabId);
    this.states.delete(tabId);
    await this.resume(tabId, state);
    const rescue = debuggerRescue(this.connection.api);
    try {
      await bounded(this.connection.api.debugger.sendCommand({ tabId }, 'Debugger.disable', {}));
      await rescue.forget(tabId, state.token);
    } catch {
      rescue.abandon(tabId, state.token);
    }
  }

  async convert(tabId, state, pause) {
    if (pause.converted || !state.breakpoints.size) refused();
    pause.converted = true;
    await bounded(this.connection.send(tabId, 'Debugger.pause', {}));
    if (!this.convertible(tabId, state) || state.pause !== pause || Date.now() >= pause.deadline)
      refused();
    await bounded(this.connection.send(tabId, 'Debugger.resume', {}));
  }

  async expire(tabId, state, pause) {
    if (state.pause !== pause) return;
    if (pause.converted && !pause.published) await this.drop(tabId);
    else await this.resume(tabId, state, true);
  }

  rememberPublished(state, pause) {
    pause.published = true;
    for (const [id, unique] of pause.contexts) state.publishedContexts.set(id, unique);
  }

  privateInstrumentation(tabId, state, params) {
    if (params.reason !== 'instrumentation') return false;
    const id = params.data?.scriptId ?? params.callFrames?.[0]?.location?.scriptId;
    const info = state?.scriptInfo.get(id);
    if (info?.url === '' && info.embedderName === '') return true;
    const script = state?.scripts.get(id);
    return Boolean(
      script &&
        state.publishedContexts.get(script.context) === script.unique &&
        this.context(tabId, state, script.context, script.unique)
    );
  }

  pauseEligible(tabId, state, params) {
    return (
      this.convertible(tabId, state) &&
      (params.reason === 'instrumentation' || this.current(tabId, state)) &&
      !this.privateInstrumentation(tabId, state, params)
    );
  }

  async pauseReady(tabId, state, params) {
    if (!state?.enabled || state.suspension || this.privateInstrumentation(tabId, state, params))
      return false;
    if (!this.childrenPlaced(tabId)) {
      try {
        await this.proof(tabId, state);
      } catch {
        return false;
      }
    }
    return (
      this.pauseEligible(tabId, state, params) &&
      !this.connection.mentions(params) &&
      JSON.stringify(params).length <= 1048576
    );
  }

  async paused(tabId, state, params) {
    const c = this.connection;
    if (!(await this.pauseReady(tabId, state, params))) {
      await this.resume(tabId, state);
      return;
    }
    let pause = state.pause;
    if (!pause) {
      pause = {
        generation: state.generation,
        deadline: Date.now() + 5000,
        contexts: new Map(),
        scripts: new Set(),
        frames: new Set(),
        published: false,
        verifying: false,
        converted: false,
      };
      state.pause = pause;
      pause.timer = setTimeout(() => {
        void this.expire(tabId, state, pause);
      }, 5000);
    }
    try {
      if (pause.published || pause.verifying || Date.now() >= pause.deadline) refused();
      await bounded(
        debuggerRescue(c.api).pause(tabId, state.token, pause.deadline, {
          owner: state.owner,
          generation: state.generation,
          revision: state.revision,
        })
      );
      if (state.pause !== pause || Date.now() >= pause.deadline) refused();
      if (params.reason === 'instrumentation') {
        await this.convert(tabId, state, pause);
        return;
      }
      pause.verifying = true;
      await this.proof(tabId, state);
      if (!Array.isArray(params.callFrames) || params.callFrames.length === 0) refused();
      const scripts = [];
      for (const frame of params.callFrames) {
        const script = state.scripts.get(frame.location?.scriptId);
        if (
          !script ||
          !this.context(tabId, state, script.context, script.unique) ||
          objectContext(frame.callFrameId) !== script.context
        )
          refused();
        pause.frames.add(frame.callFrameId);
        pause.contexts.set(script.context, script.unique);
        if (!pause.scripts.has(frame.location.scriptId)) scripts.push(script);
        pause.scripts.add(frame.location.scriptId);
      }
      if (!this.ids(tabId, state, pause, params)) refused();
      await this.proof(tabId, state);
      if (state.pause !== pause || Date.now() >= pause.deadline) refused();
      for (const script of scripts)
        c.post({ method: script.method, params: script.params, sessionId: state.owner });
      c.post({ method: 'Debugger.paused', params, sessionId: state.owner });
      this.rememberPublished(state, pause);
    } catch {
      if (pause.converted && !pause.published) await this.drop(tabId);
      else await this.resume(tabId, state);
    }
  }

  async event(tabId, method, params) {
    const state = this.states.get(tabId);
    if (method === 'Debugger.paused') return this.paused(tabId, state, params);
    if (method === 'Debugger.scriptParsed' || method === 'Debugger.scriptFailedToParse') {
      this.script(tabId, state, method, params);
      return;
    }
    if (method === 'Debugger.resumed' && state?.resuming) {
      const pause = state.resuming;
      state.resuming = null;
      if (
        pause.published &&
        this.current(tabId, state) &&
        [...pause.contexts].every(([id, unique]) => this.context(tabId, state, id, unique))
      ) {
        this.connection.post({ method, params: {}, sessionId: state.owner });
      }
    }
  }

  suspend(tabId, state) {
    if (!state.suspension) {
      const suspension = { deadline: Date.now() + 5000 };
      state.suspension = suspension;
      suspension.timer = setTimeout(() => {
        if (this.states.get(tabId) === state && state.suspension === suspension)
          void this.drop(tabId);
      }, 5000);
      if (state.pause) void this.resume(tabId, state);
    }
    const suspension = state.suspension;
    if (suspension.reading) return;
    suspension.reading = true;
    void this.proof(tabId)
      .then(() => {
        const tab = this.connection.tabState(tabId);
        if (
          this.states.get(tabId) === state &&
          state.suspension === suspension &&
          Date.now() < suspension.deadline &&
          tab.documents.frames.get(tab.mainFrameId)?.loaderId === state.generation &&
          tab.debuggerRevision === state.revision &&
          !tab.debuggerFrameBlocks?.size &&
          this.childrenPlaced(tabId)
        ) {
          clearTimeout(suspension.timer);
          state.suspension = null;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        suspension.reading = false;
      });
  }

  revoke(tabId) {
    const state = this.states.get(tabId);
    if (!state) return;
    const tab = this.connection.tabState(tabId);
    if (
      !tab ||
      this.connection.closed ||
      tab.worlds.foreign ||
      tab.debuggerFrameBlocks?.size ||
      [...tab.worlds.ids.values()].some((entry) => entry.hidden) ||
      [...tab.documents.frames.values()].some(
        (frame) =>
          this.connection.protectedOrigin(frame.url) ||
          this.connection.protectedOrigin(frame.securityOrigin) ||
          frame.errorOccurred ||
          frame.unreachableUrl ||
          frame.url?.startsWith('chrome-error:')
      )
    ) {
      void this.drop(tabId);
      return;
    }
    const generation = tab.documents.frames.get(tab.mainFrameId)?.loaderId;
    if (
      state.generation !== generation ||
      state.revision !== tab.debuggerRevision ||
      (state.pause?.published && !this.valid(tabId, state, state.pause))
    ) {
      if (state.pause?.converted && !state.pause.published) {
        void this.drop(tabId);
        return;
      }
      if (state.pause) void this.resume(tabId, state);
      state.scripts.clear();
      state.scriptInfo.clear();
      state.publishedContexts.clear();
      state.resuming = null;
      state.generation = generation;
      state.revision = tab.debuggerRevision;
      if (state.suspension) clearTimeout(state.suspension.timer);
      state.suspension = null;
    }
    if (
      state.suspension ||
      ([...tab.frames.values()].some(Boolean) && !this.childrenPlaced(tabId)) ||
      !this.knownChildren(tab)
    )
      this.suspend(tabId, state);
  }
}
