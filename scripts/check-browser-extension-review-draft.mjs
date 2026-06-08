import { readFileSync } from 'node:fs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

const popupHtml = read('browser-extension/popup.html');
const popupJs = read('browser-extension/popup.js');
const sidepanelHtml = read('browser-extension/sidepanel.html');
const sidepanelJs = read('browser-extension/sidepanel.js');
const serviceWorker = read('browser-extension/service-worker.js');

for (const [name, html] of [['popup', popupHtml], ['sidepanel', sidepanelHtml]]) {
  assert(html.includes('draftTitle'), `${name}: missing editable draft title input.`);
  assert(html.includes('draftContent'), `${name}: missing editable draft content textarea.`);
  assert(html.includes('draftProject'), `${name}: missing draft project selector.`);
  assert(html.includes('draftTags'), `${name}: missing draft tags input.`);
  assert(html.includes('draftAsLesson'), `${name}: missing lesson candidate toggle.`);
  assert(html.includes('resetDraft'), `${name}: missing draft reset action.`);
}

assert(popupHtml.includes('准备保存'), 'popup: draft section must be visible to users.');
assert(sidepanelHtml.includes('准备保存'), 'sidepanel: draft section must be visible to users.');

assert(popupJs.includes('buildDraft'), 'popup: missing default draft builder.');
assert(popupJs.includes('getDraftMetaFields'), 'popup: missing editable draft metadata reader.');
assert(popupJs.includes("send('SAVE_CANDIDATE'"), 'popup: edited draft must save via SAVE_CANDIDATE.');
assert(popupJs.includes('title, text, meta'), 'popup: edited title, text, and metadata must be submitted together.');

assert(sidepanelJs.includes('buildDefaultDraft'), 'sidepanel: missing default draft builder.');
assert(sidepanelJs.includes('getDraftMetaFields'), 'sidepanel: missing editable draft metadata reader.');
assert(sidepanelJs.includes('data-draft-kind'), 'sidepanel: candidates must fill the draft instead of saving immediately.');
assert(sidepanelJs.includes("send('SAVE_CANDIDATE'"), 'sidepanel: edited draft must save via SAVE_CANDIDATE.');
assert(sidepanelJs.includes('kind, title, text, meta'), 'sidepanel: edited kind, title, text, and metadata must be submitted together.');

assert(serviceWorker.includes('async function saveCandidate(kind, text, title'), 'service worker: saveCandidate must accept edited titles.');
assert(serviceWorker.includes('normalizeCandidateMeta'), 'service worker: saveCandidate must normalize draft metadata.');
assert(serviceWorker.includes('message.meta'), 'service worker: SAVE_CANDIDATE message must pass draft metadata.');
assert(serviceWorker.includes('title: draftTitle'), 'service worker: review queue title must use edited draft title.');
assert(serviceWorker.includes('message.title'), 'service worker: SAVE_CANDIDATE message must pass edited title.');

console.log('browser extension review draft checks ok');
