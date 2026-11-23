/*
 * The emulator page: a Session (js/session.js) driven by one module per panel.
 * URL parameters: js/config.js lists and checks them (machine and its options, start=welcome|liza for the
 * landing page's "Try it now" and "Talk to LIZA", media to load, rom=URL, display, input, embed=1, ...).
 * The page is served at /play/ with <base href="../">.
 */
import { Session, SSC_TEXT } from '../session.js';
import * as Emu from '../emu.js';
import { profiles } from '../machines/profiles.js';
import { Audio } from '../host/audio.js';
import { localStore } from '../host/storage.js';
import { openChosenStore, availableChoices } from '../host/media-store-open.js';
import { loadFolder } from '../host/folder-handle.js';
import { MemoryMediaStore } from '../host/media-store-memory.js';
import { $, createPage, viewOpen, ESC, markUndrawn } from './page.js';
import { setupScreen } from './screen.js';
import { setupTouchKeys } from './touch-keys.js';
import { setupMachinePanel } from './machine-panel.js';
import { setupRomPanel } from './rom-panel.js';
import { setupRomSockets } from './rom-sockets.js';
import { setupBootHelp } from './boot-help.js';
import { setupWelcome } from './welcome.js';
import { setupWyrmfire } from './wyrmfire.js';
import { setupKeyHint } from './key-hint.js';
import { setupMediaPanel } from './media-panel.js';
import { setupDrives } from './drives.js';
import { setupAssemblerPanel } from './assembler-panel.js';
import { setupDebuggerPanel } from './debugger-panel.js';
import { setupDebuggerStop } from './debugger-stop.js';
import { setupSelfTestPanel } from './selftest-panel.js';
import { setupPokePanel } from './poke-panel.js';
import { setupDrawer } from './drawer.js';
import { setupPhoneSheets } from './phone-sheets.js';
import { setupLibrary } from './library.js';
import { setupTypein } from './typein.js';
import { setupMultiPakPanel } from './multipak-panel.js';
import { setupPrinterPanel } from './printer-panel.js';
import { setupSerialPanel } from './serial-panel.js';
import { setupDriveWirePanel } from './drivewire-panel.js';
import { setupDisplayPanel } from './display-panel.js';
import { setupSnapshotPanel } from './snapshot-panel.js';
import { parseUrlConfig, linkFetchError, claudeOffered } from '../config.js';
import { setupAskPopout } from './ask-popout.js';
import { setupArmGuard } from './arm-guard.js';
import { setupEmbed } from './embed.js';
import { setupSettingsFile } from './settings-file.js';
import { setupClaude } from './claude.js';
import { setupAsk } from './ask.js';
import { setupCommandBox } from './command-box.js';
import { MemoryKeyStore, storageKeyStore } from '../host/key-store.js';
import { setupShare } from './share.js';
import { setupSlotsPanel } from './slots-panel.js';
import { setupTapePanel } from './tape-panel.js';
import { setupNitros9Panel } from './nitros9-panel.js';
import { setupInstall } from './install.js';

// Storage: small settings stay in localStorage; ROMs and recent programs live in the media store: where the
// user chose in the Library (settings 'storage': browser storage, a folder of theirs, or download and open; the
// folder's handle in IndexedDB), ?storage= for testing, or the best this browser offers. One awaited init.
// If opening or loading that store fails, the page still starts: it falls back to an in-memory library
// for this visit and says why, rather than leaving a dead page.
const settings = localStore();
const link = parseUrlConfig(location.search, settings.get('machine') || 'dragon64');
const choice = link.storage || settings.get('storage');
let mediaStore = null, storageProblem = null, reconnect = null;
try {
  ({ store: mediaStore, reconnect } = await openChosenStore(choice, choice === 'fsa' ? await loadFolder() : null));
} catch (e) {
  storageProblem = e;
  mediaStore = new MemoryMediaStore();
}
// Whether the Claude chat is offered here at all: a top-level page and no embed flag (js/config.js's claudeOffered).
// A framed page is someone else's page, and the chat's key card would be on it - that is why this is one decision used
// by both the key store and the controller, rather than the embed flag alone.
// "shown inside another page": window.self !== window.top. Reading it is a WindowProxy comparison, which does not throw
// even in a sandboxed frame (checked), but a page that cannot tell is treated as framed - the decision fails closed.
const framedInPage = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
const chatHere = claudeOffered(link, framedInPage);
// a page with no chat says so on <body>, so the stylesheet hides the buttons that would open one rather than leaving
// them on screen doing nothing (play/index.html hides #btnAsk, #navCommands, #claude, #ask, #askRail under this)
if (!chatHere) document.body.classList.add('no-claude');
// the Claude API key: this browser's storage only (cloadm.anthropicKey), never a Session setting.
// Where the chat is not offered, the store is in memory, never the saved one: nothing on that page may reach a key
// left in this browser (the chat is not set up there either, but the store is the second lock - a future route that
// reads keyStore.get() finds nothing).
const keyStore = chatHere ? (() => { try { return localStorage ? storageKeyStore(localStorage) : new MemoryKeyStore(); } catch (e) { return new MemoryKeyStore(); } })()
  : new MemoryKeyStore();
// embedded (?embed=1): no welcome menu of its own; the embedding page drives a plain machine
// other tabs of this origin on the same store: one lock for the media index's lists, and a channel to say what changed
const mediaShare = {
  locks: (typeof navigator !== 'undefined' && navigator.locks) || null,
  channel: typeof BroadcastChannel === 'function' ? new BroadcastChannel('cloadm-media') : null,
};
const session = new Session({ store: settings, media: mediaStore, keyStore, welcomeMenu: !link.embed, mediaShare });
const page = createPage(session, new Audio());
// a background write that fails (full storage, permission refused) must reach the user, not vanish
session.index.writeError = (name, e) => page.status(session.library.indexWriteError(name, e), true);
// the handle exists before the awaited init, so anything watching the page sees it at once
window.emu = { session, profiles, Emu, feedback: page.feedback, ready: false, started: false, audio: page.audio, audioRunning: () => page.audio.running, get machine() { return session.shownMachine; },
  // the input layer, for the browser check (keyboard modes, the keyboard joystick and the gamepads)
  get input() { return screen.input; }, readPads: () => screen.readPads(),
  // what the screen presented last, as RGBA (both presenters keep it), for the browser check's "the canvas shows
  // the machine's current frame" (onScreenChecks)
  presented: () => screen.presented() };
try {
  await session.ready();
} catch (e) {
  // a load or migration error: carry on with a fresh in-memory library for this visit (nothing is loaded,
  // so nothing retries the failed step, and the user is told the library will not persist)
  storageProblem = storageProblem || e;
  session.library.useMediaStore(new MemoryMediaStore());
}
window.emu.ready = true;
// a state that stays true for the visit: attention (orange, until dismissed), not a passing toast, so the welcome
// menu's own line can't replace it (and it needs no repeating once the visit has started)
if (storageProblem) page.feedback.attention(`Your stored files could not be opened (${storageProblem.message}). This visit keeps everything in memory only: download what you want to keep.`, { key: 'storage' });
// writes are best-effort until flush(): ask for them to settle before the page goes away, but do not
// pretend that holds the page open — a reload can still overtake the last write
// disks too: the drives hand what was written to the store
addEventListener('pagehide', () => { session.drives.flush(); session.index.flush().catch(() => {}); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { session.drives.flush(); session.index.flush().catch(() => {}); } });
window.emu.storageChoices = availableChoices();
const machinePanel = setupMachinePanel(page, { showRoms: () => romSockets.reveal() });
// WYRMFIRE (js/ui/wyrmfire.js): the shelf, the palette and ?start=wyrmfire start it through page.wyrmfire
page.wyrmfire = setupWyrmfire(page, { confirmSwitch: machinePanel.confirmSwitch });
setupPokePanel(page);
setupPrinterPanel(page);
setupSerialPanel(page);
setupDriveWirePanel(page);
const romPanel = setupRomPanel(page);
const romSockets = setupRomSockets(page, romPanel, { confirmSwitch: machinePanel.confirmSwitch });
setupBootHelp(page, romSockets);
let library = null;
const snapshots = setupSnapshotPanel(page, { confirmSwitch: machinePanel.confirmSwitch, openRoms: () => romSockets.reveal() });
const disks = setupDrives(page, { openRoms: () => romSockets.reveal({ to: 'disk' }) });
const slots = setupSlotsPanel(page, { snapshots });
const nitros9 = setupNitros9Panel(page);
window.emu.nitros9Shown = () => nitros9.shown();   // (the browser check: the panel shows the session's latest state)
const media = setupMediaPanel(page, { snapshots, disks, nitros9, keep: (name, bytes) => library && library.keep(name, bytes) });
setupAssemblerPanel(page);
setupDebuggerPanel(page);
setupDebuggerStop(page);
const selfTest = setupSelfTestPanel(page);
const screen = setupScreen(page, { loadPrograms: media.loadPrograms, roms: romPanel });
// ?touch=joystick|keys (js/config.js): the on-screen panel's mode for this visit, taken up when the machine
// arrives (the link's machine switches in below, after this)
page.linkTouch = link.touch;
page.touchKeys = setupTouchKeys(page, { input: screen.input });
setupDisplayPanel(page);
setupKeyHint(page);
setupSettingsFile(page);
const share = setupShare(page);
const showRoms = () => romSockets.reveal();
// No Claude chat on a page shown inside someone else's page, whether by the embed flag or by being framed: the chat
// would put its API key card there. With no controller there is no chat machine, no panel and no key card, and the
// routes that open one (?app=claude, the Ask panel, the command box, a keypress) have nothing to reach.
const claude = chatHere ? setupClaude(page) : null;
// set up only when there is a controller: both modules drive the chat and would throw on null
const ask = claude ? setupAsk(page, claude) : null;
if (claude) setupCommandBox(page, claude, machinePanel);
// the controls that hand Claude a key or a say over the machine take no press for their card's first moments on screen
if (claude) {
  const card = (label, id, ...controls) => ({ label, card: $(id), controls: controls.map((c) => $(c)) });
  const said = $('armAnnounce');
  window.emu.armGuard = setupArmGuard([
    card('Claude asks to use the emulator: Allow is ready.', 'askConsent', 'btnAskAllow'),
    card('Claude asks to use the emulator: Allow is ready.', 'claudeConsentAsk', 'btnClaudeAllow'),
    card('API key form ready.', 'askKeyForm', 'btnAskKeySave'), card('API key form ready.', 'claudeKeyCard', 'btnClaudeKeySave'),
    card('Claude settings ready.', 'askComposer', 'chkAskMachine', 'btnAskKeyForget'), card('Claude settings ready.', 'claudeKeySaved', 'btnClaudeKeyForget'),
    card('Claude settings ready.', 'claudeSession', 'chkClaudeTools'),
  ], { announce: (text) => { said.textContent = ''; requestAnimationFrame(() => { said.textContent = text; }); } });
}
// where there is no chat because this page is inside another site's page: "Ask Claude ↗" opens it in a new tab
// (the framed full page's app bar; an embed's corner chip only with askclaude=1)
window.emu.askPopout = claude ? null : setupAskPopout(page, { link, framed: framedInPage });
const welcome = setupWelcome(page, { showRoms, openClaude: () => claude && claude.open() });
const drawer = setupDrawer(page, { showRoms });
// a phone: the ports and power in sheets, one row of chips under the on-screen panel
page.sheets = setupPhoneSheets(page, { touchKeys: page.touchKeys, ask });
const openRoms = () => { romSockets.reveal(); $('fileRom').click(); };
// a program spoke on the Speech/Sound Pak with no speech ROM: once a session (Session.checkSpeechRom), with the way in
session.on((ev) => { if (ev === 'speech-rom') page.toast(SSC_TEXT.speechNoRom, { action: { label: 'Add ROMs', run: () => romSockets.reveal() } }); });
library = setupLibrary(page, { loadProgram: media.loadProgram, runShelf: welcome.runShelf, changed: slots.refresh, showRoms, reconnect, diskSaid: disks.said });
setupTypein(page, { openRoms, isVisible: () => !$('library').hidden });
setupTapePanel(page);
setupMultiPakPanel(page, { cartridge: (name) => drawer.cartridge(name) });
// a view the page opened on (play/#library) has hidden the emulator: mark it so (page.js keeps it so from now on)
markUndrawn();

// the cartridge slot under the screen
$('fileCart').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const bytes = await page.readFile(f);
  media.loadProgram(f.name, bytes);
  drawer.cartridge(f.name);
};
// phone: the header's other links behind Menu
$('btnMenu').onclick = () => {
  const open = $('appbar').classList.toggle('menu-open');
  $('btnMenu').setAttribute('aria-expanded', String(open));
  // a disclosure: it opens with the focus on its first item (Esc gives it back to Menu), so Tab goes down the list
  // (the folded links are inert until drawn: markUndrawn now, not on the class change's mutation, so the focus can land)
  if (open) { markUndrawn(); const first = [...document.querySelectorAll('.appbar nav > :is(a, button)')].find((e) => e.checkVisibility()); if (first) first.focus(); }
};
// Open only where it shows: .menu-open matters only while Menu and the links behind it are on the page (the phone and
// short-landscape layouts); the touch keys' "Machine menu" sets it at any width, and a class left over there must not
// take the screen's Esc, which is the machine's BREAK
{
  const bar = $('appbar'), nav = bar.querySelector('nav'), menuBtn = $('btnMenu');
  const navOpen = () => bar.classList.contains('menu-open') && menuBtn.checkVisibility() && nav.checkVisibility();
  const closeNav = (refocus) => { bar.classList.remove('menu-open'); menuBtn.setAttribute('aria-expanded', 'false'); if (refocus) menuBtn.focus(); };
  page.onEscape(ESC.menu, navOpen, () => closeNav(true));
  page.outsidePress(navOpen, (t) => nav.contains(t) || menuBtn.contains(t) || $('btnShare').contains(t), closeNav);
}

// the one-row app bar (1200 px and up, play/index.html) when its items do not all fit, in a wide fallback font: the key
// hints and the machine's RAM size give way (class "tight") before anything wraps. Measured, not guessed: it is taken
// off, then put on if the links still run past the bar or leave the status (the speed, the one flexible item) no room
// to be whole. The speed is then shown whole or, only if tight still leaves it no room, not at all (class "nostatus";
// the v0.1.8 review's m4), never cut to an ellipsis stub
{
  const bar = $('appbar'), nav = bar.querySelector('nav'), status = $('status'), wide = matchMedia('(min-width: 1200px)');
  const over = () => nav.getBoundingClientRect().right > bar.getBoundingClientRect().right + 0.5;
  const cut = () => status.scrollWidth > status.clientWidth + 0.5;
  const fit = () => {
    bar.classList.remove('tight', 'nostatus');
    if (!wide.matches) return;
    // the links go tight first, for the links or for the speed; only a speed that still cannot be whole goes
    if (over() || cut()) bar.classList.add('tight');
    if (cut()) bar.classList.add('nostatus');
  };
  const ro = new ResizeObserver(fit);
  ro.observe(bar); ro.observe(nav);   // the links change width with the font
  // (the speed's text changes as it runs: whether it fits is asked again then)
  new MutationObserver(fit).observe(status, { childList: true, characterData: true, subtree: true });
  if (document.fonts) document.fonts.ready.then(fit);
  session.on((ev) => { if (ev === 'machine') fit(); });
  fit();
}
// the phone's app bar (700 px and less, play/index.html): Add ROMs is Menu's first item while the app bar's pill is
// up (the machine has no BASIC), and Menu wears a dot then, as the item does; Settings… and Share are its items too
// (the bar has no room)
{
  const pill = $('romPill'), item = $('navRoms');
  // (the dot is drawn only: while it is on, Menu's name says what it means)
  // (and an accent dot while media is in, on a short phone where Menu has the ports: js/ui/phone-sheets.js)
  const sync = () => {
    item.hidden = pill.hidden;
    const menu = $('btnMenu'), media = menu.classList.contains('media');
    menu.classList.toggle('dot', !pill.hidden);
    // (both: its one dot is the ROMs', its name says both)
    if (!pill.hidden) menu.setAttribute('aria-label', media ? 'Menu (ROMs needed, media inserted)' : 'Menu (ROMs needed)');
    else if (media) menu.setAttribute('aria-label', 'Menu (media inserted)');
    else menu.removeAttribute('aria-label');
  };
  page.syncMenu = sync;
  const close = () => { $('appbar').classList.remove('menu-open'); $('btnMenu').setAttribute('aria-expanded', 'false'); };
  item.onclick = () => { close(); pill.click(); };
  $('navShare').onclick = () => { close(); $('btnShare').click(); };
  // Settings…: with the touch keys, the Settings sheet on the tab last used (js/ui/phone-sheets.js); elsewhere the
  // drawer's tabs, far below the screen in a narrow window, brought into view on Display (a person looking for
  // "settings" is most often after the picture: its look, its size, the colours)
  $('navSettings').onclick = () => {
    close();
    if (page.openSettings(null, $('btnMenu'))) return;   // (the focus back on Menu when it closes)
    const tab = $('tab-display');
    tab.click();
    tab.closest('[role="tablist"]').scrollIntoView({ block: 'start' });
    tab.focus({ preventScroll: true });
  };
  new MutationObserver(sync).observe(pill, { attributes: true, attributeFilter: ['hidden'] });
  sync();
  // Menu's order on a phone: Install… after Share…, before the links; on a wider page it is the app bar's last link
  // (moved, not reordered by the stylesheet, so the focus goes down the list in the order it is drawn)
  const narrow = matchMedia('(max-width: 700px)');
  const installPlace = () => { if (narrow.matches) $('navShare').after($('navInstall')); else $('navInstall').closest('nav').append($('navInstall')); };
  narrow.addEventListener('change', installPlace);
  installPlace();
}

// Esc closes the topmost surface that is open (page.onEscape: confirmations, menus, cards, the views, the chat)
//; on the screen only a confirmation or a card takes it, and otherwise it is the machine's BREAK; a control
// that took it first (it prevents the default) and an open <dialog> (the browser closes it) keep it. A phone's
// sheet is a dialog whose Esc is the page's own: what is open over it (a menu, a card) closes first, then the sheet
page.onEscape(ESC.view, viewOpen, () => page.closeView());
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const dialog = document.querySelector('dialog[open]');
  if (dialog && !dialog.classList.contains('sheet')) return;
  if (page.escape(!dialog && e.target === $('screen'))) e.preventDefault();
});

const visit = session.visit();
// the link's configuration (js/config.js): the machine and its options, display, input, then ROMs and media
{
  const id = link.machine || session.startMachine;
  const config = link.config;
  // welcome.start, below, decides what the machine runs first, so this switch asks for no menu of its own
  session.switchMachine(id, Object.keys(config).length ? Object.assign(session.savedConfig(id), config) : undefined, { menu: false });
}
if (Object.keys(link.display).length) session.setDisplay(link.display, { remember: false });
const setCheck = (id, on) => { const c = $(id); if (c.checked !== on) { c.checked = on; c.dispatchEvent(new Event('change')); } };
if (link.joy) setCheck('chkJoy', link.joy === 'mouse');
if (link.sound !== null) setCheck('chkSound', link.sound);
if (link.fastTape !== null) setCheck('chkFastTape', link.fastTape);
if (link.turbo !== null && link.turbo !== session.turbo) $('btnTurbo').click();
if (link.embed) setupEmbed(page);
// offline use (sw.js, at the site root so it serves / and /play/); not from inside someone else's page
else if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href, { scope: new URL('./', document.baseURI).href })
    .catch((e) => console.warn(`Offline use is not available: ${e.message}`));
}
// the Menu's "Install CLOADM…" and the offer card (over a running program, once a visit); the steps stand in for the
// browser's prompt wherever it has none. In an embed there is no Menu and no offer.
window.emu.install = link.embed ? null : setupInstall(page, { started: () => window.emu.started, machineMenu: machinePanel });
const fromLink = !!link.machine || link.roms.length > 0 || link.media.length > 0 || !!link.app || !!link.nitros9;
// ROMs, media, an app (?app=claude) or NitrOS-9 (?nitros9=) decide what runs first, not the welcome menu
const starting = welcome.start(visit, { fromLink, withMedia: link.roms.length > 0 || link.media.length > 0 || !!link.app || !!link.nitros9, program: link.start });
(async () => {
  if (link.roms.length) {
    try { await romPanel.loadRomUrls(link.roms); if (link.selftest) selfTest.run(); }
    catch (e) { page.status(`Could not load ROM from URL: ${e.message}`, true); }
  }
  // media: fetched (the server must allow CORS), then as if dropped; a tape without autorun just goes in the deck, a
  // disk into the first free drive (parseUrlConfig puts disks first, so a program the link loads finds its disk in)
  for (const { kind, url } of link.media) {
    const name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop()) || kind;
    try {
      const bytes = await page.fetchBytes(url);
      if (kind === 'tape' && !link.autorun) page.insertTape(name, bytes);
      else if (kind === 'disk') await disks.insert(name, bytes);
      else { await media.loadProgram(name, bytes); if (kind === 'cart') drawer.cartridge(name); }
    } catch (e) { page.status(`Could not load ${kind}=${url}: ${linkFetchError(e)}`, true); }
  }
  await starting;
  // a share link's moment (#s=, Share screen): opened like a dropped snapshot, once the visit has started
  if (location.hash.startsWith('#s=')) await snapshots.takeLink(location.hash);
  // ?nitros9=: NitrOS-9 boots from the user's own DriveWire image (never one in the link)
  if (link.nitros9) await nitros9.fromLink(link.nitros9);
  // ?app=claude: the chat opens once the link's ROMs are in (the BASIC session kept beside it uses them). Not in an
  // embed: there is no controller there (link.embed, above), and the link's app is refused rather than opened.
  if (link.app === 'claude' && claude) await claude.open();
  // started: the visit's program (welcome, LIZA) runs and the link's ROMs, media and moment are in (window.emu.ready:
  // storage is open); linkDone: the same moment, kept for the link checks
  window.emu.started = true;
  share.ready();
  window.emu.linkDone = true;
  if (link.errors.length) page.status(`This link has ${link.errors.length === 1 ? 'a setting' : 'settings'} CLOADM can't use: ${link.errors.join('; ')}`, true);
  // "#share=…" (a share link's moment follows #s=): not one the page reads, and it said nothing
  else if (/^#share./.test(location.hash)) { page.status("This share link couldn't be read.", true); history.replaceState(null, '', location.pathname + location.search); }
})();
