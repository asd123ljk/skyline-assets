// Step 1: load every page of the live site at 3 widths, scroll slowly, hover, record every request.
import path from 'node:path';
import {
  SITE_ORIGIN, WORK_DIR, VIEWPORTS, launchBrowser, newContext, slowScroll, settle,
  normalizePageUrl, fetchWithRetry, writeFileSafe,
} from './lib.mjs';

const MAX_PAGES = Number(process.env.MAX_PAGES || 60);

async function sitemapPages() {
  const found = [];
  try {
    const res = await fetchWithRetry(SITE_ORIGIN + '/sitemap.xml', { tries: 2 });
    if (res.status === 200) {
      for (const m of res.body.toString('utf8').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
        const p = normalizePageUrl(m[1]);
        if (p) found.push(p);
      }
    }
  } catch (e) { console.warn('sitemap fetch failed:', e.message); }
  return found;
}

async function crawlPage(browser, pagePath, vp, log) {
  const ctx = await newContext(browser, vp);
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push({ url: r.url(), type: r.resourceType() }));
  page.on('response', (r) => { const q = requests.findLast((x) => x.url === r.url() && x.status === undefined); if (q) q.status = r.status(); });
  page.on('requestfailed', (r) => { const q = requests.findLast((x) => x.url === r.url()); if (q) q.failure = r.failure()?.errorText; });
  const url = SITE_ORIGIN + (pagePath === '/' ? '/' : pagePath);
  let links = [];
  let forms = 0;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
    await settle(page);
    await slowScroll(page);
    await settle(page, 5000);
    // Hover interactive elements so hover variants load their assets.
    const handles = await page.$$('a, button, [role="button"], [data-highlight="true"]');
    for (const h of handles.slice(0, 60)) {
      try {
        await h.scrollIntoViewIfNeeded({ timeout: 1500 });
        await h.hover({ timeout: 1500, force: true });
        await page.waitForTimeout(120);
      } catch {}
    }
    await page.mouse.move(1, 1);
    // Open menus (phone/tablet nav) so overlay content renders.
    for (const sel of ['[data-framer-name*="menu" i]', '[data-framer-name*="burger" i]', '[aria-label*="menu" i]']) {
      for (const h of (await page.$$(sel)).slice(0, 3)) {
        try {
          if (await h.evaluate((e) => !!e.closest('a[href]'))) continue;
          await h.click({ timeout: 1500, force: true }); await page.waitForTimeout(800); await h.click({ timeout: 1500, force: true }); } catch {}
      }
    }
    await settle(page, 5000);
    links = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
    forms = await page.$$eval('form', (f) => f.length);
  } catch (e) {
    log.errors.push(`${vp.name} ${pagePath}: ${e.message}`);
  }
  await ctx.close();
  return { requests, links, forms };
}

const browser = await launchBrowser();
const queue = ['/', ...(await sitemapPages())];
const seen = new Set();
const result = { site: SITE_ORIGIN, crawledAt: new Date().toISOString(), pages: [], requests: [], externalLinks: [], forms: {}, errors: [] };
const allReq = new Map();
const extLinks = new Set();

while (queue.length && seen.size < MAX_PAGES) {
  const p = queue.shift();
  if (seen.has(p)) continue;
  seen.add(p);
  result.pages.push(p);
  for (const vp of VIEWPORTS) {
    console.log(`crawl ${vp.name.padEnd(7)} ${p}`);
    const { requests, links, forms } = await crawlPage(browser, p, vp, result);
    for (const r of requests) {
      const prev = allReq.get(r.url);
      if (!prev) allReq.set(r.url, { ...r, seenAt: [`${vp.name} ${p}`] });
      else if (prev.seenAt.length < 6) prev.seenAt.push(`${vp.name} ${p}`);
    }
    if (forms) result.forms[`${vp.name} ${p}`] = forms;
    for (const l of links) {
      const np = normalizePageUrl(l);
      if (np && !seen.has(np)) queue.push(np);
      else if (!np) extLinks.add(l);
    }
  }
}
await browser.close();

result.requests = [...allReq.values()];
result.externalLinks = [...extLinks].sort();
await writeFileSafe(path.join(WORK_DIR, 'crawl.json'), JSON.stringify(result, null, 2));
console.log(`pages: ${result.pages.join(', ')}`);
console.log(`requests recorded: ${result.requests.length}, errors: ${result.errors.length}`);
if (result.errors.length) console.log(result.errors.join('\n'));
