const root = document.documentElement;
if (root) root.dataset.sliccFixture = chrome.runtime.id;
globalThis.sliccFixtureSecret = chrome.runtime.id;
const wanted = new URLSearchParams(location.search).has('fixture-frame');
if (wanted && window === window.top) {
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('frame.html');
  const attach = () => (document.body ?? document.documentElement).append(frame);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach, { once: true });
  } else {
    attach();
  }
}
