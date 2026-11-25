# Clean-room BASIC for the Dragon 64 (P2: graphics and sound)

[CLOADM](../README.md) › [Clean-room BASIC](clean-room-basic.md) › P2

The second phase of the clean-room Dragon 64 BASIC: the graphics statements and functions, sound and the
joysticks. The rules, the build, the memory map, the test harness and the black-box comparison of
[P1](clean-room-basic.md) all still apply; this document only adds to them. Every behaviour fact carries its source
tag and is logged in [section 15](#15-provenance-log).

## 1. Clean-room rules (additions to P1, section 1)

* **Still never seen:** any BASIC ROM, its bytes, a disassembly or a listing; `js/media/basic.js`,
  `tests/fixtures/basic-standin.js` and `tools/mame-diff/**` (their firmware is not BASIC, but nobody on this work
  opens them for it). Nobody describes the original ROM's routines, tables, addresses or algorithms from memory,
  including the graphics and sound routines: how the original draws a circle or times a note is not known to us
  and is not guessed at.
* **Allowed sources** are P1's, with the same tags: **[UM]** the published user manuals' description of the
  language (syntax, ranges, what a statement does); **[HW]** the MC6847, the SAM and the PIAs as this repository
  models them (`js/chips/mc6847.js`, `js/chips/sam6883.js`, `js/machines/sam.js`, `js/machines/cocopia.js`);
  **[OWN]** our own decisions and general published algorithms (Bresenham's line, polygon and midpoint circles,
  scan-line seed fill, equal temperament); **[BB]** black-box observations of the real ROM (section 11).
* **Only functional results come back from the real ROM:** screen text (as P1), pictures of what a case drew, and
  measures of the sound it made (section 11). A recording of the raw DAC samples does not come back, because a
  waveform played from a table would carry that table.
* **[UM] facts are provisional** where the manual is silent or vague (defaults, error codes, clipping). Each is
  marked "BB" in the tables below and replaced by the black-box result when it arrives, as in P1.

## 2. Scope

| Statement or function | What it does [UM] | P2 |
|---|---|---|
| `PCLEAR n` | reserve n graphics pages (1-8) | yes |
| `PMODE m[,p]` | choose the graphics mode (0-4) and the start page | yes |
| `SCREEN t[,c]` | show text (0) or graphics (1), with colour set c (0 or 1) | yes |
| `COLOR f[,b]` | the foreground and background colours | yes |
| `PCLS [c]` | clear the current pages to c (default the background) | yes |
| `PSET (x,y[,c])`, `PRESET (x,y)` | set a point to c (default the foreground), or to the background | yes |
| `PPOINT (x,y)` | the colour of a point | yes |
| `SET (x,y,c)`, `RESET (x,y)`, `POINT (x,y)` | the 64 x 32 semigraphics points of the text screen | yes |
| `LINE [(x1,y1)]-(x2,y2),PSET\|PRESET[,B\|BF]` | a line, a box or a filled box; without the start, from the last point | yes |
| `CIRCLE (x,y),r[,c[,h[,s,e]]]` | a circle; h the height/width ratio; s and e the start and end, 0-1 of a turn | yes |
| `PAINT (x,y)[,c[,b]]` | fill from a point up to the border colour b | yes |
| `DRAW s$` | the drawing mini-language (section 6) | yes |
| `GET (x1,y1)-(x2,y2),A[,G]`, `PUT (x1,y1)-(x2,y2),A[,action]` | copy a rectangle to an array and back; actions `PSET`, `PRESET`, `AND`, `OR`, `NOT` | yes |
| `PCOPY a TO b` | copy one page to another | yes |
| `SOUND t,d` | a tone t (1-255) for d (1-255) units | yes |
| `PLAY s$` | the music mini-language (section 6) | yes |
| `AUDIO ON\|OFF` | route the cassette input to the speaker | yes |
| `JOYSTK(n)` | a joystick axis, 0-63; n 0-3 | yes |

**Deferred:** nothing. Every graphics and sound keyword ships complete: none is cut to meet the size budget (section
14, decision 2). Cassette (P1b) and the printer are not part of P2. `LINE` shares its token with
`LINE INPUT`: the handler in `io.inc` goes on to `LINE INPUT` when `INPUT` follows, otherwise to the graphics `LINE`
(`line.inc`).

## 3. Graphics memory and modes

### Pages

* A page is 1536 bytes (1.5K) [UM]; page p (1-8) starts at `$0600 + (p-1) x $600` [OWN, the P1 map]. Every page start
  is a multiple of 512, so the SAM's display offset (F0-F6, in units of 512 [HW]) can show any page.
* **Cold start:** `PCLEAR 4` [UM], so the program starts at `$1E01` as in P1. `PROGST` becomes the cold-start
  default and the start of the program a direct-page variable set by `PCLEAR`.
* **`PCLEAR n`** (1-8 [UM]) moves the program to `$0600 + n x $600 + 1` (a block move up or down, the links fixed
  as `program.inc` fixes them after an edit), then clears the variables as `CLEAR` does [OWN; whether variables
  survive, and whether `PCLEAR` inside a program goes on from the next statement, BB]. If the program does not fit:
  `?OM ERROR`. `PCLEAR 0` and n above 8: `?FC ERROR` [BB].
* **The current pages:** `PMODE m,p` sets the start page p (default: the current one [UM], 1 at cold start); the
  mode needs 1, 2 or 4 pages (table below), and p + pages - 1 above the `PCLEAR` count gives `?FC ERROR` [BB].

### Modes

Coordinates are always x 0-255, y 0-191, whatever the mode [UM]; a mode of lower resolution halves them.

| PMODE | Picture | Colours | Pages | Bytes a row | x, y used | VDG GM2-0 (PIA1 PB6-4) | SAM V2-0 |
|---|---|---|---|---|---|---|---|
| 0 | 128 x 96 | 2 | 1 | 16 | x/2, y/2 | 3 (RG2) | 3 |
| 1 | 128 x 96 | 4 | 2 | 32 | x/2, y/2 | 4 (CG3) | 4 |
| 2 | 128 x 192 | 2 | 2 | 16 | x/2, y | 5 (RG3) | 5 |
| 3 | 128 x 192 | 4 | 4 | 32 | x/2, y | 6 (CG6) | 6 |
| 4 | 256 x 192 | 2 | 4 | 32 | x, y | 7 (RG6) | 6 |

Pictures, colours and pages [UM]; GM and V from the data sheets as the repository models them [HW: `GMODES` in
`mc6847.js`, `BPL` / `XDIV` / `YDIV` in `sam6883.js`]. One table of 5 x 4 bytes in the ROM holds the mode's VDG bits,
SAM V, pages and a flags byte (bytes a row, x halved, y halved, bits a pixel).

* **A pixel's address:** page start + (y' x bytes a row) + x' / (pixels a byte), and a mask: 8 pixels a byte, bit 7
  leftmost, in the 2-colour modes; 4 pixels a byte, two bits each, bits 7-6 leftmost, in the 4-colour modes [HW].
* **`SCREEN 1,c`** writes the VDG bits to PIA1 port B (A/G = PB7, GM2-0 = PB6-4, CSS = PB3 = c) by read-modify-write,
  keeping PB0-PB2 (PB2 must stay high in 32K mode, PB1 is the single-bit sound) [HW], then the SAM's V bits and F bits
  for the start page through the set/clear pairs at `$FFC0-$FFD3` [HW]. **`SCREEN 0`** restores text: A/G low, V 0,
  F at `$0400`. When BASIC goes back to text by itself (the `OK` prompt, `PRINT`, an error, `INPUT`) is BB; ours
  goes back at the `OK` prompt and on an error until the black-box result says otherwise.
* **Colours** [UM, HW]: 0 black, 1 green, 2 yellow, 3 blue, 4 red, 5 buff, 6 cyan, 7 magenta, 8 orange (the VDG's own
  order after black [HW: `mc6847.js`]). In a 4-colour mode, colour set 0 gives 1-4 and set 1 gives 5-8; colour c is
  the 2-bit value (c - 1) AND 3. In a 2-colour mode, set 0 is black and green, set 1 black and buff; a pixel is 1
  for a foreground colour, 0 for black. What a colour outside the shown set draws, and what `PPOINT` returns for
  each pixel value, are BB; until then [OWN] the rule above, and `PPOINT` returns the colour number in the current
  set (1-4 or 5-8; 0 or the set's colour in two colours).
* **`COLOR f,b`** sets both (0-8, else `?FC ERROR` [BB]). The defaults after cold start and after `PMODE` are BB;
  [OWN] until then: foreground the set's last colour, background its first.
* **The last point** (the start of `LINE -(x,y)` and of `DRAW`) is a pair of 16-bit values in the system block
  (`LASTX`, `LASTY`, so `DRAW` can follow a point off the picture), set by `PSET`, `PRESET`, `LINE` and `DRAW` (not by
  `PPOINT`); its value after cold start (the centre, 128,96 [UM for `DRAW`]) is confirmed by BB.

### What the first graphics step implements

`basic/gfx.inc` and `basic/sgfx.inc` hold `PCLEAR`, `PMODE`, `SCREEN`, `COLOR`, `PCLS`, `PSET`, `PRESET`, `PPOINT`,
`PCOPY`, `SET`, `RESET` and `POINT`, with the routines the later statements share: `GETXY` (a point `(x,y` with its
range checks, into 4 bytes), `PLOT` (one pixel in the colour byte `GCOLB`), `GPIXAD` (a pixel's byte and mask),
`COLVAL` (a colour number as a byte of that colour in every pixel), `PGADR` (a page's address, checked against the
reserved pages), `BLKCPY` / `MOVBLK` (the one block loop: `PCLS` fills by copying each byte to the next) and `GSHOW` /
`TXTSCR`. Where the manual is silent the choices are ours, each to be replaced by the black-box result [OWN; BB]:

* **Cold start:** `PCLEAR 4` (the program at `$1E01`, as in P1), `PMODE 2,1`, colour set 0, the default colours, the
  last point 128,96.
* **Reserved pages and the program:** the pages end at `TXTTAB - 1`, so no separate count is kept: a mode's pages fit
  when the high byte of their end is at most `TXTTAB`'s. `PCLEAR` moves the program (up or down) and relinks it,
  checks room as `CLEAR` does (`?OM ERROR`), then ends as `CLEAR` does: variables cleared and the stack emptied (so
  `FOR` and `GOSUB` frames do not survive it), and a program goes on from the next statement, its text pointer moved
  with it. If the current mode's pages are no longer all reserved, the mode becomes `PMODE 0,1`.
* **`PMODE`** only chooses the mode and pages drawn on; what is shown changes at the next `SCREEN 1` (the `gfx-pcopy`
  case draws on page 5 while page 1 is shown). It sets the default colours of the mode and the current colour set.
* **`SCREEN t,c`:** t and c each 0 or 1 (`?FC ERROR` otherwise); c left out is 0. The set is remembered (for
  `PPOINT`, the default colours and the next `SCREEN 1`). Back on the text screen CSS is 0 (green text).
* **Back to text** happens at the `OK` prompt (`READY` calls `TXTSCR`, and an error ends there too); `PRINT`,
  `INPUT` and `CLS` write the text screen behind a picture that stays shown (decision 7).
* **Colours:** a colour number is kept and turned into pixels when a statement draws, so it means the same in any
  mode: four colours (c - 1) AND 3 (so 0 draws as 4 or 8), two colours black for 0 and the foreground for any other.
* **Semigraphics:** `SET`'s colour is (c - 1) AND 7 (0 gives orange, 8); `SET` and `RESET` on a cell holding a text
  character start from no element lit; `RESET` keeps the cell's colour.
* **Errors:** `?FC ERROR` for x above 255, y above 191, a colour above 8, a mode above 4, a page not reserved (or
  above 8, or 0), `PCLEAR` 0 or above 8, `SET`/`RESET`/`POINT` past 63 by 31; `?SN ERROR` from the shared readers.

### RAM for P2

Direct page (32 bytes free after P1 and its size pass, which put ten two-byte calls at `$E2-$FF`): only what every
pixel needs. The first graphics step takes 5 bytes: `GMENT` (the current mode's entry in the mode table), `GBEG` (its
start page's address) and `GCOLB` (the colour byte `PLOT` writes); the end of the pages and the reserved count are
computed from the mode table and `TXTTAB` instead of kept. The drawing statements add 2: `DRAW`'s angle and scale
(`DRANG`, `DRSCL`), which last from one `DRAW` to the next. Everything else the drawing statements work with lives
only while one statement runs, so it takes no new byte: the scratch words `TMPPTR`, `TMPPT2`, `TMPCNT` and `BINVAL`
(once the statement's arguments are read) and `PRINT USING`'s bytes, shared as `ON` and `RENUM` share them
(`d64basic.asm` names each use: the command string's place for `DRAW`, `GET`/`PUT`'s rows and action, `PAINT`'s
masks), and the 6809 stack (the line routine's axes, `X` substrings, `PAINT`'s seeds). Sound takes none in the direct
page: `PLAY`'s settings are in the system block and a note's working values in a frame on the stack (no note
countdown: lengths are cycle-counted). The system block (46 bytes free before P2): the first step uses 11 (`FGCOL`,
`BGCOL`, `GCSS` the colour set x 4, the last point `LASTX`/`LASTY` 16-bit each, `GXY` a point read), the drawing
statements none, the sound step 9 (section 7), leaving 26.

## 4. Modules and size budget

`basic/` gains one file per module, `INCLUDE`d after `misc.inc`; `tokens.json` gets the handlers.

| File | Contents | Budget (bytes) |
|---|---|---|
| `gfx.inc` | the mode table; reading `(x,y)` and a colour; pixel address and mask; plot and read a pixel; `PCLEAR`, `PMODE`, `SCREEN`, `COLOR`, `PCLS`, `PCOPY` (one block fill/copy loop), `PSET`, `PRESET`, `PPOINT` | 650 |
| `sgfx.inc` | `SET`, `RESET`, `POINT` on the text screen | 160 |
| `line.inc` | the line routine (shared with `DRAW` and `CIRCLE`), `LINE` with `B` and `BF` | 280 |
| `circle.inc` | `CIRCLE`, with its sine table (17 bytes) | 300 |
| `paint.inc` | `PAINT` | 320 |
| `mini.inc` | the mini-language reader shared by `DRAW` and `PLAY` (section 6) | 170 |
| `draw.inc` | `DRAW` | 420 |
| `getput.inc` | `GET`, `PUT` | 330 |
| `sound.inc` | the tone loop, `SOUND`, `AUDIO`, `JOYSTK` | 220 |
| `play.inc` | `PLAY`, its note table (24 bytes) | 450 |
| changes | the `LINE` dispatch, cold start (`PCLEAR 4`), the field interrupt's note countdown (not needed: lengths are cycle-counted, decision 4) | 40 |
| **Total** | | **3,340** |

`node tools/basic-size.js` today, with the cassette in and after P1's size pass ([clean-room-basic.md](clean-room-basic.md),
the size budget): 12,400 bytes of code and tables, 3,728 bytes free between `ROMEND` (`$B162`) and the vectors (the
page at `$8000-$80FF` stays reserved for P3 and is not counted). P2 may use at most **3,600** of them; that leaves
128 for P1 fixes and P3, short of the 400 wanted, so about 270 more bytes have still to be found in P1 (or P2 has to
come in under its cap).

**Measured so far** (`node tools/basic-size.js`): `gfx.inc` 644 bytes (budget 650, `PCOPY` included), `sgfx.inc` 136
(budget 160), and 6 bytes of hooks (`GINIT` at cold start, `TXTSCR` at `READY`): 786 of the 3,600, the image 13,195
bytes. The drawing statements (sections 5, 6 and 8 as implemented): `line.inc` 353 (budget 280),
`circle.inc` 271 and its 16-byte sine table (budget 300), `paint.inc` 277 (budget 320), `mini.inc` 211 (budget 170),
`draw.inc` 315 (budget 420), `getput.inc` 382 (budget 330) and 4 bytes in `gfx.inc` (`DRAW`'s scale at cold start):
1,829 bytes for a budget of 1,820 (`line.inc` holds the span filler that `BF` and `PAINT` share, and `getput.inc`
the array lookup that makes a missing array), 2,615 of the 3,600 with the first step; the image 15,051 bytes, 1,077
free below the vectors for the budget of `sound.inc`, `play.inc` and their hooks (710). The sound step (section 7, "What the sound step implements"): `sound.inc` 261
(budget 220: the cycle-counted tone loop of decision 4 is in it) and `play.inc` 418 (budget 450), 679 of the 710, reading
its string with `mini.inc`; the `CLRVAR` hook costs nothing (its call to `RSTTMP` became a call to `PLINIT`, which ends
there). The image with everything of P2: 15,730 bytes, 398 free below the vectors.

Rules that keep it small [OWN]: size before speed everywhere (no unrolled loops, no per-mode fast paths); one
routine for every pixel; one line routine for `LINE`, `DRAW` and `CIRCLE`; one block loop for `PCLS`, `PCOPY` and
`BF`; argument readers shared with P1 (`GETBYT`, `SYNCHR`, the comma checks). `basic-size.js` reports each module
against its budget, and the build fails if the image does not fit.

**If it does not fit**, nothing is cut (section 14, decision 2): the space is found elsewhere in the ROM, by making
the existing code smaller without changing anything a program can see.

## 5. The drawing algorithms

All [OWN], general published algorithms, chosen for size. Whether the original's pixels are the same is a
black-box question for each (section 11); where they differ, ours is changed to match the observed pixels.

* **Points:** `PSET`/`PRESET` and every routine below call one plot routine: (x, y) in 256 x 192 coordinates, scaled by
  the mode's flags, then address and mask (section 3). Out of range (x > 255, y > 191, negative): `?FC ERROR` for
  `PSET`, `PRESET`, `PPOINT` and the corners given to `LINE`, `GET` and `PUT` [BB]; points that `CIRCLE` and `DRAW`
  compute off the picture are not drawn (clipped point by point) [OWN; BB].
* **Lines:** Bresenham's integer algorithm: step along the major axis, add the minor delta to an error term, step the
  minor axis when it passes half the major delta. Both end points drawn. Lines are drawn in 256 x 192 coordinates,
  so a low-resolution mode plots some pixels twice (harmless, and keeps one routine). About 120 bytes.
* **Boxes:** `B` is four lines; `BF` fills row by row with the block loop (a partial byte at each end through the
  mask), about 60 bytes.
* **Circles:** a polygon of 64 chords drawn with the line routine. The points come from a 17-entry quarter-wave sine
  table (8-bit fractions, generated by `tools/basic-consts.js`): x = cx + r cos a, y = cy + r h sin a, with the 6809's
  `MUL` (r up to 255, h in 8.8 fixed point, 0-4 [UM]). Arcs start and end at the nearest 1/64 turn to s and e. At
  r = 255 a chord's distance from the true circle is under a third of a pixel, so the polygon looks round. A
  midpoint circle draws exact circles but needs a second algorithm for ellipses and arcs; if the black-box pictures
  show exact midpoint circles, it replaces the polygon for h = 1 and no arc (about 100 more bytes).
* **Paint:** a scan-line seed fill. A seed is popped; the run it lies in is found by moving left and right to a
  border pixel (or the picture's edge); the run is painted; the rows above and below are scanned along it, and a seed
  is pushed for each run that is neither border nor already paint colour. Seeds (x, y and a direction byte, 3 bytes)
  live between the end of the arrays and the stack, less a margin; running out gives `?OM ERROR` [OWN]. A pixel
  stops the fill if it is the border colour [UM] or already the paint colour [OWN: otherwise the fill never ends;
  whether the original also stops there is BB]. 4-connected [OWN; BB].
* **Semigraphics (`SET`, `RESET`, `POINT`):** the point (x 0-63, y 0-31) is element (x AND 1, y AND 1) of the
  character at `$0400 + (y/2) x 32 + x/2`; a semigraphics-4 character is `$80 + (colour - 1) x 16 + elements`, bit 3
  top left, bit 2 top right, bit 1 bottom left, bit 0 bottom right [HW, MC6847 data sheet]. `SET` on a cell that holds
  a text character starts from no elements lit [OWN; BB]. `POINT` returns the cell's colour if the element is lit, 0
  if not, and -1 for a text character [UM; BB].
* **`PCOPY a TO b`:** 1536 bytes with the block loop; either page above the `PCLEAR` count: `?FC ERROR` [BB].

### What the drawing statements implement

`basic/line.inc`, `circle.inc`, `paint.inc`, `mini.inc`, `draw.inc` and `getput.inc` (implemented; section 6 for
`DRAW`, section 8 for `GET` and `PUT`). Every choice the manual does not settle is [OWN; BB pending]: the `gfx-*`
black-box results decide it (decision 1). The places where the pixels can be moved to match them are marked `ADJUST`
in the source, each a constant or one instruction:

* **`LINETO`** (`line.inc`), the one line routine of `LINE`, `DRAW` and `CIRCLE`: from the last point to a 16-bit
  signed end, the last point ending there. Bresenham as above, written as: the error term starts at half the major
  delta rounded down (ADJUST), each step takes the minor delta off it, and when it goes negative it gets the major
  delta back and the minor axis steps. Every point is checked against the picture and drawn only on it, so `DRAW`
  and `CIRCLE` can go off any edge (and come back) without an error.
* **`LINE`**: the corners are read as `PSET`'s (`?FC ERROR` past the picture); `PSET` or `PRESET` must follow
  (left out, or another word: `?SN ERROR`), then `,B` or `,BF`. The box is the four lines (x1,y1)-(x2,y1)-(x2,y2)-
  (x1,y2)-(x1,y1); `BF` fills each row from the smaller x to the larger with `HSPAN` (whole bytes between two masked
  end bytes), so a filled screen takes 0.7 s. The last point is (x2,y2) after every form.
* **`CIRCLE`** (`circle.inc`): radius 0-255, colour 0-8, ratio 0-4, start and end 0-1, else `?FC ERROR`. The ratio is
  taken in 8.8 fixed point (its fraction below 1/256 dropped), r h rounded; corner j (whole 1/64 turns) is
  x = cx + r cos, y = cy + r h sin, y growing downwards (so 0.25 of a turn is at the bottom), each offset
  r x `SINTAB[k]` / 256 rounded to the nearest (ADJUST), with a quarter turn exactly r. Start and end go to the
  nearest 1/64 turn (ADJUST); an end at or before the start goes on past 0, and the same start and end draw the whole
  circle. The chords are drawn from the start corner on; the last point is left as it was.
* **`PAINT`** (`paint.inc`): the scan-line fill above, working on each pixel's byte and mask rather than its
  coordinates (a row is the same mask a row's bytes away; a row's ends are where the byte's place in its row is 0),
  so it is about ten times faster than a fill by coordinates (a whole PMODE 4 picture in 16 s, PMODE 0 in 4 s). A
  seed is 3 bytes (its byte's address and mask, no direction byte: each run seeds both rows, and a seed whose pixel
  is already painted is dropped), pushed after `CHKSTK` (`?OM ERROR` when the stack would come within 64 bytes of
  the arrays). The colour defaults to the foreground, the border to the colour [OWN; BB]. What it fills is the
  4-connected region of the start whatever the seed order, so only the stopping rule and the connectivity are
  ADJUST points.

## 6. DRAW's and PLAY's mini-languages

Both take a string expression and read it one character at a time with `mini.inc`, which does what the two share:
skip spaces and `;`; read a number; read `=var;` (a numeric variable's value) [UM]; run a substring with `X var$;`
[UM]; and apply the modifiers `+`, `-`, `>`, `<` where the manual allows them [UM, to be checked against the
manual for each command and by BB]. The string is evaluated once and its descriptor kept; nothing in either statement
allocates a string, so garbage collection cannot move it during the statement [OWN]. `=var;` and `X` borrow the text
pointer: it is saved, pointed into the string so `PTRGET` reads the name, and restored. `X` pushes the outer string's
place (address and count left, 4 bytes) on the 6809 stack and pops it at the substring's end; the depth is limited
by the stack check P1 has (`?OM ERROR`). An unknown command or a value out of range gives `?FC ERROR` [BB].

### DRAW [UM]

| Command | Meaning |
|---|---|
| `U n`, `D n`, `L n`, `R n` | up, down, left, right n units (n omitted: 1) |
| `E n`, `F n`, `G n`, `H n` | the diagonals: up-right, down-right, down-left, up-left |
| `M x,y` / `M +x,-y` | move to x,y; with a sign, relative |
| `B` (prefix) | the next move does not draw |
| `N` (prefix) | the next move draws, then the point goes back where it was |
| `C n` | colour |
| `A n` | angle: 0-3 quarter turns, applied to every direction |
| `S n` | scale, n/4 (1-62) |
| `X var$;` | run a substring |

A move becomes a (dx, dy) in 256 x 192 coordinates: the direction's unit vector, turned by `A`, times n x S / 4
(16-bit, rounded down [OWN; BB]), then a line from the last point with the line routine. The angle, scale and colour
last until changed [UM]; whether `DRAW` resets them at each statement is BB.

**As implemented** (`basic/mini.inc`, `basic/draw.inc`). The reader's interface, which `PLAY` uses too:

| Routine | Does |
|---|---|
| `MSSTR` | a string expression at the text pointer becomes the command string (`?TM ERROR` for a number) |
| `MSCMD` | the next command: A its character, C set at the end of the whole string; spaces and `;` skipped, `X var$;` run here (its outer place on the 6809 stack, so the caller keeps nothing there between two calls) |
| `MSGET`, `MSBACK` | the next character as it is (C set when there is none), and putting it back |
| `MSNUM` | a number: `=var;` or decimal digits, 0-255 (`?FC ERROR` beyond, or for a negative variable); D, C set when there is none (D 0) |

`MSPTR`, `MSCNT` and `MSDEP` (the place, the characters left, the substrings open) are `PRINT USING`'s bytes. The
choices [OWN; BB pending]: numbers are 0-255 and digits only (no sign or point; a sign belongs to `M`); a command's
number left out is 1 for a move and 0 for `C` and `A` (so `S` alone is `?FC ERROR`); `M`'s relative parts are scaled
by `S` like a move but not turned by `A`, and its absolute parts are neither; `C` sets the foreground colour, so it
lasts into the next `DRAW` and into `PSET`; `B` and `N` apply to the next move and are dropped after it; a `;`
missing after `=var` or `X var$`, or a name that runs past the string's end: `?FC ERROR`. `DRAW` keeps the angle and
scale from one statement to the next (`DRANG`, `DRSCL`; 0 and 4 at cold start, not reset by `RUN`), and starts from the
last point (128,96 at cold start).

### PLAY [UM]

| Command | Meaning |
|---|---|
| `A`-`G` | a note, with `#` or `+` (sharp) or `-` (flat) after it |
| `N n` | note n, 1-12, in the current octave (the `N` may be left out) |
| `O n` | octave 1-5 (default 2) |
| `L n` | length: 1/n of a whole note (default 4); `.` after a note or a length makes it half as long again |
| `T n` | tempo 1-255 (default 2); higher is faster |
| `V n` | volume 1-31 (default 15) |
| `P n` | a pause of length 1/n |
| `X var$;` | run a substring |

The defaults are [UM]; whether they persist from one `PLAY` to the next is BB (ours: they persist until `RUN` or
cold start).

**Pitch** [OWN, BB]: equal temperament, a semitone the twelfth root of 2, anchored on octave 2's A (`NOTEA`, in
1/100 Hz: 440 Hz until the black-box measure gives the original's). The note table (`NTPER`, 24 bytes) holds the
periods of octave 5's twelve notes in CPU cycles at the Dragon 64's 888,625 cycles a second (14.218 MHz / 16 [HW: the
PAL timing in `sam.js`]), each rounded to the cycle by the assembler from `NOTEA` and 2^(k/12) written as a 16-bit
fraction; an octave down doubles the period (a shift), so octaves are exact and every note is within 0.2% of equal
temperament (0.5% is the comparison's tolerance). The tone loop plays any period exactly to the cycle (section 7).

**Length and tempo** [UM, OWN]: a note lasts W / (L x T), with dots adding half, then a quarter, and so on: `PLAYW`
is W in units of 256 cycles (13,885: 4 s for a whole note at `T1`, so the default `L4 T2` is half a second) until the
black-box durations fit it. `PLAY` divides `PLAYW` by L x T (a 16-bit restoring division), adds the dots and hands the
tone loop a count in cycles; the loop takes each period from the count and stops when the next would not fit, so a note
is exact to within one of its periods, with nothing counted in fields (decision 4: the interim field countdown was
never built). Whether `TIMER` counts during a note is one equate, `SNDMSK` (section 7).

**Volume** [OWN]: the wave swings around the DAC's middle (`VMID`, 32): high 32 + V, low 32 - V on the 6-bit DAC (V 31
gives 1 to 63). A square wave is the smallest tone loop; the original's wave shape is not known to us and is measured,
not copied (section 11).

## 7. SOUND, AUDIO and JOYSTK

The hardware [HW, `cocopia.js`]: the 6-bit DAC is PIA1 port A bits 2-7 (bits 0-1 left as they are); it reaches the
speaker when the analogue multiplexer selects it (PIA0 CA2 low and CB2 low) and sound is on (PIA1 CB2 high). The
multiplexer also picks the joystick for the comparator: CB2 the joystick (low right, high left), CA2 the axis (low
x, high y). The comparator answers on PIA0 PA7: high when the selected axis (0-63) is at or above the DAC's value.

* **`SOUND t,d`** [UM]: a tone with the tone loop at full volume, for d units of about 0.06 s [UM; the exact unit
  BB]. The pitch rises with t [UM]; the period's dependence on t (we take k = 256 - t until measured) and the end
  points come from the black-box frequencies of t = 1, 50, 100, 150, 200, 255. `?FC ERROR` for t or d outside 1-255.
* **Sound on and off** [OWN]: `SOUND` and `PLAY` select the DAC, turn sound on, play, leave the DAC at its middle and
  sound on. Whether BREAK stops a long `SOUND` or `PLAY` is BB (ours checks BREAK between notes).
* **`AUDIO ON`** [UM, HW]: the multiplexer to the cassette input (CA2 high, CB2 low), sound on. **`AUDIO OFF`**: the
  multiplexer back to the DAC.
* **`JOYSTK(n)`** [UM, HW]: n 0-3 (0 right x, 1 right y, 2 left x, 3 left y [UM]); else `?FC ERROR`. `JOYSTK(0)`
  reads all four axes and keeps them; 1-3 return the kept values [UM; BB]. Each axis is a 6-step successive
  approximation: for each bit from 32 down, try the value with that bit set on the DAC and keep the bit if PA7 says
  the axis is at or above it. Sound is turned off while it reads (the DAC steps would be heard) and the multiplexer
  goes back to the DAC after [OWN]. The keyboard scan already ignores PA7 (P1).

### What the sound step implements

`basic/sound.inc` and `basic/play.inc` hold `SOUND`, `PLAY` (every command of section 6), `AUDIO`
and `JOYSTK`. Every constant the black-box measures are to fix is one equate, marked [OWN, BB pending] in the source:

| Equate | Value now | What it sets |
|---|---|---|
| `NOTEA` (`play.inc`) | 44000 | octave 2's A, in 1/100 Hz: the note table is assembled from it |
| `PLAYW` (`play.inc`) | 13885 | W, a whole note at `T1`, in 256 cycles (4.0 s) |
| `VMID`, the swing V (`sound.inc`) | 32 | the levels 32 - V and 32 + V; `VSND` (31) is `SOUND`'s V |
| `SNDP0`, `SNDPK` (`sound.inc`) | 150, 20 | `SOUND t`'s period, SNDP0 + SNDPK x (256 - t) cycles (170 at t = 255, 5,250 at t = 1) |
| `SNDU` (`sound.inc`) | 208 | `SOUND`'s unit in 256 cycles: 53,248 cycles, 0.0599 s |
| `SNDMSK` (`sound.inc`) | `$10` | `ORCC`'d while a tone plays: `$10` masks the field interrupt (`TIMER` stops, every period exact); 0 lets `TIMER` count, each field then lengthening one period by the interrupt's 66 cycles |

* **The tone loop** (`TONE`) [OWN]: a square wave of any period from 163 cycles up, exact to the cycle. A period is
  72 + 16k + 5(j + 1) cycles: each half waits k passes of an 8-cycle loop, and the high half also j + 1 passes of a
  5-cycle one, with j (0-15) = 13n AND 15 for n = period - 72, which makes n - 5j a multiple of 16 (13 x 5 = 65 is 1
  modulo 16); so the halves differ by at most a few dozen cycles. Its length is a 24-bit count of cycles from which
  each period is taken; the wave starts high and stops low when the next period would not fit. A pause is the same
  loop with its levels written to RAM, so nothing is heard and the timing is shared.
* **`PLAY`** [UM; OWN where marked]: the string's commands as section 6 lists them, read with `mini.inc` (`MSCMD`, `MSGET`/`MSBACK`, `MSNUM`; `X var$;` is run by `MSCMD`, and `PLAY` adds the octave's `+`, `-`, `>`, `<`). A letter
  with `-` below C (`C-`) is the B of the octave below, `B+` the C above; past octave 1 or 5, `?FC ERROR`. Dots after a
  length (`L4.`) last with it until the next `L`, and add to a note's own dots (`L4.A.` is 1.75 quarters) [OWN; BB].
  `V0` is accepted and silent (the manual gives 1-31) [OWN; BB]. A pause has its own dots and not the length's. The
  octave, length, tempo and volume last from one `PLAY` to the next until `CLRVAR` (`RUN`, `NEW`, `CLEAR`, `PCLEAR`,
  a load, cold start) sets O2, L4, T2, V15 again. BREAK is checked between commands; `SOUND` is not interrupted.
  After `PLAY` and `SOUND` the DAC is at its middle and sound is on.
* **`JOYSTK`**: `JOYSTK(0)` reads the four axes into `JOYV` (6 DAC steps an axis, sound off meanwhile and back as it
  was); `JOYSTK(1)`-`(3)` give the kept values.
* **Errors** [OWN; BB]: `?FC ERROR` for `SOUND` t or d 0 or above 255, `O` outside 1-5, `L`, `T` or `P` 0 or above 255,
  `V` above 31, `N` outside 1-12, a note past octave 1 or 5, a command letter that is not one, a command with no number,
  `JOYSTK` above 3, and from `mini.inc` a `;` missing after `=var` or `X var$` or a value outside 0-255; `?SN ERROR`
  for `AUDIO` without `ON` or `OFF`; `?TM ERROR` for a
  number where a string is wanted (`PLAY 5`, `X N;`) and the reverse (`O=A$;`).
* **RAM:** the system block gives 9 bytes (`JOYV` 4; `PLOCT`, `PLLEN`, `PLDOT`, `PLTMP`, `PLVOL` 5), leaving 26;
  the direct page gives none. A tone's working values are a 10-byte frame on the stack.
* **Measured on our ROM** (`node tools/basic-bb/run.js --ours`, the eight `snd-*` cases): every case runs to the end;
  each note's period is the table's to the cycle, `L`/`T`/dots/pauses give the formula's lengths, `V` gives the
  levels 32 - V to 32 + V, `TIMER` stops during a note (`SNDMSK`), BREAK stops `PLAY` between notes and not `SOUND`,
  `JOYSTK` reads back what `#joy` set. The batch's real-ROM results are not merged yet: until they are, each equate
  above is ours.

## 8. GET and PUT

* **The rectangle** [UM]: corners in 256 x 192 coordinates, scaled by the mode. With `G`, the rectangle is exact to
  the pixel; without, [UM] says it is coarser, and the exact rule (whole bytes, we assume) is BB.
* **The array** [OWN]: a numeric array the program has `DIM`med; the rectangle's bytes, row by row, packed five to an
  element over its 5-byte elements (P1's array layout). Too small: `?FC ERROR` [BB]. A program that prints the
  elements sees our packing, which may differ from the original's; that is a P3 question if programs depend on it.
* **`PUT`'s actions** [UM]: `PSET` copies, `PRESET` copies inverted, `AND` and `OR` combine with the screen, `NOT`
  inverts the screen (the array unused). Default `PSET` [UM; BB]. Pixel-exact `PUT` with `G` shifts each row's bits to
  the target's position; that shift is the largest part of `getput.inc`.
* **As implemented** (`basic/getput.inc`) [OWN; BB pending]: both statements work on the rectangle's own pixels
  (the corners halved where the mode halves them, in either order), always exact to the pixel: `G` is accepted and
  changes nothing until the black-box pictures give the coarse rule, and `PUT` uses the corners it is given, not a
  size kept in the array. One bit-copying loop (`BITCPY`) does both: `GET` copies the screen's bits into the array,
  `PUT` the array's bits onto the screen, each new bit looked up in the action's 4-entry truth table from the old
  screen bit and the array bit (so `PRESET` and `NOT` invert each bit, which in four colours turns colour value v into
  3 - v). The interim layout (decision 6): the elements' 5-byte values as one string of bytes from the first element's
  first byte; each row of the rectangle from a new byte, its pixels' bits from the top bit down (a four-colour pixel
  its two bits, high first), the bits after a row's last pixel 0. Only `GPBUF`'s start, the row length `GPRB` and the
  bit order in `BITCPY` decide it, so the original's layout, once known, changes those three. The array is found by
  its name alone (any number of dimensions), made with 11 elements when it does not exist; a string array is `?TM
  ERROR`, an array too small for rows x bytes a row `?FC ERROR`, an action other than the five (or anything after
  `GET`'s comma but `G`) `?SN ERROR`.

## 9. Errors

Every P2 error is one of P1's codes; P2 adds no message. Until the black-box results arrive [OWN]:

| Error | When |
|---|---|
| `?FC ERROR` | an argument out of its range (mode, page, colour, coordinate, tone, volume, `JOYSTK` index); `PMODE` past the reserved pages; a bad `DRAW` or `PLAY` command; an array too small for `GET` |
| `?SN ERROR` | a missing `(`, `,`, `)` or `-`; an unknown `PUT` action |
| `?OM ERROR` | `PCLEAR` with no room for the program; `PAINT`'s seeds or `X`'s nesting out of memory |
| `?TM ERROR` | a number where `DRAW`/`PLAY` want a string, or the reverse |
| `?BS ERROR`, `?UL`... | as P1, from the shared readers (an undimensioned `GET` array is created with 10 elements, as any array) |

Each line of this table gets a black-box case (section 11), in direct mode and in a program; the screen mode after an
error (text or graphics) is in the same cases.

## 10. Our own tests

All run with no ROM but ours, on the image assembled at test time; unlike black-box cases they may read any RAM.

* **`tests/basic-gfx.test.js`:** BASIC programs run on our ROM; the expected page bytes come from
  `tests/basic/gfxmodel.js`, a JavaScript reference rasteriser written from the algorithm descriptions in section 5
  (Bresenham, the 64-chord circle with the same sine table, the `DRAW` interpreter of section 6), not from our 6809
  code. Each picture is compared byte for byte with the page in RAM. Cases: every mode's pixel layout (a point at
  each corner and at x = 1, 2, 3 in each mode), lines in all octants and of length 0 and 1, boxes and filled boxes,
  circles of r 0, 1, 2, 100, 255 with ratios and arcs, `DRAW` with every command, `A` and `S`, `X` and `=var;`.
* **`PAINT` on hand-built shapes:** rectangles, a U, a spiral, a shape with holes, a ring, a one-pixel gap that must
  leak, shapes touching the picture's edges, a region holding pixels of the paint colour, and a fill that exhausts
  memory (`?OM ERROR`). The expected fill is computed by a plain 4-connected breadth-first fill in the test,
  independent of the scan-line algorithm.
* **Modes and pages:** after `PMODE m,p` and `SCREEN 1,c`, the PIA1 port B bits and the SAM's V and F bits
  (`m.sam.vmode`, `m.sam.displayBase`) match the table in section 3, written out by hand; `PCLEAR` moves a program and
  it still lists and runs; `PCOPY` and `PCLS`.
* **`GET`/`PUT`:** round trips at byte and pixel alignment, each action against the bitwise operation done in
  JavaScript on the page bytes before and after.
* **As implemented, `tests/basic-drawing.test.js`** (the drawing statements; `node tests/basic-drawing.test.js
  [part...]`): `LINE` (every octant both ways, lengths 0 and 1, `B`, `BF` with the corners either way, `PRESET`,
  `-(x,y)`, random lines) in PMODE 0-4 and both colour sets, and the last point after; `CIRCLE` (radii 0-255, ratios
  0-4, every kind of arc, colours, circles across every edge) in four modes, the last point kept; `PAINT` on ten
  hand-built shapes put straight into the page (the list above, a diagonal gap that must not leak, a start on the
  border) in five modes, with paint-colour pixels inside, a border other than the paint colour, the defaults; `?OM
  ERROR` from a comb of one-pixel teeth (a stretch to seed per tooth), BASIC going on after it, and a whole-picture
  fill with most memory taken by an array; `DRAW` (every command, `M` both ways, `N`, `B`, `A` and `S` and their
  lasting, `X` nested, `=var;`, spaces and `;`, moves off every edge) in three modes against the interpreter, with the
  last point, angle and scale after, and `C` in PMODE 3; `GET`'s bytes in the array and `PUT` with every action on
  eight rectangles (a whole row, one pixel, corners either way) over random pages in every mode, round trips at another
  alignment, an array too small or not `DIM`med; the errors of section 9, and a `DRAW` string that runs itself as a
  substring (`?OM ERROR`, then BASIC goes on). Mutants, each a one-line change to a copy of `basic/`, all turn it
  red (24 so far): the line's error term starting at the whole delta or stepping at 0, `BF`'s right end unmasked, a
  box's side missing; the circle's offsets truncated, its turn the other way, its start and end truncated; `PAINT`
  8-connected, its seeds a byte short, no `?OM ERROR` check, the border not stopping it, the row below not seeded;
  `DRAW`'s angle an eighth, its scale halved, `N` not coming back, a number's digits dropped, a substring's end not
  going back, `M` relative unscaled; `PUT`'s `NOT` and `AND` tables wrong, `GET`'s bit order reversed, its padding
  left, the array's size unchecked, four-colour rows counted as two-colour.
* **Sound, from the DAC events** (`tests/basic-sound.test.js`, implemented but for the `--wav` check): a write tap on `$FF20` (`busTaps.addWriteTap`) records (time, value) for each DAC
  write. From those the test measures each note's period, length and swing: `PLAY` notes within one loop's time of
  equal temperament, every octave and accidental, lengths and dots within one field of W / (L x T), volume as the
  swing 2V; `SOUND` pitch rising with t and lengths in whole units. `PLAY` and `SOUND` also run through
  `cli/cloadm.js --wav`, and the samples are checked against the events (the DAC value d is 320 x d [HW, the `--wav`
  scale]).
* **`JOYSTK`:** every axis at every value 0-63 (set through `m.joy`), each read back exactly; `JOYSTK(1)` before and
  after `JOYSTK(0)`.
* **`AUDIO`:** the multiplexer and sound-enable lines after `AUDIO ON`, `AUDIO OFF`, `SOUND` and `JOYSTK`.
* **Screenshots:** a handful of finished pictures (one per mode, both colour sets) kept as PNGs with
  `--expect-screenshot`, to catch a change in what the VDG shows that the RAM checks would miss.
* **Mutants** that must turn these red: Bresenham's error term off by one; the 4-colour mask shifted; `PAINT`
  8-connected; the seed stack one byte short; an octave shift wrong; a dotted note's half missing; `JOYSTK`'s bits in
  the wrong order; `SCREEN` clearing PB2 (the machine leaves BASIC).

## 11. Comparison with the real ROM

As P1 section 7: the maintainer runs the cases on the real ROM on their own machine with `tools/basic-bb/run.js`,
returns the results file, and `compare.js` reports differences. P2 adds pictures, sound and joysticks.

* **`#screenshot NAME`** [implemented]: records the current frame as a PNG (the frame's own pixels, unscaled, as
  `--screenshot` saves it) and the SHA-256 of its pixels in the results line. The harness turns composite colour off,
  so the pixels are the VDG's colours, not a PAL blend. A picture is functional output (what the program drew), so the
  PNGs may come back with the results. `compare.js` compares the hashes and, with `--shots DIR`, writes both PNGs of
  each picture that differs (a diff picture that marks and counts the differing pixels is not written yet).
* **`#wav NAME` ... `#wav-stop`** [implemented, in place of a WAV recording]: a write tap on the PIAs records every
  write to the DAC and every change to whether the DAC is heard, with its CPU cycle; what goes into the results file
  is only their **measures** (decision 5): for each tone its start, length and period in cycles (the median of its full
  cycles), the number of periods, writes and distinct levels, and its lowest and highest level; for the window its
  length, the writes, a hash of the events and the sound switch at the end. The exact segmentation into tones (a gap of
  more than 20,000 cycles or sound off ends a run; a change of period of more than 3% held for two periods splits it)
  is in P1 section 7 and `soundMeasures` in `tests/basic/harness.js`. No recording or level sequence leaves the
  machine: a wave played from a table would carry the table. `compare.js` compares periods within 0.5%, lengths and
  silences within one field, the lowest and highest levels and the end state exactly; the number of levels and writes
  (the shape, decision 3) and the hash are information only.
* **`#joy N V`** [implemented]: sets axis N (0-3, `JOYSTK`'s numbering) to V (0-63) through `m.joy` before the next line.
* **What only a black-box run can settle** (each a case in `tests/basic/cases/`, named `gfx-*` or `snd-*`): every
  item marked BB in sections 3-9, in particular the pixels of lines, circles (several radii, ratios and arcs), `PAINT`
  on the hand-built shapes, `DRAW` at each angle and scale; colours outside the set and `PPOINT`'s values; defaults
  after cold start and `PMODE`; when the screen returns to text; `SOUND`'s frequencies and unit; `PLAY`'s anchor
  pitch, W and whether settings persist; `GET`'s coarse rectangle; every error case of section 9. The first batch
  (all `# bb-only`: our suite only lints them, and `node tools/basic-bb/run.js --ours` runs them to the end; ours
  gives `?FC ERROR` for the statements not written yet):

  | Case | What it records |
  |---|---|
  | `gfx-modes` | `PMODE` 0-4 with each colour set: corners, neighbouring points, a diagonal, colours 0-8 (10 pictures) |
  | `gfx-color` | `COLOR`, `PCLS` with and without a colour, `PSET` 0-8 and `PRESET`, colours outside the set, in `PMODE` 1, 3 and 4 |
  | `gfx-defaults` | the mode, colours and last point at cold start, after `PMODE`, through `RUN`; `SCREEN 1` with no set |
  | `gfx-ppoint` | `PPOINT` of POKEd bytes in every mode and set, of `PSET` colours 0-8; `SET`, `RESET`, `POINT` on the text screen |
  | `gfx-line` | lines in every octant both ways, lengths 0 and 1, `B`, `BF`, `PRESET`, `LINE -(x,y)`, in `PMODE` 4, 0 and 3 |
  | `gfx-circle` | radii 0-95, ratios 0-4, arcs (each quarter, a wrap, start equal to end), colours, `PMODE` 0 and 3 |
  | `gfx-clip` | circles, `DRAW` moves, `LINE` and `PSET` past each edge (picture in pages 3-6 of 8; pages 2 and 7 shown after) |
  | `gfx-paint` | a box, a circle, a U, a diagonal-only gap (4- or 8-connected), paint-colour pixels inside, other borders, edges |
  | `gfx-draw` | the cold-start point, eight directions, `N`, `B`, `M`, `A` and `S` (and whether they last), `C`, `X`, `=var;` |
  | `gfx-getput` | `GET ... ,G` and each `PUT` action, the coarse rectangle without `G`, colours in `PMODE` 3 |
  | `gfx-getarray` | the array elements after `GET` of known bytes; chosen numbers `PUT` and shown, then read back (decision 6) |
  | `gfx-text-return` | a picture after `PRINT`, `INPUT`, an `INKEY$` loop, `CLS`, `END`, `STOP`, BREAK, an error, the last line, the prompt (decision 7) |
  | `gfx-pclear` | `MEM` after `PCLEAR` 1, 8, 4; a program and its variables through `PCLEAR` typed and in a program; `PCLEAR` 0 and 9 |
  | `gfx-pcopy` | `PCOPY` with `PCLEAR 8`, pages shown with `PMODE`, drawing on one page while another is shown |
  | `gfx-errors` | section 9's errors typed directly, and five in a program with a picture of the screen after each |
  | `snd-sound` | `SOUND` pitch for t = 1, 50, 100, 150, 200, 255; lengths 1-20 units; three in one line |
  | `snd-play-pitch` | the default octave, octaves 1-5, sharps and flats, `N1`-`N12` (the anchor pitch) |
  | `snd-play-length` | the default length, `L1`-`L64`, `T1`-`T255`, dots, pauses (W) |
  | `snd-play-volume` | the default volume, `V0`-`V31`, volume changing in one string (the level range) |
  | `snd-play-persist` | octave, length, tempo and volume from one `PLAY` to the next, through `RUN`; `O+`, `>`; `X`; `=var;` |
  | `snd-timer` | `TIMER` across `SOUND` and `PLAY` (decision 4); BREAK during a long `SOUND` and `PLAY` |
  | `snd-audio` | the sound switch and multiplexer after `AUDIO ON`, `AUDIO OFF`, `SOUND` and `PLAY` |
  | `snd-joystk` | every axis read back at the ends and middle; whether `JOYSTK(1)`-`(3)` keep what `JOYSTK(0)` read; the DAC during a read |

  Each picture part ends by putting a marker in the text screen's last two cells and looping, so the picture is
  taken while it is shown; a part that stops on an error goes on too (its `#wait-text` also accepts `ERROR IN`).
* **On a real Dragon by hand:** `sheet.js` prints screenshot steps as "photograph the screen", sound steps as
  "start recording the speaker" and joystick steps as "set the joystick"; those results are compared by eye and ear,
  and are not imported.

## 12. The lint for graphics and sound cases

P1's rules still apply unchanged: no `EXEC`, `USR`, `VARPTR`, `CLOADM`, `CSAVEM`; `PEEK` only of RAM; `POKE` only to
the text screen or to memory set aside with `CLEAR`. The run-time guard stays on. Added, and implemented in
`tools/basic-bb/lint.js` (each rule has refused and accepted examples in `tests/basic-bb.test.js`):

* **`POKE` to a graphics page** (`$0600-$1DFF`, the cold-start four) is allowed only in a case with no `PCLEAR`, so
  the pages cannot overlap the program.
* **`PCLEAR`, `PMODE`'s page and `PCOPY`'s pages** must be literals: `PCLEAR` 0-9 (0 and 9 only to see the error),
  `PMODE`'s start page 1-8, with the mode's pages (1, 2, 2, 4, 4; 4 when the mode is not a literal 0-4) within the
  case's reserved pages (its smallest `PCLEAR`, 4 when none is given; a `PMODE` with no page is taken at the highest
  page any `PMODE` gives), and `PCOPY`'s pages within them too. The pages then always lie below `$3600`, so a picture
  can never show ROM bytes, even if the original did not check the range.
* **Points stay small:** every point of `PSET`, `PRESET`, `SET`, `RESET`, `LINE`, `CIRCLE`, `PAINT`, `GET`, `PUT`,
  `PPOINT` and `POINT`, and `CIRCLE`'s radius, is a literal (x up to 511, y and the radius up to 255) or an expression
  ending in `AND n` with n up to 255 and no `OR`. Even if the original drew or read a point off the picture without
  checking, page 8's start (`$2D00`) plus 255 rows of 32 bytes and 511 points stays below `$8000`, so `PPOINT`,
  `POINT` and `GET` cannot read the ROM. Literals just past the edge are allowed for the error cases.
* **`DRAW`** takes its moves from a string, which the lint cannot bound: a case's `DRAW` strings are reviewed by hand
  to stay within 40 points of the picture, and the clipping case draws in pages 3-6 of 8, so a point that is not
  clipped lands in a reserved page.
* **Directives:** `#screenshot`, `#wav`, `#wav-stop` and `#joy` are directives, so always outside a program line; the
  lint refuses a directive the harness does not know and a malformed `#joy`, `#frames`, `#timeout` or `#wait-text`.
  `JOYSTK` reads the comparator and needs no rule.
* `SCREEN`, `COLOR`, `PCLS`, `PLAY` and `SOUND` need no rule: none can address memory.

## 13. P2 test list and milestones

Estimates are in working sessions, as in P1. Each milestone is pushed when green, with its head SHA, tree hash and CI
attempt 1. Nothing under `js/` changes, so the regression hashes (`tests/regress.test.js`) stay as they are; the
emulator needs no MAME comparison (4.4: not applicable, no hardware behaviour changes).

| # | Milestone | Done when | Estimate |
|---|---|---|---|
| G0 | This document; the harness's `#screenshot`, `#wav`, `#joy`; the lint rules; the first batch of black-box cases (modes, colours, defaults, `SOUND` and `PLAY` measures, error cases) | the cases pass the lint (in CI, `tests/basic-lang.test.js`) and run to the end on our ROM (`run.js --ours`); the batch is with the maintainer | 1 |
| G1 | `gfx.inc`, `sgfx.inc`: `PCLEAR`, `PMODE`, `SCREEN`, `COLOR`, `PCLS`, `PSET`, `PRESET`, `PPOINT`, `PCOPY`, `SET`, `RESET`, `POINT` | mode, page and point tests pass | 1-2 |
| G2 | `line.inc`, `circle.inc` and `gfxmodel.js` | line and circle tests pass | 1 |
| G3 | `paint.inc` | the `PAINT` shapes pass | 1 |
| G4 | `mini.inc`, `draw.inc` | `DRAW` tests pass | 1 |
| G5 | `getput.inc` | `GET`/`PUT` tests pass | 1 |
| G6 | `sound.inc`: `SOUND`, `AUDIO`, `JOYSTK`, the tone loop | sound, joystick and multiplexer tests pass | 1 |
| G7 | `play.inc`, the note table | `PLAY` timing tests pass | 1-2 |
| G8 | Black-box round: align pixels, timing and errors with the real ROM | the comparison report is clean or every difference is explained | 1-2, depends on the results |

## 14. Decisions

The open questions of this design, answered, each with the decision and why.

1. **Pixel exactness: the target is pixel-exact.** One pixel can change what a program does (a gap in a circle lets
   `PAINT` leak; games test collisions with `PPOINT` and `POINT`), so as with the floating point, ours ships first,
   `#screenshot` black-box cases of lines, circles, arcs and fills are compared with the original's, and the
   algorithms are aligned to them. A difference that remains is listed with its case, and only where matching it would
   cost bytes the ROM does not have.
2. **Nothing is cut.** Every statement of section 2 ships complete; a statement that gave an error would break every
   program using it. If P2 does not fit, the space is found by making the existing code smaller without changing
   anything a program can see.
3. **The sound wave: pitch, length and loudness match; the shape is ours.** Those three are what programs and
   listeners depend on (a program waits while a note plays), and the black-box measures them. The wave's shape only
   changes the timbre, no program can read it back, and recovering a wave table's levels from recordings would bring
   ROM data in by another route: if the original's wave is not square, ours is a similar shape we compute ourselves.
4. **Note timing: matched to the cycle.** Lengths are cycle-counted (about 40 bytes) to match the black-box measures,
   since errors add up over a tune and change a game's pace; whether `TIMER` counts during `PLAY` and `SOUND` matches
   the original too. Field counting is only an interim first version.
5. **Recordings stay on the maintainer's machine.** Only the measures come back (pitch, length in cycles, the level
   range and count, a hash). A recording repeats every level written to the DAC, so it could carry a wave table, and
   after decision 3 the measures are all that is used. A mismatch the measures cannot explain gets a focused
   measurement on that case.
6. **`GET`'s array layout matches the original's.** Programs build sprites from `DATA` into an array and `PUT` them
   without `GET`, or print and edit the elements, so the layout is visible to them. It is found black-box (`GET`
   known patterns and print the elements; fill elements with chosen numbers, `PUT` them and take a screenshot) and
   matched; our own packing is interim.
7. **Back to text: at the `OK` prompt and on an error, for now.** Text that `PRINT` and `INPUT` write goes to the
   text screen behind the picture, so a picture a program shows is never lost and a prompt is always visible.
   Black-box cases (`PRINT`, `INPUT`, `INKEY$`, `END`, `STOP`, BREAK, an error, the prompt, each with a screenshot)
   settle it, and ours matches them.

## 15. Provenance log

Numbering continues P1's log.

| # | Fact | Source |
|---|---|---|
| 16 | Graphics pages are 1.5K; `PCLEAR` reserves 1-8; 4 at cold start | [UM] |
| 17 | Page p starts at `$0600 + (p-1) x $600` | [OWN], the P1 memory map |
| 18 | `PMODE` 0-4: picture size, colours and pages of each | [UM] |
| 19 | The VDG mode of each picture (RG2, CG3, RG3, CG6, RG6) and its GM bits; PIA1 PB3 CSS, PB4-6 GM0-2, PB7 A/G; PB2 the ROM select | [HW] `mc6847.js` `GMODES`, `sam.js` `VDG_BITS`, `boot.inc` |
| 20 | The SAM's V modes 3-6 for those pictures; F0-F6 the display offset in units of 512; the set/clear pairs at `$FFC0-$FFD3` | [HW] `sam6883.js`, the MC6883 data sheet |
| 21 | Pixel packing: 8 a byte or 4 two-bit pixels a byte, leftmost in the top bits | [HW] the MC6847 data sheet, `mc6847.js` |
| 22 | Coordinates are 0-255 by 0-191 in every mode | [UM] |
| 23 | Colour numbers 0-8 (black, green, yellow, blue, red, buff, cyan, magenta, orange) and the two colour sets | [UM]; the order [HW] `mc6847.js` |
| 24 | Syntax and meaning of `PCLEAR`, `PMODE`, `SCREEN`, `COLOR`, `PCLS`, `PSET`, `PRESET`, `PPOINT`, `SET`, `RESET`, `POINT`, `LINE`, `CIRCLE`, `PAINT`, `GET`, `PUT`, `PCOPY` | [UM] |
| 25 | Semigraphics-4 characters: bit 7 set, colour in bits 4-6, elements in bits 0-3 (top left = bit 3) | [HW] the MC6847 data sheet |
| 26 | `DRAW`'s commands, prefixes, angle and scale | [UM] |
| 27 | `PLAY`'s commands, ranges and defaults (O2, L4, T2, V15) | [UM] |
| 28 | `SOUND` t,d ranges; d in units of about 0.06 s | [UM]; the exact unit [BB] |
| 29 | `JOYSTK` 0-3 order, 0-63 range, `JOYSTK(0)` reads all four | [UM]; to be confirmed [BB] |
| 30 | The DAC on PIA1 PA2-7; the multiplexer on PIA0 CA2/CB2; sound enable PIA1 CB2; the comparator on PIA0 PA7 | [HW] `cocopia.js` |
| 31 | `AUDIO ON` routes the cassette to the speaker | [UM]; the multiplexer setting [HW] |
| 32 | The CPU clock 14.218 MHz / 16 and the 50 Hz field on the Dragon 64 | [HW] `sam.js` PAL timing, `profiles.js` |
| 33 | Bresenham lines, polygon circles, scan-line seed fill, successive approximation, equal temperament | [OWN], general published algorithms |
| 34 | The sine table, the note table, the tone loop, the length formula's form, the volume swing, the `GET` array layout | [OWN]; the constants that must match (anchor pitch, W) from [BB] |
| 35 | `PCLEAR n` reserves n pages and the program follows them; `PMODE m,p`'s mode and start page; `SCREEN`'s text or graphics and colour set; `COLOR f,b`; `PCLS` with an optional colour; `PSET`'s optional colour; `PPOINT` returns a colour; `PCOPY a TO b` | [UM] |
| 36 | The PIA1 port B bits written by read-modify-write keeping PB0-PB2; the SAM's V and F bits by their clear and set addresses | [HW] `cocopia.js`, `sam6883.js` |
| 37 | Cold-start `PMODE 2,1`; `PMODE` not changing what is shown; `SCREEN` with no set giving set 0; CSS 0 on the text screen; `PCLEAR` ending as `CLEAR` and going on, falling back to `PMODE 0,1`; colour 0 in four colours; `SET` with colour 0; `SET`/`RESET` on a text character; `PPOINT`'s values; the error choices of section 3 | [OWN]; each to be confirmed [BB] |
| 38 | Syntax of `LINE` (`PSET`/`PRESET`, `B`, `BF`, `-(x,y)`), `CIRCLE` (r, c, h, s, e and their ranges), `PAINT` (c, b), `DRAW`'s commands, `GET` (`G`) and `PUT`'s five actions | [UM] |
| 39 | `LINE`: the error term's start (half the major delta, rounded down), both ends drawn, the box's corner order, `PSET`/`PRESET` required (`?SN ERROR`), the last point (x2,y2) after every form; `DRAW` and `CIRCLE` clipped point by point | [OWN, BB pending: `gfx-line`, `gfx-clip`] |
| 40 | `CIRCLE`: the 64-chord polygon, offsets rounded to nearest with an 8-bit sine table, the ratio truncated to 1/256, start and end to the nearest 1/64 turn, the turn clockwise on the screen from 3 o'clock, an end at or before the start wrapping, start = end the whole circle, the last point kept | [OWN; the direction from the manual's description, BB pending: `gfx-circle`] |
| 41 | `PAINT`: stops at the paint colour as well as the border; 4-connected; colour default the foreground, border default the colour; 3-byte seeds on the stack, `?OM ERROR` at `CHKSTK`'s margin | [OWN, BB pending: `gfx-paint`] |
| 42 | `DRAW`: numbers 0-255, digits only; a move's number left out 1, `C`/`A` 0; n x S / 4 rounded down; `M` relative scaled, not turned; `C` sets the foreground; `A` clockwise; angle and scale kept from one `DRAW` to the next and through `RUN`; the errors | [UM for `A`'s direction and that settings last; OWN for the rest, BB pending: `gfx-draw`] |
| 43 | `GET`/`PUT`: exact to the pixel with or without `G`; `PUT`'s rectangle its own corners; the array's interim byte layout (rows from a new byte, high bit first, padding 0); an array made with 11 elements; `?TM`, `?FC`, `?SN` as section 8 says | [OWN, interim (decision 6), BB pending: `gfx-getput`, `gfx-getarray`] |
| 44 | `CIRCLE`'s sine table: sin(k/64 turn) x 256 rounded, k = 0-15, generated by `tools/basic-consts.js` (`sine.inc`) | [OWN] (a general mathematical table) |
| 45 | The tone loop: a period of 72 + 16k + 5(j + 1) cycles, j = 13n AND 15; the 24-bit count of cycles; a pause as the same loop writing RAM | [OWN] |
| 46 | `NOTEA` 440 Hz (octave 2's A), `PLAYW` 4 s, `SOUND`'s period SNDP0 + SNDPK x (256 - t) and unit 0.0599 s, the levels 32 -/+ V and `SOUND`'s V 31, `TIMER` stopped during a note (`SNDMSK`) | [OWN], each to be fitted [BB] |
| 47 | `PLAY`'s defaults O2, L4, T2, V15 | [UM]; set again by `CLRVAR` [OWN; BB] |
| 48 | A length's dots lasting until the next `L` and adding to a note's; dots adding 1/2, 1/4...; `V0` silent; `C-` and `B+` crossing the octave; a pause without the length's dots; the errors of section 7 | [OWN; BB] |
| 49 | `JOYSTK(0)` reading all four axes, 1-3 the kept values, the axis order | [UM; BB]; the successive approximation [OWN]; the comparator and multiplexer [HW] `cocopia.js` |

Black-box facts are added with the date of the run they came from.
