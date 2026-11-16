/* Settings as a file: Export saves them (never ROMs or programs: Session.exportSettings),
   Import reads such a file back and reloads the page so every panel takes them up. */
import { $ } from './page.js';

export function setupSettingsFile(page) {
  const { session } = page;
  $('btnSettingsExport').onclick = () => {
    const text = JSON.stringify(session.exportSettings(), null, 2);
    page.download('cloadm-settings.json', new TextEncoder().encode(text), 'application/json');
    page.status('Saved cloadm-settings.json: your settings, without ROMs or programs.');
  };
  $('btnSettingsImport').onclick = () => $('fileSettings').click();
  $('fileSettings').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const text = new TextDecoder().decode(await page.readFile(f));
    page.attempt(() => {
      const r = session.importSettings(text);
      setTimeout(() => location.reload(), 600);
      return `Imported ${r.applied.length} setting(s)${r.ignored.length ? `, ignored ${r.ignored.length} (ROMs and programs never come in this way)` : ''}. Reloading…`;
    });
  };
}
