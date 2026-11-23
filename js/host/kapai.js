/*
 * EXPERIMENT (?ai=kapai): the Kapai client for the page's Claude chat (js/claude/kapai-backend.js).
 *
 * The SDK is the vendor's one-file browser build, vendored unchanged: js/host/kapai/kapai-sdk-0.1.0-e250ded4.mjs,
 * @kapai/sdk 0.1.0 (MIT), SHA-256 e250ded417de8e95e8ca02fccb5416f0afdcde510edaf480621c685779f7f0dc, from
 * https://stg.kap.ai/sdk/kapai-sdk-0.1.0-e250ded4.mjs. It imports no other file, so it needs no build step (AGENTS
 * rule 2). To update: download the new file (its name changes with each build), check its SHA-256 against the one the
 * site publishes, replace this one and the import below. It is loaded only when the page asks for Kapai (a dynamic
 * import), so the default path never fetches it.
 *
 * The key is publishable: it identifies the app and gives no access to the developer's account (the vendor's guide,
 * part 2). The user's own Anthropic key, when saved, is the "own AI" (KapaiOwnAI.appManaged): CLOADM keeps it and
 * sends those requests itself; the SDK only decides, by the app's policy in Kapai's dashboard, whether a round goes to
 * Kapai or to the key.
 */
import { KapaiBackend, anthropicOwnAI } from '../claude/kapai-backend.js';
import { ClaudeError } from '../claude/backend.js';

const SDK_URL = './kapai/kapai-sdk-0.1.0-e250ded4.mjs';
export const KAPAI_PUBLISHABLE_KEY = 'pk_test_YbDj7hDHpbv9jEjscNT1109m';
export const KAPAI_BASE_URL = 'https://api.stg.kap.ai';

// -> a KapaiBackend on a fresh client. keyStore: the page's key store (the own AI's key); openKeySettings: opens the
// key card.
export async function kapaiBackend({ keyStore, openKeySettings = () => {}, fetch = globalThis.fetch.bind(globalThis) }) {
  const sdk = await import(SDK_URL);
  const kapai = new sdk.Kapai({
    publishableKey: KAPAI_PUBLISHABLE_KEY,
    baseUrl: KAPAI_BASE_URL,
    appName: 'CLOADM',
    ownAI: sdk.KapaiOwnAI.appManaged({
      label: () => (keyStore.get() ? 'api.anthropic.com' : null),
      respond: anthropicOwnAI({ fetch, getKey: () => keyStore.get() || '' }),
      openSettings: openKeySettings,
    }),
  });
  return new KapaiBackend({ kapai, runTools: sdk.runTools });
}

// The same, synchronously: the chat is built at once (Session.startAsk / startChat), and the SDK loads on its first
// turn. runTool is ChatSession's (the consent gate), read at each send. -> an object with ClaudeBackend's contract
export function lazyKapaiBackend(opts) {
  let ready = null;
  const lazy = {
    runTool: null,
    get hasKey() { return true; },
    setKey() { if (ready) ready.then((b) => b.setKey(opts.keyStore.get() || '')).catch(() => {}); },
    async send(args) {
      if (!ready) ready = kapaiBackend(opts);
      let b;
      try { b = await ready; } catch (e) { ready = null; throw new ClaudeError('network', `Could not load the Kapai SDK: ${e.message}`); }
      b.runTool = lazy.runTool;
      return b.send(args);
    },
  };
  return lazy;
}
