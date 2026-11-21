/*
 * The emulator page: a Session (js/session.js) driven by one module per panel.
 * URL parameters: js/config.js lists and checks them (machine and its options, start=welcome|liza for the
 * landing page's "Try it now" and "Talk to LIZA", media to load, rom=URL, display, input, embed=1, ...).
 * The page is served at /play/ with <base href="../">.
 */
import { Session } from '../session.js';
import * as Emu from '../emu.js';
import { profiles } from '../machines/profiles.js';
import { Audio } from '../host/audio.js';
import { localStore } from '../host/storage.js';
import { openChosenStore, availableChoices } from '../host/media-store-open.js';
import { loadFolder } from '../host/folder-handle.js';
import { MemoryMediaStore } from '../host/media-store-memory.js';
import { $, createPage, viewOpen, ESC } from './page.js';
import { setupScreen } from './screen.js';
import { setupTouchKeys } from './touch-keys.js';
import { setupMachinePanel } from './machine-panel.js';
import { setupRomPanel } from './rom-panel.js';
import { setupRomSockets } from './rom-sockets.js';
import { setupBootHelp } from './boot-help.js';
import { setupWelcome } from './welcome.js';
import { setupKeyHint } from './key-hint.js';
import { setupMediaPanel } from './media-panel.js';
import { setupDrives } from './drives.js';
import { setupAssemblerPanel } from './assembler-panel.js';
import { setupDebuggerPanel } from './debugger-panel.js';
import { setupSelfTestPanel } from './selftest-panel.js';
import { setupPokePanel } from './poke-panel.js';
import { setupDrawer } from './drawer.js';
import { setupLibrary } from './library.js';
import { setupTypein } from './typein.js';
import { setupMultiPakPanel } from './multipak-panel.js';
import { setupPrinterPanel } from './printer-panel.js';
import { setupSerialPanel } from './serial-panel.js';
import { setupDriveWirePanel } from './drivewire-panel.js';
import { setupDisplayPanel } from './display-panel.js';
import { setupSnapshotPanel } from './snapshot-panel.js';
import { parseUrlConfig, linkFetchError } from '../config.js';
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
// the Claude API key: this browser's storage only (cloadm.anthropicKey), never a Session setting
const keyStore = (() => { try { return localStorage ? storageKeyStore(localStorage) : new MemoryKeyStore(); } catch (e) { return new MemoryKeyStore(); } })();
// embedded (?embed=1): no welcome menu of its own; the embedding page drives a plain machine
const session = new Session({ store: settings, media: mediaStore, keyStore, welcomeMenu: !link.embed });
const page = createPage(session, new Audio());
// a background write that fails (full storage, permission refused) must reach the user, not vanish
session.index.writeError = (name, e) => page.status(session.indexWriteError(name, e), true);
// the handle exists before the awaited init, so anything watching the page sees it at once
window.emu = { session, profiles, Emu, feedback: page.feedback, ready: false, started: false, audio: page.audio, audioRunning: () => page.audio.running, get machine() { return session.machine; },
  // the input layer, for the browser check (keyboard modes, the keyboard joystick and the gamepads)
  get input() { return screen.input; }, readPads: () => screen.readPads() };
try {
  await session.ready();
} catch (e) {
  // a load or migration error: carry on with a fresh in-memory library for this visit (nothing is loaded,
  // so nothing retries the failed step, and the user is told the library will not persist)
  storageProblem = storageProblem || e;
  session.useMediaStore(new MemoryMediaStore());
}
window.emu.ready = true;
// a state that stays true for the visit: attention (orange, until dismissed), not a passing toast, so the welcome
// menu's own line can't replace it (and it needs no repeating once the visit has started)
if (storageProblem) page.feedback.attention(`Your stored files could not be opened (${storageProblem.message}). This visit keeps everything in memory only: download what you want to keep.`, { key: 'storage' });
// writes are best-effort until flush(): ask for them to settle before the page goes away, but do not
// pretend that holds the page open — a reload can still overtake the last write
// disks too: the drives hand what was written to the store
addEventListener('pagehide', () => { session.flushDisks(); session.index.flush().catch(() => {}); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { session.flushDisks(); session.index.flush().catch(() => {}); } });
window.emu.storageChoices = availableChoices();
const machinePanel = setupMachinePanel(page, { showRoms: () => romSockets.reveal() });
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
const selfTest = setupSelfTestPanel(page);
const screen = setupScreen(page, { loadPrograms: media.loadPrograms, roms: romPanel });
// ?touch=joystick|keys (js/config.js): the on-screen panel's mode for this visit, taken up when the machine
// arrives (the link's machine switches in below, after this)
page.linkTouch = link.touch;
page.touchKeys = setupTouchKeys(page, { input: screen.input });
setupDisplayPanel(page);
setupKeyHint(page);
setupSettingsFile(page);
setupShare(page);
const showRoms = () => romSockets.reveal();
const claude = setupClaude(page);
setupAsk(page, claude);
setupCommandBox(page, claude);
const welcome = setupWelcome(page, { showRoms, openClaude: () => claude.open() });
const drawer = setupDrawer(page, { showRoms });
const openRoms = () => { romSockets.reveal(); $('fileRom').click(); };
library = setupLibrary(page, { loadProgram: media.loadProgram, runShelf: welcome.runShelf, changed: slots.refresh, showRoms, reconnect });
setupTypein(page, { openRoms, isVisible: () => !$('library').hidden });
setupTapePanel(page);
setupMultiPakPanel(page, { cartridge: (name) => drawer.cartridge(name) });

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
// off, then put on if the links still run past the bar
{
  const bar = $('appbar'), nav = bar.querySelector('nav'), wide = matchMedia('(min-width: 1200px)');
  const fit = () => {
    bar.classList.remove('tight');
    if (wide.matches && nav.getBoundingClientRect().right > bar.getBoundingClientRect().right + 0.5) bar.classList.add('tight');
  };
  const ro = new ResizeObserver(fit);
  ro.observe(bar); ro.observe(nav);   // the links change width with the font
  if (document.fonts) document.fonts.ready.then(fit);
  session.on((ev) => { if (ev === 'machine') fit(); });
  fit();
}

// Esc closes the topmost surface that is open (page.onEscape: confirmations, menus, cards, the views, the chat)
//; on the screen only a confirmation or a card takes it, and otherwise it is the machine's BREAK; a control
// that took it first (it prevents the default) and an open <dialog> (the browser closes it) keep it
page.onEscape(ESC.view, viewOpen, () => page.closeView());
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
  if (page.escape(e.target === $('screen'))) e.preventDefault();
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
  // media: fetched (the server must allow CORS), then as if dropped; a tape without autorun just goes in the deck
  for (const { kind, url } of link.media) {
    const name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop()) || kind;
    try {
      const bytes = await page.fetchBytes(url);
      if (kind === 'tape' && !link.autorun) page.attempt(() => session.insertTape(name, bytes));
      else { await media.loadProgram(name, bytes); if (kind === 'cart') drawer.cartridge(name); }
    } catch (e) { page.status(`Could not load ${kind}=${url}: ${linkFetchError(e)}`, true); }
  }
  await starting;
  // a share link's moment (#s=, Share screen): opened like a dropped snapshot, once the visit has started
  if (location.hash.startsWith('#s=')) await snapshots.takeLink(location.hash);
  // ?nitros9=: NitrOS-9 boots from the user's own DriveWire image (never one in the link)
  if (link.nitros9) await nitros9.fromLink(link.nitros9);
  // ?app=claude: the chat opens once the link's ROMs are in (the BASIC session kept beside it uses them)
  if (link.app === 'claude') await claude.open();
  // started: the visit's program (welcome, LIZA) runs and the link's ROMs, media and moment are in (window.emu.ready:
  // storage is open); linkDone: the same moment, kept for the link checks
  window.emu.started = true;
  window.emu.linkDone = true;
  if (link.errors.length) page.status(`This link has settings CLOADM can't use: ${link.errors.join('; ')}`, true);
})();
