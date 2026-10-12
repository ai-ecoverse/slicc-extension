export const protectedRules = {
  domains: ['sliccy.ai'],
  schemes: ['https', 'http'],
  innerSchemes: ['blob', 'filesystem', 'view-source'],
  anySchemes: ['devtools'],
  inheriting: ['about:blank', 'about:srcdoc'],
  refusal: "slicc: refused: target is on seven's origin",
};
