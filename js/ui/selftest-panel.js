/* The ROM self-test card: runs js/selftest.js on the current machine's ROMs and shows the report. */
import { SelfTest } from '../selftest.js';
import { $ } from './page.js';

export function setupSelfTestPanel(page) {
  const { session } = page;
  let running = false;
  async function run() {
    const m = session.machine;
    if (running) return;
    if (!m.hasRom) { page.status(`Load the ${m.profile.name} ROMs first (ROMs… or ?rom=URL), then run the self-test.`, true); return; }
    running = true;
    const card = $('selftestCard'), out = $('selftestOut');
    card.hidden = false;
    out.textContent = 'Running…\n';
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const t = new SelfTest(m.id, m.roms, (line) => { out.textContent += line + '\n'; }, m.config);
    try { await t.runAll(); out.textContent = t.report(); }
    catch (e) { out.textContent += 'self-test crashed: ' + e.message; }
    page.status(`ROM self-test: ${t.results.filter((r) => r.pass).length}/${t.results.length} passed`);
    running = false;
  }
  $('btnSelfTest').onclick = run;
  $('btnCopyReport').onclick = async () => {
    try { await navigator.clipboard.writeText($('selftestOut').textContent); page.status('Report copied to clipboard'); }
    catch (e) { page.status('Copy failed; select the report text manually', true); }
  };
  return { run };
}
