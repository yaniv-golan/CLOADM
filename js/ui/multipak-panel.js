/* The Multi-Pak in the cartridge port: four slots, each a cartridge image and its board, the front-panel switch,
 * and Insert, which puts the Multi-Pak in and starts the machine on the switch's slot (Session.insertMultiPak).
 * The section shows only on the machines it is verified on (Session.hasMultiPak: the profiles marked multiPak,
 * compared with MAME), so a Dragon 200 (whose Multi-Pak MAME does list, but which has no comparison here yet) and an
 * MC-10 (no cartridge port) are not offered it.
 * A slot's board menu also offers the machine's disk controllers (DragonDOS, Delta DOS; Disk BASIC): such a slot
 * needs no image, as the controller's ROM is the user's DOS ROM, and the drives card then uses that controller. */
import { $ } from './page.js';

export function setupMultiPakPanel(page, { cartridge }) {
  const { session } = page;
  const slots = [null, null, null, null];        // { name, bytes } per slot
  let picking = 0;
  const show = () => { $('mpak').hidden = !session.hasMultiPak; };
  // The slots are hidden while the section is closed, not only folded away by <details>, so a reader view working from
  // the markup (Chrome's reading mode, Readability) leaves them out too. A press on the summary unhides them before
  // the section draws open (toggle, a task later, would show an empty frame first); toggle covers any other way.
  {
    const mp = $('mpak'), inner = mp.querySelector('.mpSlots');
    mp.querySelector('summary').addEventListener('click', () => { inner.hidden = mp.open; });
    mp.addEventListener('toggle', () => { inner.hidden = !mp.open; });
    inner.hidden = !mp.open;
  }
  const dosOf = (n) => { const v = $(`selMpBoard${n}`).value; return v.startsWith('dos:') ? v.slice(4) : null; };
  const label = (n) => {
    const b = $(`btnMpSlot${n}`), dos = dosOf(n);
    const opt = dos && $(`selMpBoard${n}`).selectedOptions[0];
    b.disabled = !!dos;
    b.textContent = dos ? opt.dataset.name : slots[n - 1] ? slots[n - 1].name : 'Empty';
    b.title = dos ? 'A disk controller: its ROM is the disk ROM you added' : slots[n - 1] ? `${slots[n - 1].name}: click to choose another, Shift+click to empty` : 'Choose a cartridge image';
  };
  // the disk controllers this machine's family takes, in every slot's board menu
  const diskOptions = () => {
    const choices = session.diskDosChoices().filter((c) => !c.builtin);
    for (let n = 1; n <= 4; n++) {
      const sel = $(`selMpBoard${n}`), was = sel.value;
      for (const o of [...sel.options]) if (o.value.startsWith('dos:')) o.remove();
      for (const c of choices) {
        const o = document.createElement('option');
        o.value = `dos:${c.id}`;
        o.dataset.name = c.name.replace(/ cartridge$/, '');
        o.textContent = `Disk: ${o.dataset.name}${c.ready ? '' : ' (ROM needed)'}`;
        o.disabled = !c.ready;
        sel.append(o);
      }
      sel.value = [...sel.options].some((o) => o.value === was && !o.disabled) ? was : 'auto';
      label(n);
    }
  };
  for (let n = 1; n <= 4; n++) {
    $(`btnMpSlot${n}`).onclick = (e) => {
      if (e.shiftKey && slots[n - 1]) { slots[n - 1] = null; label(n); return; }
      picking = n; $('fileMpSlot').click();
    };
    $(`selMpBoard${n}`).onchange = () => label(n);
  }
  $('fileMpSlot').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f || !picking) return;
    slots[picking - 1] = { name: f.name, bytes: await page.readFile(f) };
    label(picking);
  };
  $('btnMpInsert').onclick = () => {
    const items = slots.map((s, i) => {
      const dos = dosOf(i + 1);
      if (dos) return { dos };
      return s ? { name: s.name, bytes: s.bytes, board: $(`selMpBoard${i + 1}`).value } : null;
    });
    page.attempt(() => {
      const msg = session.insertMultiPak(items, { switchSlot: Number($('selMpSwitch').value) });
      cartridge(null);                           // the button shows the device's name
      return msg;
    });
    page.focus();
  };
  session.on((ev) => { if (ev === 'machine') show(); if (ev === 'machine' || ev === 'roms') diskOptions(); });
  show();
  diskOptions();
}
