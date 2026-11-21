// add_roms' downloader: one https URL the person gave, fetched with the checks the owner set (docs/mcp.md, "Adding
// your ROMs"):
//  * https only, and no user name or password in the URL;
//  * the host's every address resolved and checked before connecting, and the connection made to a checked address
//    (so a second lookup cannot answer differently): loopback, link-local, private, CGNAT, unspecified, multicast and
//    reserved addresses are refused, also as IPv4-mapped, NAT64 or 6to4 IPv6;
//  * each redirect checked the same way, at most MAX_REDIRECTS of them;
//  * at most maxBytes read (the Content-Length checked first, the body counted as it comes); TIMEOUT_MS for it all;
//  * nothing sent but GET, the host and a user agent: no cookies, no credentials, no proxy.
// fetchRom(url, { maxBytes, signal, timeoutMs, ca, lookup, dial }) -> { name, bytes, url }; failures are McpToolErrors
// (refused-url, too-large, fetch-failed, cancelled). ca, lookup and dial are for tests only (a test CA; names resolved
// to test addresses, which are checked as any other; and the local test server a checked address is connected to); the
// defaults are the system's trust store, DNS, and the checked address itself.
'use strict';
const https = require('https');
const dns = require('dns');
const net = require('net');
const T = require('../js/mcp/tools.js');

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20000;

const v4Ranges = [
  ['0.0.0.0', 8, 'unspecified'], ['10.0.0.0', 8, 'private'], ['100.64.0.0', 10, 'CGNAT'], ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'], ['172.16.0.0', 12, 'private'], ['192.0.0.0', 24, 'reserved'], ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'], ['224.0.0.0', 4, 'multicast'], ['240.0.0.0', 4, 'reserved'],
];
const v6Ranges = [
  ['::', 128, 'unspecified'], ['::1', 128, 'loopback'], ['fe80::', 10, 'link-local'], ['fec0::', 10, 'site-local'],
  ['fc00::', 7, 'private'], ['ff00::', 8, 'multicast'], ['100::', 64, 'discard'],
];
const lists = {};
for (const [a, bits, why] of v4Ranges) (lists[why] = lists[why] || new net.BlockList()).addSubnet(a, bits, 'ipv4');
for (const [a, bits, why] of v6Ranges) (lists[why] = lists[why] || new net.BlockList()).addSubnet(a, bits, 'ipv6');

// an IPv6 address as 8 numbers
function groups6(a) {
  let s = a.toLowerCase().replace(/%.*$/, '');
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) { const p = m[1].split('.').map(Number); s = s.slice(0, -m[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`; }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : new Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((x) => parseInt(x || '0', 16));
}
const v4of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
// an address -> why it is refused, or null when it is a public one
function refusedAddress(addr) {
  const kind = net.isIP(addr);
  if (kind === 4) { for (const why in lists) if (lists[why].check(addr, 'ipv4')) return why; return null; }
  if (kind !== 6) return 'not an IP address';
  const g = groups6(addr);
  // an IPv4 address inside the IPv6 one: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64 (64:ff9b::/96), 6to4 (2002::/16)
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || (g[5] === 0 && (g[6] || g[7] > 1)))) return refusedAddress(v4of(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return refusedAddress(v4of(g[6], g[7]));
  if (g[0] === 0x2002) return refusedAddress(v4of(g[1], g[2]));
  for (const why in lists) if (lists[why].check(addr, 'ipv6')) return why;
  return null;
}

const fail = (code, detail) => new T.McpToolError(code, detail);
const systemLookup = (host) => new Promise((resolve, reject) => dns.lookup(host, { all: true, verbatim: true }, (e, list) => (e ? reject(e) : resolve(list.map((x) => x.address)))));

async function fetchRom(url, { maxBytes, signal = null, timeoutMs = TIMEOUT_MS, ca = undefined, lookup = systemLookup, dial = (a) => a } = {}) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onAbort = () => ctl.abort();
  if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const stopped = () => (timedOut ? fail('fetch-failed', `timed out after ${Math.round(timeoutMs / 1000)} s`) : fail('cancelled', 'the download was stopped'));
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      let u;
      try { u = new URL(current); } catch (e) { throw fail('refused-url', `not a URL: ${current}`); }
      if (u.protocol !== 'https:') throw fail('refused-url', `${u.protocol.replace(':', '')} is not https${hop ? ' (a redirect)' : ''}`);
      if (u.username || u.password) throw fail('refused-url', 'a user name or password in the URL');
      const host = u.hostname.replace(/^\[|\]$/g, '');
      let addrs;
      if (net.isIP(host)) addrs = [host];
      else {
        try { addrs = await lookup(host); } catch (e) { throw fail('fetch-failed', `${host}: ${e.code || e.message}`); }
        if (!addrs.length) throw fail('fetch-failed', `${host}: no address`);
      }
      for (const a of addrs) {
        const why = refusedAddress(a);
        if (why) throw fail('refused-url', `${host} is ${a}, a ${why} address${hop ? ' (a redirect)' : ''}`);
      }
      if (ctl.signal.aborted) throw stopped();
      const r = await get(u, dial(addrs[0]), { ca, signal: ctl.signal, maxBytes }).catch((e) => { throw ctl.signal.aborted ? stopped() : e; });
      if (r.redirect) {
        if (hop >= MAX_REDIRECTS) throw fail('refused-url', `more than ${MAX_REDIRECTS} redirects`);
        current = new URL(r.redirect, u).href;
        continue;
      }
      const name = decodeURIComponent(u.pathname.split('/').pop() || '') || 'download.rom';
      return { name, bytes: r.bytes, url: u.href };
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// one GET to a checked address -> { redirect: location } or { bytes }
function get(u, address, { ca, signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    const family = net.isIP(address);
    const req = https.request({
      protocol: 'https:', hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || 443, path: u.pathname + u.search, method: 'GET',
      headers: { 'user-agent': 'cloadm-add-roms', accept: '*/*', 'accept-encoding': 'identity' },
      agent: false, ca, signal,
      // connect only to the address checked above (the certificate is still checked against the host name)
      lookup: (hostname, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
    }, (res) => {
      const status = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume();
        if (!res.headers.location) { reject(fail('fetch-failed', `HTTP ${status} without a Location`)); return; }
        resolve({ redirect: res.headers.location });
        return;
      }
      if (status !== 200) { res.resume(); reject(fail('fetch-failed', `HTTP ${status}`)); return; }
      const stated = Number(res.headers['content-length']);
      if (Number.isFinite(stated) && stated > maxBytes) { req.destroy(); reject(fail('too-large', `${stated} bytes, at most ${maxBytes}`)); return; }
      const parts = [];
      let got = 0;
      res.on('data', (d) => {
        got += d.length;
        if (got > maxBytes) { req.destroy(); reject(fail('too-large', `more than ${maxBytes} bytes`)); return; }
        parts.push(d);
      });
      res.on('end', () => { const b = Buffer.concat(parts); resolve({ bytes: new Uint8Array(b.buffer, b.byteOffset, b.length) }); });
      res.on('error', (e) => reject(fail('fetch-failed', e.code || e.message)));
    });
    req.on('error', (e) => reject(e instanceof T.McpToolError ? e : fail('fetch-failed', e.code || e.message)));
    req.end();
  });
}

module.exports = { fetchRom, refusedAddress, MAX_REDIRECTS, TIMEOUT_MS };
