# Dailey Weekly — Mac OS 9 (Platinum) Redesign

**Date:** 2026-07-12
**Status:** Approved by Jonny (direction B: Platinum-skinned blog; scope: reader + admin; type: Chicago headings + Verdana body)

## Goal

Reskin the entire Dailey Weekly blog — reader pages AND admin — in the Mac OS 9 "Platinum" visual language. Conventional blog structure and behavior are preserved; every surface is drawn as period-correct window chrome. It must remain a fast, readable, responsive, accessible site.

## Non-goals

- No desktop simulation: no draggable windows, no z-order management, no desktop icons
- No behavior changes: routes, DB schema, sessions, RSS, media uploads, and admin logic are untouched
- No build step, no template engine, no frontend framework — the app stays a single `server.js` with template strings

## Architecture

| Piece | Change |
|---|---|
| `public/os9.css` | NEW — the entire theme in one static stylesheet; replaces all inline `<style>` blocks in `server.js` |
| `public/fonts/ChicagoFLF.woff2` | NEW — self-hosted freeware Chicago-style font (no CDN). Fallback stack: `"ChicagoFLF", "Charcoal", Geneva, Verdana, sans-serif` — if the font fails, headings degrade to bold Verdana |
| `public/os9.js` | NEW — tiny vanilla JS (~30 lines): boot-splash-once-per-session (`sessionStorage`), CSS-only menus need no JS; nothing else |
| `server.js` | Markup-only surgery in the render functions: window-chrome wrappers, menu bar, dialogs. `express.static('public')` added if not already present |
| Assets | Desktop dither pattern + small icons as inline SVG/data URIs inside `os9.css` (no binary sprite files beyond the font) |

## Visual system (Platinum)

- **Desktop:** muted OS 9 blue with a subtle dither-pattern tile as the page background; windows carry soft drop shadows
- **Window chrome:** `#DDD` platinum gray, 1px black outline, bevel highlights (white top-left, `#888` bottom-right); title bars with horizontal pinstripes, centered Chicago title text, decorative close/collapse boxes (the close box on reader windows may link "back" where natural; otherwise decorative)
- **Typography:** ChicagoFLF for title bars/headings/menus/buttons; Verdana 13–14px body (16px on mobile); 11px Geneva-style metadata. Body text is always near-black on white
- **Controls:** beveled 3D buttons (default button = classic black double-ring), inset text fields, webkit-styled scrollbars (bevel track, ridged thumb), classic blue underlined links
- **Categories:** OS 9 Finder label chips (era label colors: orange, red, blue, green, purple)

## Pages

### Reader
- **Menu bar** (replaces header): fixed strip — Dailey mark (apple position), "Dailey Weekly" in Chicago, menu items: Home · Categories (CSS-only dropdown) · RSS · About
- **Homepage:** featured post = large document window; post list = Finder list-view window with "N items" header strip; About / Categories / Archive = small stacked side windows (drop below content on mobile, matching current behavior)
- **Post page:** single document window — title in the title bar, white document area, beveled image frames, caption strip for byline/date
- **Subscribe box:** system alert dialog styling (icon + message + default button)
- **404/error:** bomb dialog homage ("Sorry, a system error occurred.") with a Restart (home) button
- **Boot splash:** first visit per session, ~1.5s welcome screen (mark + loading bar), click-to-skip, `sessionStorage`-gated

### Admin
- **Login:** OS 9 password-prompt dialog centered on the desktop
- **Dashboard/post list:** Finder list-view windows, beveled toolbar buttons
- **Editor:** document window; SimpleText-style markdown area; System-styled inputs/selects; media picker keeps behavior with beveled chrome
- Same routes, session cookie, rate limiting, uploads — zero logic edits

## Responsive & accessibility

- <700px: windows full-width with slimmer chrome; menu bar condenses to logo + Menu/RSS; 16px body; no horizontal scroll anywhere
- Contrast: body black-on-white; chrome decoration never carries meaning alone; visible focus states on all interactive elements
- Print styles: document area prints clean (chrome suppressed)

## Out-of-scope preserved endpoints

RSS (`/rss.xml` or equivalent), any JSON/API responses, media redirect/signing routes — byte-identical behavior.

## Implementation & verification plan

1. **Mockup checkpoint (gate):** static homepage + post-page mockup, screenshotted desktop + mobile, approved by Jonny before the full render-function surgery
2. Full implementation against local dev DB (`docker compose up db`)
3. Playwright screenshot sweep: home, post, category, 404, subscribe states, admin login, dashboard, editor — at 1440px and 390px
4. Functional e2e on live: admin login → create draft → publish → verify reader view → delete; RSS diff vs pre-deploy (structure unchanged)
5. Deploy via DOS project `dailey-weekly` (fcf66fdf-5355-4970-8163-632ecd4fcf99); post-deploy screenshot sweep

## Risks

- **Font sourcing:** ChicagoFLF is freeware but must be fetched and converted to woff2 at build time; degradation path (bold Verdana) is acceptable if sourcing fails
- **server.js churn:** ~20 render functions touched; mitigated by the mockup-first gate and by extracting CSS out of the file rather than adding to it
- **Webkit-only scrollbar styling:** Firefox gets standard scrollbars (acceptable degradation)
