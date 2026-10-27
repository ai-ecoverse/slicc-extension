export const seven = `  async checkContent(tabId, method, params = {}) {
    if (method === 'IO.read' && this.state.streams.get(textOf(params.handle))?.page === false)
      return;
    const reads = errorPageRead(method);
    if (!reads && typeof params.frameId !== 'string') return;
    const tree = await bounded(
      this.send(tabId, 'Page.getFrameTree', {}),
      2000,
      'content frame'
    ).catch(() => refusal());
    const root = frameIn(tree?.frameTree);
    if (
      !root ||
      typeof root.id !== 'string' ||
      !root.id ||
      typeof root.url !== 'string' ||
      !root.url ||
      typeof root.securityOrigin !== 'string'
    )
      refusal();
    if (typeof params.frameId === 'string' && !frameIn(tree?.frameTree, params.frameId)) refusal();
    if (!reads) return;
    if (
      anyProtected(root.url) ||
      anyProtected(root.securityOrigin) ||
      treeNamesProtected(tree?.frameTree, anyProtected, true)
    )
      refusal();
    if (method.startsWith('Runtime.')) return;
    const frames = await bounded(
      Promise.resolve().then(() => this.api.webNavigation?.getAllFrames?.({ tabId })),
      2000,
      'content frames'
    ).catch(() => refusal());
    if (!Array.isArray(frames) || frames.length === 0) refusal();
    if (frames.some((frame) => frame.errorOccurred === true && anyProtected(frame.url))) refusal();
  }`;

export const six = `  private async checkContent(method: string, params: CDPPayload = {}): Promise<void> {
    if (method === 'IO.read' && this.streams.get(str(params['handle']) ?? '')?.page === false)
      return;
    const reads = errorPageRead(method);
    const frameId = str(params['frameId']);
    if (!reads && frameId === undefined) return;
    const tree = await shieldProbe(this.send('Page.getFrameTree', {})).catch(() =>
      refuse(PROTECTED_RULES.refusal)
    );
    const root = frameIn(tree['frameTree'], undefined);
    const url = str(root?.['url']);
    const origin = str(root?.['securityOrigin']);
    if (!root || !str(root['id']) || !url || origin === undefined) refuse(PROTECTED_RULES.refusal);
    if (frameId !== undefined && !frameIn(tree['frameTree'], frameId))
      refuse(PROTECTED_RULES.refusal);
    if (!reads) return;
    if (urlProtected(url) || urlProtected(origin) || treeNamesProtected(tree['frameTree'], true))
      refuse(PROTECTED_RULES.refusal);
    if (method.startsWith('Runtime.')) return;
    const hidden = await shieldProbe(this.readErrorFrames().then((blocked) => ({ blocked }))).catch(
      () => refuse(PROTECTED_RULES.refusal)
    );
    if (hidden['blocked'] !== false) refuse(PROTECTED_RULES.refusal);
  }`;
