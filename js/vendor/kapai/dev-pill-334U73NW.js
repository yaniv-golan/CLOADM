// src/ui/dev-pill.ts
var CSS = `
:host { position: fixed; right: max(12px, env(safe-area-inset-right)); bottom: max(12px, env(safe-area-inset-bottom)); z-index: 2147482000;
  display: inline-flex; align-items: center; height: 28px; border-radius: 14px; background: #151515; color: #fff;
  font: 500 12px/16px system-ui, sans-serif; box-shadow: 0 4px 12px rgb(0 0 0 / 0.25); }
button { height: 28px; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.open { padding: 0 6px 0 12px; border-radius: 14px 0 0 14px; white-space: nowrap; }
.open::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: #e9ff45; }
.close { width: 28px; padding: 0; border-radius: 0 14px 14px 0; font-size: 16px; opacity: 0.7; }
.close:hover { opacity: 1; }
button:focus-visible { outline: 2px solid #e9ff45; outline-offset: -2px; }
`;
var NAME = "kapai-dev-pill";
function defineKapaiDevPill(registry = globalThis.customElements, name = NAME) {
  if (!registry || registry.get(name)) return;
  registry.define(
    name,
    class KapaiDevPillElement extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" }).innerHTML = `<style>${CSS}</style><button type="button" class="open">Kapai dev \xB7 Test device</button><button type="button" class="close" aria-label="Hide the Kapai dev pill">\xD7</button>`;
      }
    }
  );
}
var hidden = false;
function showDevPill(client) {
  const doc = globalThis.document;
  if (hidden || typeof doc?.createElement !== "function" || !globalThis.customElements) return;
  if (!doc.body) {
    doc.addEventListener("DOMContentLoaded", () => showDevPill(client), { once: true });
    return;
  }
  if (doc.querySelector(NAME)) return;
  defineKapaiDevPill();
  const pill = doc.createElement(NAME);
  const root = pill.shadowRoot;
  const stop = client.on("entitlement", (entitlement) => {
    if (entitlement.testDevice != null) return;
    pill.remove();
    stop();
  });
  root.querySelector(".open").addEventListener("click", () => {
    client.developer().catch((err) => console.warn("Kapai: the developer page did not open.", err instanceof Error ? err.message : err));
  });
  root.querySelector(".close").addEventListener("click", () => {
    hidden = true;
    pill.remove();
    stop();
  });
  doc.body.append(pill);
}
export {
  defineKapaiDevPill,
  showDevPill
};
