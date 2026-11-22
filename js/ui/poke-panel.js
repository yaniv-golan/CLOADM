/* The SAM CPU rate (Machine tab: the rate and the SAM chip indicator) and the POKE book (POKEs tab), whose
   entries type themselves into BASIC (or into the stub, which carries out POKE lines). When the SAM rate changes,
   however it was typed, the SAM indicator lights and so does the chip line of every book entry that makes that
   change. The Turbo button is separate: it runs the emulation faster in real time and never
   touches the SAM. */
import { $ } from './page.js';

const LIT_MS = 1200;

export function setupPokePanel(page) {
  const { session } = page;
  const card = $('machineCard'), list = $('pokeBook'), chip = $('chipSam');
  let timer = null, rate = null;
  const light = (els) => {
    for (const el of [...list.querySelectorAll('small.lit'), chip]) el.classList.remove('lit');
    for (const el of els) el.classList.add('lit');
    clearTimeout(timer);
    timer = setTimeout(() => { for (const el of els) el.classList.remove('lit'); }, LIT_MS);
  };
  const showRate = (changed) => {
    const r = session.cpuRate();
    card.hidden = !r;
    $('turboNote').hidden = !r;
    $('pokeNone').hidden = !!r;
    $('pokeNone').textContent = session.personMachine.profile.family === 'coco3' ? "The CoCo 3's speed POKEs aren't in this book yet."
      : "This machine has no SAM, so the speed POKEs don't apply.";
    const before = rate;
    rate = r ? r.rate : null;
    if (!r) return;
    $('cpuRate').textContent = r.label;
    chip.title = `MC6883 SAM, rate bits R1 R0 = ${(r.rate >> 1) & 1}${r.rate & 1}`;
    if (!changed || before === null) return;
    // the entries whose rate bit just changed the way they change it
    const hits = session.pokeBook().map((p, i) => ('bit' in p && ((before ^ r.rate) >> p.bit) & 1 && !!((r.rate >> p.bit) & 1) === p.set ? i : -1))
      .filter((i) => i >= 0).map((i) => list.children[i].querySelector('small'));
    light([chip, ...hits]);
  };
  const showBook = () => {
    list.replaceChildren();
    session.pokeBook().forEach((p, i) => {
      const b = document.createElement('button');
      b.className = 'poke';
      b.disabled = !p.ready;
      b.dataset.poke = p.text;
      const t = document.createElement('code'); t.textContent = p.text;
      const a = document.createElement('span'); a.textContent = p.about;
      const c = document.createElement('small'); c.textContent = p.ready ? p.chip : `${p.chip} · needs the BASIC ROM`;
      b.append(t, a, c);
      // BASIC shows the typed line itself: no message ("on the machine")
      b.onclick = () => { page.attempt(() => { session.typePoke(i); }); page.focus(); };
      list.appendChild(b);
    });
  };
  session.on((ev) => {
    if (ev === 'machine' || ev === 'firmware') { showBook(); showRate(false); }
    if (ev === 'rate') showRate(true);
  });
}
