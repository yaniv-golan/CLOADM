/*
 * Embed mode (?embed=1): the page shows only the screen, and the page around the iframe drives
 * it through window.postMessage. js/embed-api.js answers the calls; embed/cloadm.js is the host side
 * (CLOADM.attach(iframe)). Only messages from the embedding page (window.parent) are taken.
 */
import { EmbedApi } from '../embed-api.js';

export function setupEmbed(page) {
  const { session } = page;
  document.body.classList.add('embed');
  const parent = window.parent !== window ? window.parent : null;
  const api = new EmbedApi(session, (msg) => { if (parent) parent.postMessage(msg, '*'); });
  window.addEventListener('message', (e) => { if (parent && e.source === parent) api.handle(e.data); });
  // a 'frame' event after each emulated frame (when the host watches them)
  let seen = session.machine.frameCount;
  const tick = () => {
    const f = session.machine.frameCount;
    if (f !== seen) { seen = f; api.frame(); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  if (parent) parent.postMessage({ cloadm: 1, event: 'ready', data: api.info() }, '*');
  window.emu.embed = api;
  return api;
}
