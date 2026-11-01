// Step 2: save the original server HTML, mirror every Framer-hosted asset into /_ext/<host>/<path>,
// follow references found inside downloaded files until nothing new turns up, then rewrite URLs.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SITE_ORIGIN, OUT_DIR, REPORT_DIR, WORK_DIR, TEST_MODE, isAssetUrl, assetUrlRe, parseAssetMatch, assetKey,
  localLocation, naiveLocalPath, findRelativeRefs, textKind, fetchWithRetry, writeFileSafe, readJson, pageFile,
} from './lib.mjs';

const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const crawl = await readJson(path.join(WORK_DIR, 'crawl.json'), null);
if (!crawl) { console.error('Run crawl.mjs first (no .work/crawl.json).'); process.exit(1); }

await fs.rm(OUT_DIR, { recursive: true, force: true });
await fs.mkdir(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------- pages
const pages = []; // {path, file, raw}
const htmlHeaders = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
for (const p of crawl.pages) {
  const res = await fetchWithRetry(SITE_ORIGIN + p, { headers: htmlHeaders });
  if (res.status !== 200) { console.warn(`page ${p}: HTTP ${res.status}`); continue; }
  pages.push({ path: p, file: pageFile(p), raw: res.body.toString('utf8') });
}
{
  const res = await fetchWithRetry(SITE_ORIGIN + '/__static-export-404-probe', { headers: htmlHeaders, tries: 2 });
  const body = res.body.toString('utf8');
  if (/<html/i.test(body)) pages.push({ path: '/404', file: '404.html', raw: body, is404: true });
}
const extras = {};
for (const f of ['robots.txt', 'sitemap.xml']) {
  try {
    const res = await fetchWithRetry(`${SITE_ORIGIN}/${f}`, { tries: 2 });
    if (res.status === 200) extras[f] = res.body;
  } catch {}
}

// ---------------------------------------------------------------------------- assets
const assets = new Map(); // key -> entry
const queue = [];
function enqueue(u, from) {
  if (!isAssetUrl(u)) return;
  const key = assetKey(u);
  if (assets.has(key)) return;
  assets.set(key, { key, from });
  queue.push(key);
}
function scanText(text, fileUrl, kind) {
  for (const m of text.matchAll(assetUrlRe())) {
    const parsed = parseAssetMatch(m);
    if (parsed && !parsed.prefixLike) enqueue(parsed.url, fileUrl);
  }
  if (kind === 'js' || kind === 'css') {
    for (const ref of findRelativeRefs(text, fileUrl, kind)) enqueue(ref.resolved, fileUrl);
  }
}

for (const r of crawl.requests) {
  try { const u = new URL(r.url); if (isAssetUrl(u)) enqueue(u, 'crawl'); } catch {}
}
for (const pg of pages) scanText(pg.raw, SITE_ORIGIN + pg.path, 'html');

let done = 0;
async function download(key) {
  const e = assets.get(key);
  try {
    const res = await fetchWithRetry(key);
    e.status = res.status;
    if (res.status !== 200) { e.failed = `HTTP ${res.status}`; return; }
    e.contentType = res.headers.get('content-type') || '';
    const u = new URL(key);
    Object.assign(e, localLocation(u, e.contentType));
    e.base = !TEST_MODE && res.finalUrl ? res.finalUrl : key;
    e.bytes = res.body.length;
    await writeFileSafe(e.diskPath, res.body);
    e.ok = true;
    e.kind = textKind(e.diskPath, e.contentType);
    if (e.kind) scanText(res.body.toString('utf8'), e.base, e.kind);
  } catch (err) {
    e.failed = err.message || String(err);
  } finally {
    if (++done % 25 === 0) console.log(`  downloaded ${done}, queued ${queue.length}`);
  }
}
await new Promise((resolve) => {
  let active = 0;
  const pump = () => {
    while (active < CONCURRENCY && queue.length) {
      const key = queue.shift();
      active++;
      download(key).finally(() => { active--; pump(); });
    }
    if (!active && !queue.length) resolve();
  };
  pump();
});

// ---------------------------------------------------------------------------- rewriting
function localFor(u) {
  const e = assets.get(assetKey(u));
  if (e?.ok) return e.urlPath;
  if (e?.failed) return null; // keep remote; listed in _failed.txt
  return naiveLocalPath(u);
}

function rewriteAbsolute(text) {
  return text.replace(assetUrlRe(), (full, scheme, slashes, host, rawPath) => {
    const parsed = parseAssetMatch([full, scheme, slashes, host, rawPath]);
    if (!parsed || !isAssetUrl(parsed.url)) return full;
    let local = localFor(parsed.url);
    if (local === null) return full;
    const bare = rawPath === '' || /^[$;:.!*]/.test(rawPath);
    if (bare) local = `/_ext/${parsed.url.hostname}`;
    local += parsed.url.hash;
    if (parsed.escaped) local = local.replace(/\//g, '\\/');
    return local + parsed.leftover;
  });
}

function rewriteRelative(text, entry) {
  const refs = findRelativeRefs(text, entry.base, entry.kind).sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const ref of refs) {
    const target = assets.get(assetKey(ref.resolved));
    if (!target?.ok) continue;
    const browserResolves = new URL(ref.spec, 'http://local' + entry.urlPath).pathname;
    if (browserResolves === target.urlPath) continue; // relative path already correct
    out += text.slice(pos, ref.start) + target.urlPath + ref.resolved.hash;
    pos = ref.end;
  }
  return out + text.slice(pos);
}

const SITE_LINK_RE = /https?:(\/\/|\\\/\\\/)(?:www\.)?skylineodivelas\.pt(?![a-z0-9.-])(\\?\/)?/gi;
function rewriteSiteLinks(text, isHtml) {
  return text.replace(SITE_LINK_RE, (full, slashes, tail) => {
    if (tail) return tail;
    if (!isHtml) return full; // bare origin in scripts is config (e.g. canonical base), keep it absolute
    return slashes === '//' ? '/' : '\\/';
  });
}

const notes = { removed: [], forms: [], leftovers: {} };
function transformHtml(raw, pg) {
  let html = raw;
  const note = (what) => notes.removed.push(`${pg.file}: ${what}`);
  html = html.replace(/<!--[\s\S]*?-->/g, (c) => (/made in framer/i.test(c) ? (note('"Made in Framer" comment'), '') : c));
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (tag, attrs, body) => {
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']+)/i) || [])[1] || '';
    const type = (attrs.match(/\btype\s*=\s*["']([^"']+)/i) || [])[1] || '';
    if (/events\.framer\.com/i.test(src)) { note('Framer analytics script'); return ''; }
    if (/framer\.com\/edit\b/i.test(src)) { note('Framer editor bar script'); return ''; }
    if (!src && !/json|framer\//i.test(type) && /framer\.com\/edit\b|editorbar/i.test(body)) { note('Framer editor bar loader'); return ''; }
    return tag;
  });
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)/i) || [])[1] || '';
    const rel = ((tag.match(/\brel\s*=\s*["']([^"']+)/i) || [])[1] || '').toLowerCase();
    if (/events\.framer\.com|framer\.com\/edit\b/i.test(href)) { note(`link to ${href}`); return ''; }
    if (/preconnect|dns-prefetch/.test(rel)) {
      try { const u = new URL(href, SITE_ORIGIN); if (u.hostname !== new URL(SITE_ORIGIN).hostname) { note(`${rel} ${href}`); return ''; } } catch {}
    }
    return tag;
  });
  html = html.replace(/\s+integrity\s*=\s*"[^"]*"/gi, '');

  // Keep canonical / og:url absolute (the domain stays the same after the move).
  const kept = [];
  html = html.replace(/<link\b[^>]*rel=["']canonical["'][^>]*>|<meta\b[^>]*(?:og:url|twitter:url)[^>]*>/gi, (t) => {
    kept.push(t);
    return `\u0000KEEP${kept.length - 1}\u0000`;
  });
  html = rewriteAbsolute(html);
  html = rewriteSiteLinks(html, true);
  html = html.replace(/\u0000KEEP(\d+)\u0000/g, (_, i) => kept[+i]);
  // Social preview images need an absolute URL.
  html = html.replace(/<meta\b[^>]*(?:og:image|twitter:image)[^>]*>/gi, (t) =>
    t.replace(/content="\/_ext\//, `content="${SITE_ORIGIN}/_ext/`));

  const shim =
    '<script data-static-export>(()=>{const O=URL;if(O.__staticExport)return;' +
    'const fix=(u,b)=>b===undefined&&typeof u==="string"&&u.startsWith("/_ext/")?[u,location.href]:b===undefined?[u]:[u,b];' +
    'function U(u,b){return Reflect.construct(O,fix(u,b),new.target||U)}' +
    'U.prototype=O.prototype;Object.setPrototypeOf(U,O);U.__staticExport=1;' +
    'if(O.canParse)U.canParse=(u,b)=>O.canParse(...fix(u,b));if(O.parse)U.parse=(u,b)=>O.parse(...fix(u,b));' +
    'window.URL=U})()</script>';
  const badgeCss = '<style data-static-export>#__framer-badge-container,.__framer-badge{display:none!important}</style>';
  html = html.replace(/<head\b[^>]*>/i, (h) => h + shim);
  html = html.replace(/<\/head>/i, badgeCss + '</head>');
  if (/__framer-badge/.test(raw)) note('"Made in Framer" badge hidden');
  return html;
}

for (const e of assets.values()) {
  if (!e.ok || !e.kind) continue;
  let text = await fs.readFile(e.diskPath, 'utf8');
  const before = text;
  if (e.kind === 'js' || e.kind === 'css') text = rewriteRelative(text, e);
  text = rewriteAbsolute(text);
  if (e.kind !== 'css') text = rewriteSiteLinks(text, false);
  if (text !== before) await fs.writeFile(e.diskPath, text);
}
for (const pg of pages) {
  await writeFileSafe(path.join(OUT_DIR, pg.file), transformHtml(pg.raw, pg));
}
for (const [f, body] of Object.entries(extras)) await writeFileSafe(path.join(OUT_DIR, f), body);

// ---------------------------------------------------------------------------- reporting
const failed = [...assets.values()].filter((e) => e.failed);
await fs.writeFile(
  path.join(OUT_DIR, '_failed.txt'),
  failed.length
    ? failed.map((e) => `${e.failed}\t${e.key}\t(found in ${e.from})`).join('\n') + '\n'
    : '# nothing failed to download\n',
);

// Static self-check of the output: anything still pointing at Framer, and form endpoints.
const leftoverRe = /(?:https?:)?(?:\/\/|\\\/\\\/)(?:[a-z0-9-]+\.)*(?:framerusercontent\.com|framerstatic\.com|framer\.com|framer\.website|framer\.app)[^\s"'<>)\\]*/gi;
const formRe = /api\.framer\.com\/forms|\/forms\/v\d+\/forms|<form\b/gi;
async function* walk(dir) {
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(p); else yield p;
  }
}
for await (const f of walk(OUT_DIR)) {
  if (!textKind(f)) continue;
  const text = await fs.readFile(f, 'utf8');
  const rel = path.relative(OUT_DIR, f);
  const left = [...new Set(text.match(leftoverRe) || [])];
  if (left.length) notes.leftovers[rel] = left.slice(0, 40);
  const forms = [...new Set((text.match(formRe) || []).map((s) => s.toLowerCase()))];
  if (forms.length) notes.forms.push({ file: rel, matches: forms });
}

const ok = [...assets.values()].filter((e) => e.ok);
const summary = {
  site: SITE_ORIGIN,
  exportedAt: new Date().toISOString(),
  outDir: OUT_DIR,
  pages: pages.map((p) => ({ path: p.path, file: p.file })),
  assets: { downloaded: ok.length, failed: failed.length, bytes: ok.reduce((a, e) => a + e.bytes, 0) },
  byHost: Object.fromEntries(
    [...ok.reduce((m, e) => m.set(new URL(e.key).hostname, (m.get(new URL(e.key).hostname) || 0) + 1), new Map())],
  ),
  crawlFormsSeen: crawl.forms,
  ...notes,
  thirdPartyRequestsInCrawl: [...new Set(crawl.requests.map((r) => { try { return new URL(r.url).hostname; } catch { return null; } }))]
    .filter((h) => h && !h.endsWith('skylineodivelas.pt')),
};
await writeFileSafe(path.join(REPORT_DIR, 'export-summary.json'), JSON.stringify(summary, null, 2));
await writeFileSafe(path.join(WORK_DIR, 'assets.json'), JSON.stringify([...assets.values()], null, 2));
console.log(`pages: ${pages.map((p) => p.file).join(', ')}`);
console.log(`assets: ${ok.length} downloaded (${(summary.assets.bytes / 1e6).toFixed(1)} MB), ${failed.length} failed`);
console.log(`leftover Framer references in ${Object.keys(notes.leftovers).length} file(s); form hints in ${notes.forms.length} file(s)`);
