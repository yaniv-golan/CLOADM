/*
 * "This program needs BASIC" (the Session's detector: js/needs-basic.js). A program the person loaded called BASIC
 * on a machine without its ROM, and the screen fills with junk: the attention card, docked at the bottom of the tube
 * in the boot help's slot, says why. The machine keeps running under it.
 *   <file> needs the <machine>'s BASIC ROM, which isn't added yet.
 *   It tried to use BASIC, and there's nothing there yet, so the screen fills with junk.   [Add ROMs] [Dismiss]
 *   Details: It called $A176, in the BASIC ROM's space, at frame N.
 * Once the machine's ROMs are added it becomes "ROMs added." with [Run <file> again with ROMs] [Not now]: the button
 * switches the machine off and on with them and loads the same file again (Session.runAgainWithRoms). Dismissed
 * before the ROMs came, a toast makes that offer instead.
 * One attention card at a time on the tube and beside it, in this order: this card, the boot help ("didn't start"),
 * the no-ROM card (#welcome). The page shows the first that wants to show (body classes, play/index.html).
 */
import { $ } from './page.js';
import { needsBasicText } from '../needs-basic.js';

export function setupNeedsBasic(page, sockets) {
  const { session } = page;
  const box = $('needsBasic');
  let found = null;          // what the Session found (or null)
  let dismissed = false;     // the person dismissed this finding's card
  let offered = false;       // "ROMs added" was offered for this finding (on the card, or in a toast)
  const ready = () => !!found && session.machineRoms(found.id).bootable;
  function render() {
    const show = !!found && !dismissed;
    if (show) {
      const after = ready(), t = needsBasicText(found);
      box.dataset.state = after ? 'ready' : 'needs';
      $('needsBasicLead').textContent = after ? 'ROMs added.' : t.lead;
      $('needsBasicBody').textContent = t.body;
      $('needsBasicDetails').textContent = t.details;
      $('needsBasicMore').hidden = after;
      $('btnNeedsRoms').hidden = after;
      $('btnNeedsDismiss').textContent = after ? 'Not now' : 'Dismiss';
      $('btnNeedsAgain').hidden = !after;
      $('btnNeedsAgain').textContent = `Run ${found.file} again with ROMs`;
    }
    box.hidden = !show;
  }
  function runAgain() {
    if (page.attempt(() => session.runAgainWithRoms())) page.focus();
  }
  session.on((ev, arg) => {
    if (ev === 'needs-basic') { found = arg; dismissed = false; offered = false; render(); return; }
    // ROMs added for the machine whose program needed them: the card offers the run again, or a toast does when
    // the card was dismissed (once)
    if (ev === 'roms' && found && ready() && !offered) {
      offered = true;
      // (on the emulator, after what the drop itself says: the ROMs are usually added on the Add ROMs screen, and
      // the toast waits for the way back)
      if (dismissed) setTimeout(() => { if (found && ready()) page.toast('ROMs added.', { view: 'emulator', action: { label: `Run ${found.file} again with ROMs`, run: runAgain } }); });
      render();
    }
  });
  $('btnNeedsRoms').onclick = () => sockets.reveal();
  $('btnNeedsDismiss').onclick = () => { dismissed = true; render(); page.focus(); };
  $('btnNeedsAgain').onclick = runAgain;
  render();
}
