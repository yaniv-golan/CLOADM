# The CPU core contract

What a machine family (`js/machines/`), the interrupt hub (`js/machines/bus.js`), the debugger and the tests use
of a CPU core. A new core (the HD6309) provides all of it; a member not listed here is the core's
own business. Cores are registered by name in `cpus.js` (`config.cpu`).

## Construction and running

| Member | Meaning |
|---|---|
| `new Core(bus)` | `bus.read(a)` and `bus.write(a, v)` are every memory access, byte by byte; the machine is the bus |
| `reset()` | the reset line: registers as the data sheet gives them, then PC from the reset vector |
| `step()` | runs one instruction (or takes an interrupt, or one cycle while halted or waiting) and returns its cycles |
| `jump(addr)` | sets PC, leaving any wait state (CWAI, SYNC, the 6803's WAI) |
| `willExecute()` | true when the next `step()` runs an instruction (not an interrupt, a halt or a wait) |
| `pc`, registers (`a`, `b`, `d`, `x`, `s`, `cc`, `dp` on the 6809 ...) | readable and writable |
| `trace` | `null`, or a function called with the core before each instruction (lockstep, debugger, tests) |
| `saveState()` / `loadState(s)` | everything `step()` depends on; see `STATE` in each core |

## Cycle accounting (exact timing)

| Member | Meaning |
|---|---|
| `totalCycles` | cycles since reset, counting the instruction just run (the MAME comparison compares these) |
| `c` | cycles of the instruction being run so far; the machine sets it to 0 before `step()` |
| `cycleCount` | bus cycles logged in the current step |
| `cycleAddr[i]` | the address presented in bus cycle `i` of the step (`$FFFF` for an idle cycle) |
| `cycleNoStop[i]` | 1 where MAME's core has no scheduler check point after cycle `i` (`m6809.lst` `@`) |

Machines use the log to place an I/O access inside the instruction (`ioTime()`), and under `config.mameCompat` to
stop where MAME's scheduler would.

## Interrupt and halt lines (6809)

| Member | Meaning |
|---|---|
| `irqLine`, `firqLine` | level inputs, set by the interrupt hub |
| `nmi()` | an NMI edge; ignored until S has been loaded (`nmiArmed`) |
| `haltLine` | the HALT input: while set, `step()` runs one idle cycle and nothing else |
| `haltTail` | idle cycles still to run after HALT is released (the machines' `mameCompat` model of MAME suspending an instruction) |
| `stepHalted` | the last `step()` was one of those idle cycles: no instruction ran (the debugger doesn't count it) |
| `executing` | the step is running an instruction, not taking an interrupt |
| `mark()` / `rewind()` / `rerun()` | keep the registers at the start of a step, put them back, and run the instruction at PC again without taking an interrupt or calling `trace` (the CoCo 3's instruction suspended by HALT) |
| `mameCompat` | set by the machine: reproduce MAME's bookkeeping where it differs from the data sheet |
