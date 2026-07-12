// OS9 redesign screenshot sweep. Shoots reader + admin pages at desktop + mobile.
// Usage: BASE_URL=http://localhost:3300 ADMIN_PASSWORD=dev node scripts/os9-screenshots.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire('/home/jonny/apps/dailey-photos/')('@playwright/test');
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL || 'http://localhost:3300';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dev';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'superpowers', 'specs', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const widths = [{ tag: 'desktop', w: 1440, h: 960 }, { tag: 'mobile', w: 390, h: 844 }];

// discover a real post slug + a category
const home = await (await fetch(BASE + '/')).text();
const slug = (home.match(/\/post\/([a-z0-9-]+)/) || [])[1] || 'introducing-dailey-os-2';
const cat = (home.match(/\/\?category=([a-z0-9-]+)/) || [])[1];

const readerPages = [
  ['home', '/'],
  ['post', '/post/' + slug],
  ['category', cat ? '/?category=' + cat : '/'],
  ['404', '/this-page-does-not-exist'],
];

const browser = await chromium.launch();
for (const { tag, w, h } of widths) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  // skip the boot splash so screenshots show content
  await page.addInitScript(() => { try { sessionStorage.setItem('os9booted', '1'); } catch (e) {} });
  for (const [name, url] of readerPages) {
    const resp = await page.goto(BASE + url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `${name}-${tag}.png`), fullPage: name !== '404' });
    // guard: no horizontal scroll
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    console.log(`${name}-${tag}: ${resp.status()} overflow=${overflow}px`);
  }
  // admin: login then dashboard + editor
  await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(OUT, `admin-login-${tag}.png`) });
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/admin', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `admin-dashboard-${tag}.png`), fullPage: true });
  await page.goto(BASE + '/admin/posts/new', { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(OUT, `admin-editor-${tag}.png`), fullPage: true });
  console.log(`admin-${tag}: shot`);
  await ctx.close();
}
await browser.close();
console.log('done ->', OUT);
