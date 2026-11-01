// Shared helpers for the Framer static export pipeline.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');

const HERE = import.meta.dirname;
export const SITE_ORIGIN = (process.env.SITE_ORIGIN || 'https://www.skylineodivelas.pt').replace(/\/$/, '');
export const SITE_HOSTS = new Set([new URL(SITE_ORIGIN).hostname, new URL(SITE_ORIGIN).hostname.replace(/^www\./, '')]);
export const OUT_DIR = path.resolve(process.env.OUT_DIR || path.join(HERE, '../../site'));
export const REPORT_DIR = path.resolve(process.env.REPORT_DIR || path.join(HERE, '../../report'));
export const WORK_DIR = path.resolve(process.env.WORK_DIR || path.join(HERE, '.work'));

export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true },
];

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Test hook: ORIGIN_MAP='{"https://framerusercontent.com":"http://127.0.0.1:9999/framerusercontent.com"}'
// lets the self-test point every remote origin at a local mock server.
const ORIGIN_MAP = JSON.parse(process.env.ORIGIN_MAP || '{}');
export const TEST_MODE = Object.keys(ORIGIN_MAP).length > 0;
export function mapOrigin(url) {
  const u = new URL(url);
  const target = ORIGIN_MAP[u.origin];
  return target ? target + u.pathname + u.search : url;
}

// ---------------------------------------------------------------------------
// Which hosts get copied locally.
const MODULE_CDNS = new Set(['esm.sh', 'ga.jspm.io', 'cdn.jsdelivr.net', 'unpkg.com']);
const PLAIN_ASSET_HOSTS = new Set(['fonts.gstatic.com', 'fonts.googleapis.com', ...MODULE_CDNS]);
// Hosts where the query string changes the response, so it is kept (hashed into the file name).
const QUERY_SIGNIFICANT = new Set(['fonts.googleapis.com', 'esm.sh', 'unpkg.com']);

export const isModuleCdn = (host) => MODULE_CDNS.has(host);

export function isAssetUrl(u) {
  if (typeof u === 'string') {
    try { u = new URL(u); } catch { return false; }
  }
  const h = u.hostname.toLowerCase();
  if (h === 'framerusercontent.com' || h.endsWith('.framerusercontent.com')) return true;
  if (h === 'framerstatic.com' || h.endsWith('.framerstatic.com')) return true;
  if ((h === 'framer.com' || h === 'www.framer.com') && u.pathname.startsWith('/m/')) return true;
  return PLAIN_ASSET_HOSTS.has(h);
}

/** Any Framer-owned host (used by verification: must see zero requests to these). */
export function isFramerHost(host) {
  return /(^|\.)(framer\.com|framerusercontent\.com|framerstatic\.com|framer\.website|framer\.app|framer\.media|framercanvas\.com)$/i.test(host);
}

// Matches absolute (and protocol-relative) asset URLs, plain or JSON-escaped (https:\/\/host\/path).
const HOSTS_SRC = [
  '(?:[a-z0-9-]+\\.)*framerusercontent\\.com',
  '(?:[a-z0-9-]+\\.)*framerstatic\\.com',
  '(?:www\\.)?framer\\.com',
  'fonts\\.gstatic\\.com',
  'fonts\\.googleapis\\.com',
  'esm\\.sh',
  'ga\\.jspm\\.io',
  'cdn\\.jsdelivr\\.net',
  'unpkg\\.com',
].join('|');
export const assetUrlRe = () =>
  new RegExp(String.raw`(https?:)?(\/\/|\\\/\\\/)(${HOSTS_SRC})(?![a-z0-9.-])((?:\\\/|[^\s"'<>()\[\]{},\x60\\])*)`, 'gi');

const ENTITY_RE = /&(?:quot|#0*34|#x0*22|#0*39|#x0*27|apos|lt|gt);/i;

/**
 * Parse one regex match of assetUrlRe into a normalised URL plus the bits needed
 * to write it back in the same (plain or escaped) form.
 */
export function parseAssetMatch(m) {
  const [, , slashes, host, rawPath] = m;
  const escaped = slashes !== '//';
  let p = rawPath;
  let leftover = '';
  const ent = p.search(ENTITY_RE);
  if (ent >= 0) { leftover = p.slice(ent); p = p.slice(0, ent); }
  let plain = p.replace(/\\\//g, '/');
  const junk = (plain.match(/[$;:.!*]+$/) || [''])[0];
  if (junk) { plain = plain.slice(0, -junk.length); leftover = junk + leftover; }
  let url;
  try { url = new URL('https://' + host.toLowerCase() + (plain.startsWith('/') || plain === '' || plain.startsWith('?') || plain.startsWith('#') ? plain : '/' + plain)); } catch { return null; }
  const prefixLike = /\$/.test(rawPath) || url.pathname === '/' || url.pathname.endsWith('/');
  return { url, escaped, leftover, prefixLike };
}

/** Key used to dedupe downloads: origin + path (+ query only for query-significant hosts). */
export function assetKey(u) {
  const keepQuery = QUERY_SIGNIFICANT.has(u.hostname) && u.search;
  return u.origin + u.pathname + (keepQuery ? u.search : '');
}
export function fetchUrlForKey(key) { return key; }

const KNOWN_EXT = new Set([
  '.mjs', '.js', '.cjs', '.json', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.webm', '.mov', '.m4v', '.mp3', '.wav', '.ogg', '.wasm',
  '.riv', '.lottie', '.pdf', '.txt', '.xml', '.html', '.glb', '.gltf', '.bin', '.map',
]);
const CT_EXT = [
  [/javascript|ecmascript/, '.mjs'], [/text\/css/, '.css'], [/json/, '.json'], [/svg/, '.svg'],
  [/image\/png/, '.png'], [/image\/jpe?g/, '.jpg'], [/image\/webp/, '.webp'], [/image\/avif/, '.avif'],
  [/image\/gif/, '.gif'], [/icon/, '.ico'], [/font\/woff2|woff2/, '.woff2'], [/font\/woff|woff/, '.woff'],
  [/font\/ttf|truetype/, '.ttf'], [/font\/otf|opentype/, '.otf'], [/video\/mp4/, '.mp4'], [/video\/webm/, '.webm'],
  [/text\/html/, '.html'], [/application\/wasm/, '.wasm'], [/text\/plain/, '.txt'],
];
export function extFromContentType(ct = '') {
  ct = ct.toLowerCase();
  for (const [re, ext] of CT_EXT) if (re.test(ct)) return ext;
  return '';
}

/**
 * Local location for a downloaded asset.
 * urlPath: what pages reference (percent-encoded), diskPath: where the bytes go.
 * An extension is appended when the original path has none the static host can map to a
 * MIME type (e.g. framer.com/m/Foo.js@abc → Foo.js@abc.mjs), so module scripts still load.
 */
export function localLocation(u, contentType) {
  let p = u.pathname;
  if (p.endsWith('/')) p += 'index';
  let suffix = '';
  if (QUERY_SIGNIFICANT.has(u.hostname) && u.search) {
    suffix += '__q' + crypto.createHash('sha1').update(u.search).digest('hex').slice(0, 10);
  }
  const ext = path.posix.extname(p.split('/').pop()).toLowerCase();
  if (suffix || !KNOWN_EXT.has(ext)) {
    const ctExt = extFromContentType(contentType);
    if (ctExt) suffix += ctExt;
    else if (suffix && KNOWN_EXT.has(ext)) suffix += ext;
  }
  const urlPath = `/_ext/${u.hostname}${p}${suffix}`;
  let decoded;
  try { decoded = decodeURIComponent(p); } catch { decoded = p; }
  const diskPath = path.join(OUT_DIR, '_ext', u.hostname, ...decoded.split('/').filter(Boolean)) + suffix;
  return { urlPath, diskPath };
}

/** The local path a browser would naturally compute for this URL (no suffix logic). */
export function naiveLocalPath(u) {
  return `/_ext/${u.hostname}${u.pathname}`;
}

// ---------------------------------------------------------------------------
// Relative / root-relative module and CSS references.
const REF_EXT = '(?:mjs|js|cjs|json|css|wasm|svg|png|jpe?g|webp|gif|avif|woff2?|ttf|otf|mp4|webm|riv|lottie)';
const JS_REL_STRING = new RegExp(String.raw`(["'\x60])(\.{1,2}\/[^"'\x60\s\\]+?\.${REF_EXT}(?:@[^"'\x60\s\\]*)?)\1`, 'g');
const JS_IMPORT_SPEC = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"'\s\\]+|\/[^"'\s\\/][^"'\s\\]*)\2/g;
const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(["'])([^"']+)\3/g;

/**
 * Find references inside a downloaded asset that are relative to that asset's own URL.
 * Returns [{start, end, spec, resolved}] (start/end cover the specifier text only).
 */
export function findRelativeRefs(text, fileUrl, kind) {
  const out = [];
  const base = new URL(fileUrl);
  const push = (spec, start) => {
    if (/^(data:|blob:|https?:|\/\/|#|about:)/i.test(spec)) return;
    if (spec.startsWith('/') && !(kind === 'js' && isModuleCdn(base.hostname))) return; // site-root paths stay
    let resolved;
    try { resolved = new URL(spec, base); } catch { return; }
    if (!isAssetUrl(resolved)) return;
    out.push({ start, end: start + spec.length, spec, resolved });
  };
  if (kind === 'js') {
    const seen = new Set();
    for (const m of text.matchAll(JS_IMPORT_SPEC)) {
      const start = m.index + m[1].length + 1;
      seen.add(start);
      push(m[3], start);
    }
    for (const m of text.matchAll(JS_REL_STRING)) {
      const start = m.index + 1;
      if (!seen.has(start)) push(m[2], start);
    }
  } else if (kind === 'css') {
    for (const m of text.matchAll(CSS_URL)) {
      const spec = (m[2] ?? m[4]).trim();
      const start = m.index + m[0].indexOf(spec);
      push(spec, start);
    }
  }
  return out;
}

export function textKind(diskPathOrUrl, contentType = '') {
  const ext = path.extname(String(diskPathOrUrl).split(/[?#]/)[0]).toLowerCase();
  if (['.mjs', '.js', '.cjs'].includes(ext) || /javascript/.test(contentType)) return 'js';
  if (ext === '.css' || /text\/css/.test(contentType)) return 'css';
  if (ext === '.json' || /json/.test(contentType)) return 'json';
  if (ext === '.svg' || /svg/.test(contentType)) return 'svg';
  if (ext === '.html' || /text\/html/.test(contentType)) return 'html';
  return null;
}

// ---------------------------------------------------------------------------
export async function fetchWithRetry(url, { tries = 4, timeoutMs = 90_000, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(mapOrigin(url), {
        headers: { 'user-agent': UA, accept: '*/*', 'accept-language': 'pt-PT,pt;q=0.9,en;q=0.8', ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = Buffer.from(await res.arrayBuffer());
      if (res.status >= 500 || res.status === 429) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status, body });
      return { status: res.status, headers: res.headers, body, finalUrl: res.url };
    } catch (e) {
      lastErr = e;
      if (e.status && e.status < 500 && e.status !== 429) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  if (lastErr?.status) return { status: lastErr.status, headers: new Headers(), body: lastErr.body ?? Buffer.alloc(0) };
  throw lastErr;
}

export async function writeFileSafe(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

/** Map a site page path ("/", "/sobre", "/a/b") to the html file that serves it. */
export function pageFile(pagePath) {
  const clean = pagePath.replace(/\/+$/, '');
  if (clean === '') return 'index.html';
  return clean.replace(/^\//, '') + '.html';
}

export function normalizePageUrl(href, base = SITE_ORIGIN + '/') {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !SITE_HOSTS.has(u.hostname)) return null;
  if (/\.(pdf|png|jpe?g|webp|gif|svg|zip|mp4|xml|txt|json)$/i.test(u.pathname)) return null;
  let p = u.pathname.replace(/\/+$/, '') || '/';
  return p;
}

// ---------------------------------------------------------------------------
// Browser helpers shared by crawl + verify.
export async function launchBrowser() {
  const opts = {};
  if (!TEST_MODE && process.env.HTTPS_PROXY && !process.env.NO_BROWSER_PROXY) {
    opts.proxy = { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' };
  }
  return chromium.launch(opts);
}

export async function newContext(browser, vp) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: !!vp.isMobile,
    hasTouch: !!vp.hasTouch,
    userAgent: vp.isMobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      : UA,
    locale: 'pt-PT',
    ignoreHTTPSErrors: false,
  });
  if (TEST_MODE) {
    // Serve mapped origins from the mock server; block every other external host.
    await ctx.route(/^https?:\/\//, async (route) => {
      const url = route.request().url();
      const mapped = mapOrigin(url);
      if (mapped === url) return route.abort('blockedbyclient');
      try {
        const res = await fetch(mapped, { method: route.request().method(), headers: { 'user-agent': UA } });
        const body = Buffer.from(await res.arrayBuffer());
        return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body });
      } catch { return route.abort('failed'); }
    });
  }
  return ctx;
}

/** Scroll to the bottom in small steps so lazy content and appear animations trigger. */
export async function slowScroll(page, { stepRatio = 0.4, delay = 220, maxSteps = 400 } = {}) {
  await page.evaluate(async ({ stepRatio, delay, maxSteps }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let y = 0;
    for (let i = 0; i < maxSteps; i++) {
      const max = document.documentElement.scrollHeight - innerHeight;
      if (y >= max) { await sleep(800); if (document.documentElement.scrollHeight - innerHeight <= y) break; }
      y = Math.min(y + Math.round(innerHeight * stepRatio), document.documentElement.scrollHeight - innerHeight);
      window.scrollTo(0, y);
      await sleep(delay);
    }
  }, { stepRatio, delay, maxSteps });
  await page.waitForTimeout(1500);
}

export async function settle(page, ms = 8000) {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
}
