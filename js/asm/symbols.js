/*
 * Symbol maps: a program's names and addresses as text, and back.
 *   formatSymbols(symbols) -> "NAME $ADDR" lines, one per symbol, sorted by address (then name)
 *   parseSymbols(text)     -> Map name -> address, from that format or from a linker's map
 *   lookupSymbol(map, name) -> the address, or undefined (the assembler upper-cases its labels; a name matches case-insensitively when
 *                              exactly one symbol does)
 *
 * What parseSymbols reads, one symbol a line (blank lines and lines starting with *, ; or # are skipped):
 *   NAME $ADDR   NAME 0xADDR   NAME ADDR   NAME = ADDR   NAME: ADDR     this project's own format (written with $), and the
 *                                                                        plain "name address" lines of a CMOC .map
 *                                                                        (a bare ADDR is hexadecimal, as linkers print it)
 *   Symbol: NAME (file) = ADDR    Local symbol: NAME (file) = ADDR       LWLINK's -m map (its "Section:" lines are skipped)
 * The name and the address are separated by white space, "=" or ":" ("CODE" is not the symbol COD at $E). An address is 1 to 4
 * hexadecimal digits, in either case; a symbol whose name appears twice with different addresses, a line that is none of the
 * above and an address past $FFFF are errors that name the line (a SymbolsError with `line`).
 */
export class SymbolsError extends Error {
  constructor(message, line) { super(line ? `line ${line}: ${message}` : message); this.name = 'SymbolsError'; this.line = line || null; }
}

const NAME = '[A-Za-z_.@][A-Za-z0-9_.@$]*';
const ADDR = '(?:\\$|0[xX])?([0-9A-Fa-f]{1,5})';   // five digits are matched so that $10000 is refused by value, not misread
const LWLINK = new RegExp(`^(?:Local\\s+)?[Ss]ymbol:\\s*(${NAME})\\s*(?:\\([^)]*\\))?\\s*=\\s*${ADDR}$`);
const PLAIN = new RegExp(`^(${NAME})(?:\\s*[=:]\\s*|\\s+)${ADDR}$`);
const SKIP = /^(?:[*;#]|\/\/|Section:|Entry:|Symbol\s+Address\b)/i;

export function parseSymbols(text) {
  const symbols = new Map();
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || SKIP.test(line)) return;
    const m = LWLINK.exec(line) || PLAIN.exec(line);
    if (!m) throw new SymbolsError(`not a symbol line: "${line.length > 60 ? `${line.slice(0, 57)}...` : line}" (NAME $ADDR)`, i + 1);
    const addr = parseInt(m[2], 16);
    if (addr > 0xFFFF) throw new SymbolsError(`${m[1]}'s address ${m[2].toUpperCase()} is past $FFFF`, i + 1);
    if (symbols.has(m[1]) && symbols.get(m[1]) !== addr) throw new SymbolsError(`${m[1]} is given two addresses ($${symbols.get(m[1]).toString(16).toUpperCase()} and $${addr.toString(16).toUpperCase()})`, i + 1);
    symbols.set(m[1], addr);
  });
  return symbols;
}

// symbols: a Map, or an object, of name -> address; what is not a 16-bit whole number (an assembler value that is not an address) is left out
export function formatSymbols(symbols) {
  const entries = (symbols instanceof Map ? [...symbols] : Object.entries(symbols)).filter(([, a]) => Number.isInteger(a) && a >= 0 && a <= 0xFFFF);
  entries.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.map(([name, a]) => `${name} $${a.toString(16).toUpperCase().padStart(4, '0')}\n`).join('');
}

export function lookupSymbol(symbols, name) {
  if (!symbols) return undefined;
  if (symbols.has(name)) return symbols.get(name);
  const up = name.toUpperCase(), hits = [...symbols].filter(([k]) => k.toUpperCase() === up);
  return hits.length === 1 ? hits[0][1] : undefined;
}
