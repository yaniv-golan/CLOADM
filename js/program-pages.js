/*
 * The program pages: cloadm.dev/<id>/, one per program in this list, each with its own link preview (title,
 * description and a 1200 x 630 card) and a Play button for /play/?start=<id> (its start link), where the visitor is
 * also sent at once. One entry here is a page: tools/program-cards.js writes <id>/index.html and img/card-<id>.png
 * from it, tools/pwa-files.js keeps them for offline use, and Session.programPageUrl links to it. `id` must be a start
 * the page has (js/config.js STARTS).
 *
 * `card` says how the card's picture is made, on the built-in firmware (no ROM, so no ROM pixel): the machine, then
 * either `lines` typed into the program (LIZA) or `keys` pressed in a game (its random numbers seeded with `seed`),
 * `frames` apart.
 */
export const PROGRAM_PAGES = Object.freeze([
  Object.freeze({
    id: '2048',
    title: '2048 on a Dragon 64, CLOADM',
    name: '2048',
    description: 'Slide the tiles and join the numbers to make 2048, on an emulated Dragon 64 in your browser. Nothing to install.',
    card: Object.freeze({ machine: 'dragon64', seed: 0x1234, frames: 45, keys: Object.freeze(['space', 'left', 'up', 'left', 'down', 'right', 'up', 'left', 'up']) }),
  }),
  Object.freeze({
    id: 'liza',
    title: 'LIZA, a 1980s chatbot on a Dragon 64, CLOADM',
    name: 'LIZA',
    description: 'Talk to LIZA, a small chatbot in 6809 code, on an emulated Dragon 64 in your browser. Nothing to install.',
    card: Object.freeze({ machine: 'dragon64', frames: 240, lines: Object.freeze(['I MISS MY DRAGON', 'BECAUSE IT WAS MAGIC']) }),
  }),
  Object.freeze({
    id: 'minesweeper',
    title: 'Minesweeper on a Dragon 64, CLOADM',
    name: 'Minesweeper',
    description: 'Clear the minefield without stepping on a mine, on an emulated Dragon 64 in your browser. Nothing to install.',
    card: Object.freeze({ machine: 'dragon64', seed: 0x1234, frames: 45,
      keys: Object.freeze(['space', 'right', 'right', 'down', 'down', 'space', 'right', 'right', 'right', 'down', 'space', 'left', 'down', 'down', 'space']) }),
  }),
]);

export const programPage = (id) => PROGRAM_PAGES.find((p) => p.id === id) || null;
