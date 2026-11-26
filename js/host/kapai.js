/*
 * The page's Kapai client (https://stg.kap.ai/agents.md, part 4A, "The package's own files"): Kapai runs the included AI
 * of the Claude chat, counts each browser's credits and sells more when the server sells any.
 *
 * The SDK is vendored, not installed: js/vendor/kapai/ holds the browser files of @kapai/sdk 0.1.0
 * (kapai-sdk-0.1.0-384a3ce4.tgz, SHA-256 384a3ce4b7fc20ce95a528cf01241e1bb2ea2bc3b5d8c262712e1cf9180e1383; index.js,
 * ui.js, chunk-*.js, dev-pill-*.js), unchanged. CLOADM has no build step and no package manager (AGENTS rule 2), so a
 * copy is the only form it can take. To update: copy all the files of the new package again (the chunk names change
 * with each build), then node tools/pwa-files.js --write.
 *
 * The SDK keeps the install and its token in localStorage (keys starting "kapai:") and its key pair in IndexedDB.
 * The person's Anthropic key is not Kapai's: it stays in the page's key store (js/host/key-store.js), and the page
 * makes those requests itself, as Kapai's app-managed own AI (js/claude/kapai-backend.js, ownKeyResponder).
 *
 * A test seam: a page whose window has `cloadmKapaiMock` (a browser check sets it before the page loads) gets the
 * SDK's mock in that state instead (mockKapai, no server), with the "Any time" own-AI policy, so a saved key answers.
 */
import { Kapai, KapaiOwnAI, mockKapai } from '../vendor/kapai/index.js';
import { connectElements } from '../vendor/kapai/ui.js';

// The publishable key is public: it names the app and gives no access to the developer's account (agents.md part 2).
// Kapai has no secret key for an app.
export const KAPAI_PUBLISHABLE_KEY = 'pk_test_YbDj7hDHpbv9jEjscNT1109m';
export const KAPAI_SERVER = 'https://api.stg.kap.ai';

// -> the page's Kapai client. ownKey: { label() (the service of the saved key, or null), respond (the own-key request),
// openSettings() (opens the page's key form) }
export function pageKapai(ownKey) {
  const ownAI = KapaiOwnAI.appManaged(ownKey);
  const mock = typeof window !== 'undefined' && window.cloadmKapaiMock;
  if (mock) return mockKapai(String(mock), { appName: 'CLOADM', ownAIPolicy: 'anytime', ownAI });
  return new Kapai({ publishableKey: KAPAI_PUBLISHABLE_KEY, baseUrl: KAPAI_SERVER, ownAI });
}

// The elements (<kapai-plan-pill>, <kapai-limit-prompt>) are connected the first time the person opens Claude, not at
// page load: connecting them reads the plan, which registers this browser as an install, and most visits never use AI.
let connected = null;
export function connectKapaiElements(kapai) {
  if (connected !== kapai) { connectElements(kapai); connected = kapai; }
}
