/*
 * The assembler panel: edit, assemble, run and save 6809 / 6803 source for the current machine.
 * INCLUDE reads from examples/ (the 6803 LIZA source pulls in the shared conversation data), so the
 * sources here keep the same one-copy-of-the-words arrangement the examples use. Nested includes are
 * loaded too (js/media/includes.js), so an included file may include another.
 */
import { assemble, toBinary } from '../asm/assembler.js';
import { loadIncludes, describeError } from '../media/includes.js';
import { hex } from '../util.js';
import { exampleReader } from '../host/example-reader.js';
import { $ } from './page.js';

export function setupAssemblerPanel(page) {
  const { session, audio } = page;
  let lastAsm = null;
  const message = (text, cls = '') => { const o = $('asmOut'); o.textContent = text; o.className = cls; };

  // INCLUDE "file" in a source read into the panel: the file comes from examples/, recursively. The
  // assembler is synchronous, so everything it names is fetched first and handed to it as text.
  const fetchInclude = exampleReader();
  async function assembleSource() {
    const src = $('asmSource').value;
    const include = await loadIncludes(src, fetchInclude);
    const t0 = performance.now();
    const res = assemble(src, session.personMachine.config.cpu, { include });
    const ms = (performance.now() - t0).toFixed(1);
    if (!res.ok) {
      // inline under the source, one row per error; an error in this source links to its line (one in an
      // included file names the file)
      const o = $('asmOut');
      o.className = 'error';
      o.replaceChildren(...res.errors.map((e) => {
        const row = document.createElement('div');
        row.className = 'asm-err';
        if (e.file) row.append(`${describeError(e)}`);
        else {
          const a = document.createElement('button');
          a.className = 'linkish'; a.textContent = `line ${e.line}`; a.dataset.line = e.line;
          a.title = 'Show this line in the source';
          a.onclick = () => goToLine(e.line);
          row.append(a, `: ${e.message}`);
        }
        row.append(`\n    ${e.src.trim()}`);
        return row;
      }));
      lastAsm = null;
      return null;
    }
    const size = res.segments.reduce((n, sg) => n + sg.data.length, 0);
    const ranges = res.segments.map((s) => `${hex(s.addr)}-${hex((s.addr + s.data.length - 1) & 0xFFFF)}`).join(', ');
    message(`Assembled ${src.split('\n').length} lines in ${ms} ms: ${size} bytes, ${ranges}, exec ${hex(res.exec)}, ${res.symbols.size} symbols.`, 'ok');
    lastAsm = res;
    return res;
  }
  // select line n of the source and scroll it into view
  function goToLine(n) {
    const ta = $('asmSource'), lines = ta.value.split('\n');
    const start = lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(start, start + (lines[n - 1] || '').length);
    ta.scrollTop = Math.max(0, (n - 4) * parseFloat(getComputedStyle(ta).lineHeight || '20'));
  }
  async function openExampleSource(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      $('asmSource').value = await res.text();
      $('asmName').textContent = url.split('/').pop();
      message('');
    } catch (e) { message(`Could not fetch ${url}: ${e.message}`, 'error'); }
  }

  // LIZA has a build per CPU, and the 6803 source needs the shared data file it includes
  $('btnAsmLiza').onclick = () => openExampleSource(session.personMachine.config.cpu === '6803' ? 'examples/liza6803.asm' : 'examples/liza.asm');
  $('btnAsmOpen').onclick = () => $('fileAsm').click();
  $('fileAsm').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    $('asmSource').value = await f.text();
    $('asmName').textContent = f.name;
  };
  $('btnAsmRun').onclick = async () => {
    const res = await assembleSource();
    if (!res) return;
    audio.start();
    page.status(session.runAssembled(res));
    page.focus();
  };
  $('btnAsmSave').onclick = async () => {
    const res = lastAsm || await assembleSource();
    if (!res) return;
    const name = ($('asmName').textContent || 'program.asm').replace(/\.[^.]*$/, '') + '.bin';
    page.download(name, toBinary(res));
    page.toast(`Saved ${name}`);
  };
}
