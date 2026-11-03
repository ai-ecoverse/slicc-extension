export function ownerSnapshot(root) {
  const domNodes = [];
  const visit = (node) => {
    const index = domNodes.length;
    const frameId = node.frameId ?? (index === 0 ? 'root' : undefined);
    const entry = {
      nodeType: node.nodeName === '#document' || node.nodeName === undefined ? 9 : 1,
      nodeName: node.nodeName ?? '#document',
      frameId,
      backendNodeId: index + 1,
      ...(node.documentURL ? { documentURL: node.documentURL } : {}),
      attributes: (node.attributes ?? []).reduce(
        (items, value, at, all) =>
          at % 2 ? items : [...items, { name: value, value: all[at + 1] }],
        []
      ),
    };
    domNodes.push(entry);
    if (node.contentDocument)
      entry.contentDocumentIndex = visit({
        ...node.contentDocument,
        frameId: node.contentDocument.frameId ?? frameId,
      });
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) visit(child);
    return index;
  };
  visit(root);
  return { domNodes, layoutTreeNodes: [], computedStyles: [] };
}
