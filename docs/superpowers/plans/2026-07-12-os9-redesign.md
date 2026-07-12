# Mac OS 9 (Platinum) Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin every Dailey Weekly page (reader + admin) in the Mac OS 9 Platinum language per the approved spec and mockup, with zero behavior change, then deploy to the DOS project `dailey-weekly`.

**Architecture:** All markup comes from one `layout()` function (`server.js:728`) plus per-page content builders. The reskin = (1) new static theme assets in `public/`, (2) rewrite `layout()` chrome (menu bar, desktop, footer), (3) re-wrap each content builder's output in window chrome. No route, DB, session, RSS, or upload logic changes.

**Tech Stack:** Express template strings (no build step), one static CSS file, self-hosted ChicagoFLF font, ~30 lines vanilla JS, Playwright (repo-external) for screenshot verification.

**Canonical visual reference:** `docs/superpowers/specs/os9-mockup.html` (approved by Jonny 2026-07-12). Its CSS classes (`.menubar`, `.window`, `.titlebar`, `.ttl`, `.doc`, `.rows/.row`, `.rail`, `.chip`, `.alert`, `.readmore`, `.liststrip`, `.cols`, `.sidewin`, `.screen-label` [mockup-only, drop]) are the starting theme — copy, then extend.

## Global Constraints

- No behavior changes: every route returns the same data/status codes; RSS byte-structure unchanged (only surrounding HTML pages change)
- No build step, no framework, no CDN requests; all assets self-hosted from `public/`
- Body text: Verdana 13–14px desktop / 16px mobile, near-black on white; visible `:focus-visible` states everywhere
- <700px: full-width windows, condensed menu bar, no horizontal scroll
- Verification is visual (Playwright screenshots) + functional e2e (admin login → post lifecycle) — the repo has no unit-test framework and this work is presentation-only

---

### Task 1: Theme assets + static serving

**Files:**
- Create: `public/os9.css` (from mockup `<style>`, minus `.screen-label`, plus `@font-face`, splash, admin form styles)
- Create: `public/os9.js` (boot splash)
- Create: `public/fonts/ChicagoFLF.woff2` (or `.ttf` if woff2 tooling unavailable)
- Modify: `server.js:105` area (static middleware)

**Interfaces produced:** CSS classes listed above + `.splash`, `.field-row`, `.os-input`, `.os-select`, `.os-textarea`, `.toolbar` for later tasks; `layout()` will emit `<link rel="stylesheet" href="/os9.css">` and `<script src="/os9.js" defer></script>`.

- [ ] Extract the mockup's `<style>` into `public/os9.css`; delete `.screen-label`; add:

```css
@font-face {
  font-family: "ChicagoFLF";
  src: url("/fonts/ChicagoFLF.woff2") format("woff2");
  font-display: swap;
}
/* prepend ChicagoFLF to the display stack */
:root { --chicago: "ChicagoFLF", "Charcoal", "Geneva", "Verdana", sans-serif; }

/* Boot splash */
.splash { position: fixed; inset: 0; z-index: 999; display: grid; place-items: center;
  background: var(--desktop); cursor: pointer; }
.splash .card { background: var(--plat); border: 2px solid #000; border-radius: 8px;
  box-shadow: inset 1px 1px 0 #fff, inset -2px -2px 0 #aaa, 4px 5px 0 rgba(0,0,0,.35);
  padding: 28px 40px; text-align: center; font-family: var(--chicago); font-weight: bold; }
.splash .bar { width: 220px; height: 12px; margin: 16px auto 0; border: 1px solid #000;
  background: #fff; box-shadow: inset 1px 1px 0 #999; overflow: hidden; }
.splash .bar i { display: block; height: 100%; width: 0;
  background: repeating-linear-gradient(90deg, #7e9fce 0 6px, #9db8dd 6px 12px);
  animation: boot 1.2s ease-out forwards; }
@keyframes boot { to { width: 100%; } }
@media (prefers-reduced-motion: reduce) { .splash { display: none; } }

/* Admin form controls */
.field-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.field-row label { font-family: var(--chicago); font-weight: bold; font-size: 12px; }
.os-input, .os-select, .os-textarea { font-family: var(--body); font-size: 13px;
  padding: 5px 7px; background: #fff; border: 1px solid #000; box-shadow: inset 1px 1px 0 #999; }
.os-textarea { font-family: "Courier New", monospace; min-height: 320px; line-height: 1.5; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; padding: 8px; border-bottom: 1px solid #999;
  background: #e8e8e8; box-shadow: inset 0 1px 0 #fff; }
```

- [ ] Create `public/os9.js`:

```js
(function () {
  try {
    if (sessionStorage.getItem('os9booted')) return;
    sessionStorage.setItem('os9booted', '1');
  } catch (e) { return; }
  var el = document.createElement('div');
  el.className = 'splash';
  el.innerHTML = '<div class="card">Welcome to Dailey Weekly.<div class="bar"><i></i></div></div>';
  el.addEventListener('click', function () { el.remove(); });
  document.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 1600);
  });
})();
```

- [ ] Fetch ChicagoFLF (freeware): try `curl -L` from a GitHub mirror of ChicagoFLF.ttf; convert with `python3 -m fontTools.ttLib.woff2 compress` if fonttools+brotli available, else ship the `.ttf` and adjust `@font-face` `src`/`format`. If no mirror works, keep the fallback stack and note it — DO NOT block the task.
- [ ] Add static serving in `server.js` next to line 105 (`/media` static): `app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));` (after the `/media` mount so its longer cache stays authoritative).
- [ ] Verify locally: `docker compose up -d db`, then run with dev env (see Task 7 env block); `curl -sI localhost:3000/os9.css | head -3` → `200`, `curl -sI localhost:3000/os9.js` → `200`.
- [ ] Commit: `feat(theme): OS9 Platinum theme assets + static serving`

### Task 2: `layout()` → menu bar, desktop, footer

**Files:** Modify `server.js:728-~830` (the `layout()` function: `<head>` block, inline `<style>` removal, header/nav, footer)

**Interfaces produced:** `layout()` keeps its exact signature `layout(title, content, options)`; all content builders continue returning HTML strings that it wraps. Public nav = menu bar items Home / Categories (dropdown of existing categories, already available where the current header builds its nav) / RSS / About; admin nav (when `options.isAdmin`) = Posts / Categories / Media / View Site / Logout as menu items.

- [ ] Replace the inline `<style>…</style>` with `<link rel="stylesheet" href="/os9.css">` + `<script src="/os9.js" defer></script>` (splash script only when NOT admin).
- [ ] Replace the current header markup (logo + nav, and the `isAdmin` branch at ~1701 pattern) with the mockup's `.menubar`: rainbow `.mark`, `.item.title` "Dailey Weekly" (or "Blog Admin"), nav items as `.item` links, `.spacer`, static `.clock` showing the render date via existing date formatting helpers. Categories dropdown: CSS-only — `.item.has-menu:hover .dropdown { display:block }`, dropdown styled as a bevel window listing category links.
- [ ] Wrap page content region in `<div class="desk">…</div>`; footer becomes `.deskfoot` one-liner (© Dailey LLC · RSS link).
- [ ] Verify: homepage + `/admin/login` render with menu bar and desktop background; no inline styles remain (`grep -c "<style" server.js` → 0).
- [ ] Commit: `feat(theme): Platinum layout shell (menu bar, desktop, footer)`

### Task 3: Homepage + reader lists in window chrome

**Files:** Modify `server.js` content builders: `renderFeaturedPost` (:691), `renderPostRow` (:708), the homepage route's composition, `renderCategoryPill` (:665), `renderTagList` (:673), `renderMeta` (:678), subscribe block, sidebar (About/Categories/Archive)

- [ ] `renderFeaturedPost` → mockup Featured window (`.window` > `.titlebar` "Featured" > `.win-body` > `.doc` with `.meta`, `h1`, excerpt, `.readmore.default`).
- [ ] Post list → `.window` "Recent Posts" with `.liststrip` (“N items, updated weekly” — N from the existing post count) + `.listwrap` (`.rows` of `.row` items: `.ico`, `.name` link + excerpt small, `.date`) + decorative `.rail`.
- [ ] `renderCategoryPill` → `.chip` with a stable class per slug (map known slugs to `eng/product/company/changelog`; unknown slugs hash to one of the five label colors so new categories still get a chip).
- [ ] Sidebar boxes → `.window.sidewin` (About, Categories, Archive); subscribe → `.alert` dialog markup from the mockup (form action/behavior unchanged).
- [ ] Category/tag/archive listing pages reuse the same list window (they flow through the same builders).
- [ ] Verify: homepage matches mockup Screen 1 at 1440px; at 390px windows are full-width, no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth` via Playwright eval).
- [ ] Commit: `feat(theme): homepage + list views as Platinum windows`

### Task 4: Post page

**Files:** Modify `server.js` post route content builder (the single-post HTML near `renderMeta`/`renderMarkdown` usage)

- [ ] Post → one `.window`: `.titlebar` with post title in `.ttl`; `.liststrip` carrying category chip · date · author · read time; `.win-body > .doc` wrapping the existing `renderMarkdown` output.
- [ ] Markdown media: `figure`/img output gets `.figframe` styling via CSS descendant rules (`.doc figure { …bevel… }`) — no change to `renderMarkdown` itself unless class hooks are needed.
- [ ] "Back to all posts" `.readmore` at the document end; prev/next (if present) as bevel buttons.
- [ ] Verify: longest real post renders readably (Verdana, 62ch measure), images beveled, at both widths.
- [ ] Commit: `feat(theme): post page as document window`

### Task 5: 404 bomb + error states

**Files:** Modify `server.js` 404/error handlers

- [ ] 404 → centered `.alert` with `.bomb` icon: title "Sorry, a system error occurred." body “That page could not be found.” + `Error code: 404` + `.readmore.default` "Restart" → `/`. Keep HTTP 404 status.
- [ ] Any 500 handler present gets the same dialog with code 500. Status codes unchanged.
- [ ] Verify: `curl -s -o /dev/null -w "%{http_code}" localhost:3000/nope` → 404; page shows bomb dialog.
- [ ] Commit: `feat(theme): bomb dialog error pages`

### Task 6: Admin skin

**Files:** Modify `server.js` admin builders: login page (:2003-2030), admin post list, categories, media pages, editor form; admin header branch merged into Task 2's menu bar

- [ ] Login (`/admin/login`) → centered `.alert` password dialog (key icon, existing `<form method="POST" action="/admin/login">` preserved verbatim inside; password input gets `.os-input`; buttons `.readmore` Cancel(→/) + `.readmore.default` OK as submit). Error/rate-limit message renders as dialog body text.
- [ ] Admin post list → `.window` "Posts" with `.toolbar` (New Post, filters as bevel buttons/selects) + `.rows` list (title, status chip — Draft = gray chip, Published = green chip — date, edit link).
- [ ] Categories + Media pages → same window/list/toolbar treatment; media grid thumbnails get `.figframe`-style bevel cells.
- [ ] Editor → `.window` titled with the post title (or "Untitled"); form fields → `.field-row` + `.os-input/.os-select`; markdown box → `.os-textarea`; Save/Publish buttons → `.readmore` (`.default` on the primary). All form names/actions byte-identical.
- [ ] Verify (functional, local): login with dev ADMIN_PASSWORD → create draft "OS9 test" → publish → visible on homepage → delete. Confirms zero behavior drift.
- [ ] Commit: `feat(theme): Platinum admin (login dialog, list windows, editor)`

### Task 7: Local screenshot sweep (user gate)

**Files:** Create `scripts/os9-screenshots.mjs` (Playwright; may live unversioned if preferred — plan says commit it)

- [ ] Dev env (no `.env` in repo): `docker compose up -d db` then
  `MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_USER=blog MYSQL_PASSWORD=blog MYSQL_DATABASE=blog ADMIN_PASSWORD=dev SITE_NAME="Dailey Weekly" node server.js` (read exact creds from `docker-compose.yml` — adjust if they differ). Seed 3 posts via admin if DB empty.
- [ ] Script: launch Chromium; shoot `/`, one post, one category, `/nope` (404), `/admin/login`, `/admin` (after login), editor — at 1440×900 and 390×844 → `docs/superpowers/specs/shots/*.png`.
- [ ] Send the screenshots to Jonny; **stop for approval before deploying**.
- [ ] Commit: `chore: OS9 screenshot sweep script + captures`

### Task 8: Deploy + live verification

- [ ] Push `main` (`git push origin main`).
- [ ] Deploy: `dailey_deploy project_id=fcf66fdf-5355-4970-8163-632ecd4fcf99`; watch to success.
- [ ] Live checks (find the public URL via `dailey_project_info`/domains — expected weekly.dailey.cloud or similar):
  - `curl -sI <url>/os9.css` → 200
  - RSS: `curl -s <url>/rss | head -5` → same XML structure as before deploy (capture before + after, diff element names)
  - Playwright sweep against live URL (same script, `BASE_URL` env)
  - Admin e2e on live: login → draft → publish → verify → delete (use real ADMIN_PASSWORD from project env)
- [ ] Send live screenshots to Jonny; update memory (`MEMORY.md` pointer + a `dailey_weekly_os9.md` note: theme architecture, font sourcing, how to tweak).
- [ ] Commit any final fixes; done.

## Self-review

- Spec coverage: assets/serving (T1), menu bar+shell (T2), homepage/lists/labels/subscribe (T3), post page (T4), bomb 404 + splash (T1/T5), admin login/dashboard/editor (T6), responsive+a11y (global, verified T7), deploy+RSS+e2e (T8). Boot splash gated by `sessionStorage` + reduced-motion (T1). ✓
- No placeholders: every step names exact files/classes or contains the code; the one deliberate deferral (font mirror availability) has an explicit non-blocking fallback. ✓
- Type consistency: single `layout(title, content, options)` signature preserved; class names match the committed mockup throughout. ✓
