const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { migrate } = require('./migrate');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || '';
const ADMIN_SESSION_COOKIE = 'blog_admin_session';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SITE_NAME = process.env.SITE_NAME || 'The Dailey Company Blog';
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const SITE_DESCRIPTION =
  process.env.SITE_DESCRIPTION ||
  'Product updates, engineering notes, customer stories, and company news from Dailey.';
const MEDIA_UPLOAD_MAX_BYTES = 128 * 1024 * 1024;
const STORAGE_BUCKET = process.env.S3_BUCKET_NAME || process.env.S3_BUCKET || '';
const STORAGE_PREFIX = normalizeStoragePrefix(process.env.S3_KEY_PREFIX || process.env.S3_PREFIX || '');
const ALLOWED_MEDIA_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/ogg',
  'video/quicktime',
  'video/webm',
  'video/x-m4v',
]);

let pool;
let storageClient;
const loginAttempts = new Map();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEDIA_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, callback) => {
    if (ALLOWED_MEDIA_MIME_TYPES.has(String(file.mimetype || '').toLowerCase())) {
      return callback(null, true);
    }

    const error = new Error('Only JPG, PNG, WebP, GIF, AVIF, MP4, WebM, OGG, MOV, and M4V files are allowed.');
    error.code = 'UNSUPPORTED_MEDIA_TYPE';
    callback(error);
  },
});

async function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }

  if (!pool) {
    pool = mysql.createPool(process.env.DATABASE_URL);
  }

  return pool;
}

function hasStorageConfig() {
  return Boolean(
    process.env.S3_ENDPOINT &&
      STORAGE_BUCKET &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY
  );
}

function getStorageClient() {
  if (!hasStorageConfig()) {
    throw new Error('S3-compatible storage is not configured.');
  }

  if (!storageClient) {
    storageClient = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        // Dailey OS injects temporary credentials; the session token is
        // required or presigned URLs fail with SignatureDoesNotMatch.
        ...(process.env.S3_SESSION_TOKEN
          ? { sessionToken: process.env.S3_SESSION_TOKEN }
          : {}),
      },
      forcePathStyle: true,
    });
  }

  return storageClient;
}

app.disable('x-powered-by');
if (!IS_PRODUCTION) {
  app.use('/media', express.static(path.join(__dirname, 'public', 'media')));
}
// OS9 theme assets (css/js/fonts). Mounted after /media so its config wins there.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' https: data:",
    "media-src 'self' https:",
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com",
    "connect-src 'self'",
  ];

  if (IS_PRODUCTION) {
    csp.push('upgrade-insecure-requests');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  res.setHeader('Content-Security-Policy', csp.join('; '));
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(value) {
  return escapeHtml(value);
}

function normalizeStoragePrefix(value) {
  return String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function formatBytes(bytes) {
  const size = Number(bytes || 0);
  if (size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / Math.pow(1024, index);
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function mediaKindFromMime(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  return 'file';
}

function fileSlug(filename) {
  const original = path.basename(String(filename || '').trim());
  const extension = path.extname(original).toLowerCase();
  const base = slugify(original.slice(0, extension ? -extension.length : undefined)) || 'asset';
  return `${base}${extension}`;
}

function buildMediaPublicPath(media) {
  return `/media/${media.id}/${encodeURIComponent(fileSlug(media.original_name))}`;
}

function buildMediaShortcode(media) {
  const publicPath = buildMediaPublicPath(media);
  if (media.kind === 'video') return `{{video:${publicPath}|Optional caption}}`;
  if (media.kind === 'image') return `{{image:${publicPath}|Optional caption}}`;
  return publicPath;
}

function buildStorageObjectKey(file) {
  const kind = mediaKindFromMime(file.mimetype);
  const parts = [STORAGE_PREFIX, 'media', kind === 'file' ? 'files' : `${kind}s`].filter(Boolean);
  return `${parts.join('/')}/${Date.now()}-${crypto.randomUUID()}-${fileSlug(file.originalname)}`;
}

function safeDownloadFilename(value) {
  return (
    String(value || '')
      .replace(/[^\x20-\x7e]+/g, '')
      .replace(/["\\\r\n;]/g, '')
      .trim() || 'asset'
  );
}

function sanitizeLinkUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '#';
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;

  try {
    const parsed = new URL(trimmed);
    if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      return trimmed;
    }
  } catch {
    return '#';
  }

  return '#';
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function readingTime(text) {
  if (!text) return '1 min read';
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  const mins = Math.max(1, Math.round(words / 200));
  return `${mins} min read`;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function parseTags(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function getYouTubeEmbedUrl(videoUrl) {
  if (!videoUrl) return null;

  const normalized = String(videoUrl).replace(/&amp;/g, '&');
  const youtubeMatch = normalized.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/i
  );

  if (!youtubeMatch) return null;
  return `https://www.youtube.com/embed/${youtubeMatch[1]}`;
}

function isHostedVideoUrl(videoUrl) {
  return /^(?:https?:\/\/|\/).+\.(mp4|m4v|webm|ogg|mov)$/i.test(String(videoUrl || '').trim());
}

function isHostedImageUrl(imageUrl) {
  return /^(?:https?:\/\/|\/).+\.(avif|gif|jpe?g|png|webp)$/i.test(String(imageUrl || '').trim());
}

function resolveVideoUrl(videoUrl) {
  const trimmed = String(videoUrl || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/')) {
    return trimmed;
  }
  return `/media/${trimmed.replace(/^\/+/, '')}`;
}

function renderEmbedBlock(type, videoUrl, caption = '') {
  const safeCaption = caption ? `<p class="embed-caption">${escapeHtml(caption)}</p>` : '';

  if (type === 'youtube') {
    const embedUrl = getYouTubeEmbedUrl(videoUrl);
    if (!embedUrl) {
      return `<div class="embed-block"><p>Invalid YouTube URL: <a href="${safeUrl(
        videoUrl
      )}" target="_blank" rel="noreferrer">${escapeHtml(videoUrl)}</a></p></div>`;
    }

    return compactHtml(`
      <div class="embed-block">
        <div class="embed-shell">
          <iframe
            title="${caption ? escapeHtml(caption) : 'Embedded video'}"
            src="${safeUrl(embedUrl)}"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
          ></iframe>
        </div>
        ${safeCaption}
      </div>`);
  }

  if (type === 'image') {
    const resolvedUrl = resolveVideoUrl(videoUrl);
    if (!isHostedImageUrl(resolvedUrl)) {
      return `<div class="embed-block"><p>Invalid hosted image URL: <a href="${safeUrl(
        resolvedUrl
      )}" target="_blank" rel="noreferrer">${escapeHtml(videoUrl)}</a></p></div>`;
    }

    return compactHtml(`
      <figure class="embed-block image-embed">
        <img src="${safeUrl(resolvedUrl)}" alt="${caption ? escapeHtml(caption) : ''}" loading="lazy">
        ${caption ? `<figcaption class="embed-caption">${escapeHtml(caption)}</figcaption>` : ''}
      </figure>`);
  }

  const resolvedUrl = resolveVideoUrl(videoUrl);
  if (!isHostedVideoUrl(resolvedUrl)) {
    return `<div class="embed-block"><p>Invalid hosted video URL: <a href="${safeUrl(
      resolvedUrl
    )}" target="_blank" rel="noreferrer">${escapeHtml(videoUrl)}</a></p></div>`;
  }

  return compactHtml(`
    <div class="embed-block">
      <div class="embed-shell">
        <video controls playsinline preload="metadata">
          <source src="${safeUrl(resolvedUrl)}">
        </video>
      </div>
      ${safeCaption}
    </div>`);
}

function parseEmbedLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const shortcode = trimmed.match(/^\{\{(youtube|video|image):([^|}]+?)(?:\|(.+?))?\}\}$/i);
  if (shortcode) {
    return {
      type: shortcode[1].toLowerCase(),
      url: shortcode[2].trim(),
      caption: (shortcode[3] || '').trim(),
    };
  }

  const youtubeUrl = getYouTubeEmbedUrl(trimmed);
  if (youtubeUrl) {
    return { type: 'youtube', url: trimmed, caption: '' };
  }

  if (isHostedVideoUrl(trimmed)) {
    return { type: 'video', url: trimmed, caption: '' };
  }

  if (isHostedImageUrl(trimmed)) {
    return { type: 'image', url: trimmed, caption: '' };
  }

  return null;
}

function renderMarkdown(text) {
  if (!text) return '';

  const embeds = [];
  const preprocessed = String(text)
    .split('\n')
    .map((line) => {
      const embed = parseEmbedLine(line);
      if (!embed) return line;

      const token = `__EMBED_${embeds.length}__`;
      embeds.push(renderEmbedBlock(embed.type, embed.url, embed.caption));
      return token;
    })
    .join('\n');

  let html = escapeHtml(preprocessed)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => `<pre><code>${code.trimEnd()}</code></pre>`)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^> (.+)$/gm, '<blockquote><p>$1</p></blockquote>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
      const sanitizedUrl = sanitizeLinkUrl(url);
      const href = safeUrl(sanitizedUrl);
      const external = /^https?:\/\//i.test(sanitizedUrl) ? ' target="_blank" rel="noreferrer"' : '';
      return `<a href="${href}"${external}>${label}</a>`;
    })
    .replace(/^---$/gm, '<hr>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    .replace(/^- (.+)$/gm, '<li>$1</li>');

  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  embeds.forEach((embedHtml, index) => {
    html = html.replace(`__EMBED_${index}__`, embedHtml);
  });

  const lines = html.split('\n');
  const rendered = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      rendered.push('');
      continue;
    }

    if (
      trimmed.startsWith('<h') ||
      trimmed.startsWith('<ul') ||
      trimmed.startsWith('<ol') ||
      trimmed.startsWith('<pre') ||
      trimmed.startsWith('<hr') ||
      trimmed.startsWith('<li') ||
      trimmed.startsWith('<blockquote') ||
      trimmed.startsWith('<div class="embed-block"') ||
      trimmed.startsWith('<figure') ||
      trimmed.startsWith('</')
    ) {
      rendered.push(trimmed);
    } else {
      rendered.push(`<p>${trimmed}</p>`);
    }
  }

  return rendered
    .join('\n')
    .replace(/<\/ul>\s*<ul>/g, '')
    // Group consecutive image embeds into a side-by-side row.
    .replace(
      /(?:<figure class="embed-block image-embed">.*?<\/figure>\s*){2,}/g,
      (match) => `<div class="image-row">${match.trim()}</div>`
    );
}

function compactHtml(html) {
  return html.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator === -1) return cookies;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
      return cookies;
    }, {});
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function getSessionSecret() {
  if (ADMIN_SESSION_SECRET) return ADMIN_SESSION_SECRET;
  return crypto.createHash('sha256').update(`${ADMIN_PASSWORD}:${SITE_NAME}:${SITE_URL}`).digest('hex');
}

function signValue(value) {
  return crypto.createHmac('sha256', getSessionSecret()).update(value).digest('base64url');
}

function createAdminSession() {
  const payload = {
    csrf: crypto.randomBytes(24).toString('hex'),
    exp: Date.now() + ADMIN_SESSION_TTL_MS,
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${signValue(encoded)}`;
}

function safeEqualStrings(left, right) {
  const leftBuffer = crypto.createHash('sha256').update(String(left || '')).digest();
  const rightBuffer = crypto.createHash('sha256').update(String(right || '')).digest();
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function readAdminSession(token) {
  if (!token || !token.includes('.')) return null;

  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  if (!safeEqualStrings(signValue(encoded), signature)) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(encoded));
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (typeof payload.csrf !== 'string' || payload.csrf.length < 16) return null;
    return payload;
  } catch {
    return null;
  }
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function setAdminSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(ADMIN_SESSION_COOKIE, token, {
      httpOnly: true,
      maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
      path: '/',
      sameSite: 'Strict',
      secure: IS_PRODUCTION,
    })
  );
}

function clearAdminSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(ADMIN_SESSION_COOKIE, '', {
      httpOnly: true,
      maxAge: 0,
      path: '/',
      sameSite: 'Strict',
      secure: IS_PRODUCTION,
    })
  );
}

function getRequestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function pruneLoginAttempts(now = Date.now()) {
  for (const [ip, entry] of loginAttempts.entries()) {
    if (entry.resetAt <= now) {
      loginAttempts.delete(ip);
    }
  }
}

function loginThrottleState(req) {
  pruneLoginAttempts();
  const ip = getRequestIp(req);
  const current = loginAttempts.get(ip);
  if (!current) return { ip, blocked: false, remainingMs: 0 };
  if (current.count >= LOGIN_MAX_ATTEMPTS && current.resetAt > Date.now()) {
    return { ip, blocked: true, remainingMs: current.resetAt - Date.now() };
  }
  return { ip, blocked: false, remainingMs: 0 };
}

function registerFailedLogin(req) {
  const ip = getRequestIp(req);
  const now = Date.now();
  const current = loginAttempts.get(ip);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }

  current.count += 1;
  loginAttempts.set(ip, current);
}

function clearFailedLogins(req) {
  loginAttempts.delete(getRequestIp(req));
}

function currentRequestOrigin(req) {
  // Prefer SITE_URL when configured — it is the canonical public origin and
  // bypasses TLS-termination-induced protocol drift (Cloudflare → HTTP →
  // ingress-nginx sees X-Forwarded-Proto: http even though the browser used
  // HTTPS, which would otherwise fail the trusted-origin check).
  if (SITE_URL && !SITE_URL.startsWith('http://localhost')) {
    try {
      return new URL(SITE_URL).origin;
    } catch {
      // fall through to header-based detection
    }
  }
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || (IS_PRODUCTION ? 'https' : 'http');
  const host = forwardedHost || req.headers.host;
  if (!host) return null;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

function isTrustedOrigin(req) {
  const candidate = req.headers.origin || req.headers.referer;
  if (!candidate) return true;

  try {
    const candidateUrl = new URL(candidate);
    const requestOrigin = currentRequestOrigin(req);
    if (!requestOrigin) return false;
    if (candidateUrl.origin === requestOrigin) return true;
    // Cloudflare/Tunnel terminates TLS upstream and forwards plain HTTP to
    // ingress-nginx, so X-Forwarded-Proto can legitimately say "http" even
    // though the browser used HTTPS. As long as the hostnames match the
    // ingress-derived host, treat the origin as trusted — CSRF protection
    // still requires same-host, which is the property that matters.
    const requestUrl = new URL(requestOrigin);
    return candidateUrl.hostname === requestUrl.hostname;
  } catch {
    return false;
  }
}

const categoryColors = {
  product: { bg: '#e5f4ef', text: '#155e4b', border: '#b8dbce' },
  engineering: { bg: '#eaf2fd', text: '#1952a6', border: '#c7daf7' },
  company: { bg: '#fdf1dc', text: '#9a5b00', border: '#f2d8ab' },
  customers: { bg: '#f8e9f1', text: '#9e255d', border: '#efc5da' },
};

function getCategoryColor(slug) {
  return categoryColors[slug] || { bg: '#f3f4f6', text: '#475467', border: '#d0d5dd' };
}

function renderBombDialog(title, message, code) {
  return `
    <section class="alert" aria-label="Error" style="max-width:520px;margin:40px auto;">
      <div class="bomb" aria-hidden="true"></div>
      <div style="flex:1">
        <h3>${escapeHtml(title)}</h3>
        <p>&ldquo;${escapeHtml(message)}&rdquo;<br>Error code: ${escapeHtml(String(code))}</p>
        <div class="btnrow" style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">
          <a class="readmore default" href="/">Restart</a>
        </div>
      </div>
    </section>`;
}

function renderCategoryPill(name, slug) {
  if (!name) return '';
  const color = getCategoryColor(slug);
  return `<span class="chip" style="background:${color.bg};color:${color.text};">${escapeHtml(name)}</span>`;
}

function renderTagList(tags) {
  if (!tags.length) return '';
  return `<div class="tags">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>`;
}

function renderMeta(post) {
  const date = formatDate(post.published_at || post.created_at);
  const time = readingTime(post.content);
  const pieces = [date, time].filter(Boolean);

  return `
    <div class="meta-row">
      ${pieces
        .map((piece, index) => `${index > 0 ? '<span class="dot"></span>' : ''}<span>${escapeHtml(piece)}</span>`)
        .join('')}
    </div>`;
}

function renderFeaturedPost(post) {
  const tags = parseTags(post.tags);
  return `
    <section class="window">
      <div class="titlebar"><div class="box" aria-hidden="true"></div><div class="ttl"><span>Featured</span></div><div class="box collapse" aria-hidden="true"></div></div>
      <div class="win-body">
        <article class="doc">
          <div class="meta">${renderCategoryPill(post.category_name, post.category_slug)} <b>${escapeHtml(formatDate(post.published_at || post.created_at))}</b> &middot; ${escapeHtml(readingTime(post.content))}</div>
          <h1><a href="/post/${escapeHtml(post.slug)}" style="color:inherit;text-decoration:none;">${escapeHtml(post.title)}</a></h1>
          <p>${escapeHtml(post.excerpt || SITE_DESCRIPTION)}</p>
          ${renderTagList(tags)}
          <a href="/post/${escapeHtml(post.slug)}" class="readmore default">Read More\u2026</a>
        </article>
      </div>
    </section>`;
}

function renderPostRow(post) {
  const date = formatDate(post.published_at || post.created_at);
  return `
    <div class="row">
      <div class="ico" aria-hidden="true"></div>
      <div class="name">
        <a href="/post/${escapeHtml(post.slug)}">${escapeHtml(post.title)}</a>
        <small>${renderCategoryPill(post.category_name, post.category_slug)} ${escapeHtml(post.excerpt || '')}</small>
      </div>
      <div class="date">${escapeHtml(date)}</div>
    </div>`;
}

function layout(title, content, options = {}) {
  const { description = '', ogType = 'website', ogImage = '', isAdmin = false } = options;
  const safeTitle = escapeHtml(title);
  const metaDescription = escapeHtml(description || title);
  const publicLogo = `<span class="logo-mark"></span>${escapeHtml(SITE_NAME)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle} — ${escapeHtml(SITE_NAME)}</title>
  <meta name="description" content="${metaDescription}">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${metaDescription}">
  <meta property="og:type" content="${escapeHtml(ogType)}">
  <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
  ${ogImage ? `<meta property="og:image" content="${safeUrl(ogImage)}">` : ''}
  <link rel="alternate" type="application/rss+xml" title="${escapeHtml(SITE_NAME)} RSS" href="/rss">
  <link rel="stylesheet" href="/os9.css">
${isAdmin ? '' : '<script src="/os9.js" defer></script>'}
</head>
<body>
  <div class="menubar" role="banner">
    <div class="mark" aria-hidden="true"></div>
    <a href="${isAdmin ? '/admin' : '/'}" class="item title">${isAdmin ? 'Blog Admin' : escapeHtml(SITE_NAME)}</a>
    ${isAdmin ? `
      <a class="item" href="/admin">Posts</a>
      <a class="item" href="/admin/categories">Categories</a>
      <a class="item" href="/admin/media">Media</a>
      <a class="item keep" href="/" target="_blank" rel="noreferrer">View Blog</a>
      <a class="item" href="/admin/logout">Logout</a>
    ` : `
      <a class="item" href="/">Home</a>
      <a class="item" href="/#categories">Categories</a>
      <a class="item keep" href="/rss">RSS</a>
      <a class="item" href="https://os.dailey.cloud" target="_blank" rel="noreferrer">Dailey OS</a>
    `}
    <div class="spacer"></div>
    <div class="clock">${escapeHtml(new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}</div>
  </div>
  <main class="desk">${content}</main>
  <footer class="deskfoot">${escapeHtml(SITE_NAME)} &middot; &copy; ${new Date().getFullYear()} Dailey LLC &middot; hosted on <a href="https://os.dailey.cloud" target="_blank" rel="noreferrer" style="color:#fff">Dailey OS</a> &middot; <a href="/rss" style="color:#fff">RSS</a></footer>
</body>
</html>`;
}

function adminAuth(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  const cookies = parseCookies(req.headers.cookie);
  const session = readAdminSession(cookies[ADMIN_SESSION_COOKIE]);
  if (session) {
    req.adminSession = session;
    return next();
  }

  clearAdminSessionCookie(res);
  res.redirect('/admin/login');
}

function requireTrustedOrigin(req, res, next) {
  if (isTrustedOrigin(req)) return next();
  res.status(403).send(layout('Forbidden', '<p>Request origin not allowed.</p>', { isAdmin: true }));
}

function requireAdminCsrf(req, res, next) {
  if (!req.adminSession) {
    return res.status(403).send(layout('Forbidden', '<p>Admin session missing.</p>', { isAdmin: true }));
  }

  if (safeEqualStrings(req.body.csrf_token, req.adminSession.csrf)) {
    return next();
  }

  res.status(403).send(layout('Forbidden', '<p>Security token mismatch.</p>', { isAdmin: true }));
}

function handleMediaUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();

    const message =
      err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? `Upload failed. Files must be ${Math.round(MEDIA_UPLOAD_MAX_BYTES / (1024 * 1024))} MB or smaller.`
        : err.message || 'Upload failed.';

    res.redirect(`/admin/media?error=${encodeURIComponent(message)}`);
  });
}

function requireStorageForAdmin(req, res, next) {
  if (hasStorageConfig()) return next();
  res.redirect('/admin/media?error=Storage%20is%20not%20configured%20for%20this%20deployment.');
}

app.get('/media/:id/:filename?', async (req, res) => {
  try {
    const db = await getPool();
    const [assets] = await db.execute('SELECT * FROM media_assets WHERE id = ?', [req.params.id]);

    if (assets.length === 0) {
      return res
        .status(404)
        .send(layout('Not Found', renderBombDialog('Sorry, a system error occurred.', 'That media asset could not be found.', 404)));
    }

    if (!hasStorageConfig()) {
      return res
        .status(503)
        .send(
          layout(
            'Storage Unavailable',
            '<main><div class="container"><div class="empty-state"><p>Media storage is not configured for this deployment yet.</p></div></div></main>'
          )
        );
    }

    const asset = assets[0];
    const signedUrl = await getSignedUrl(
      getStorageClient(),
      new GetObjectCommand({
        Bucket: STORAGE_BUCKET,
        Key: asset.storage_key,
        ResponseContentDisposition: `inline; filename="${safeDownloadFilename(asset.original_name)}"`,
        ResponseContentType: asset.mime_type,
      }),
      { expiresIn: 3600 }
    );

    res.redirect(signedUrl);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .send(layout('Error', '<main><div class="container"><div class="empty-state"><p>Media could not be loaded.</p></div></div></main>'));
  }
});

app.get('/', async (req, res) => {
  try {
    const db = await getPool();
    const category = req.query.category || null;
    let query = `SELECT p.*, c.name as category_name, c.slug as category_slug
      FROM posts p LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.published = TRUE`;
    const params = [];

    if (category) {
      query += ' AND c.slug = ?';
      params.push(category);
    }

    query += ' ORDER BY p.published_at DESC';

    const [posts] = await db.execute(query, params);
    const [categories] = await db.execute('SELECT * FROM categories ORDER BY name');

    const featuredPost = posts[0] || null;
    const otherPosts = featuredPost ? posts.slice(1) : [];
    const railNavLinks = categories
      .map(
        (c) =>
          `<a href="/?category=${escapeHtml(c.slug)}"${category === c.slug ? ' style="font-weight:bold"' : ''}>${escapeHtml(c.name)}</a>`
      )
      .join('');

    const sideHtml = `
      <div>
        <section class="window sidewin">
          <div class="titlebar"><div class="box" aria-hidden="true"></div><div class="ttl"><span>About</span></div></div>
          <div class="win-body"><p style="margin:6px 0;line-height:1.55;">${escapeHtml(SITE_DESCRIPTION)}</p></div>
        </section>
        <section class="window sidewin" id="categories">
          <div class="titlebar"><div class="box" aria-hidden="true"></div><div class="ttl"><span>Categories</span></div></div>
          <div class="win-body">
            <ul>
              <li><a href="/"${!category ? ' style="font-weight:bold"' : ''}>All Posts</a></li>
              ${categories.map((c) => `<li><a href="/?category=${escapeHtml(c.slug)}"${category === c.slug ? ' style="font-weight:bold"' : ''}>${escapeHtml(c.name)}</a></li>`).join('')}
            </ul>
          </div>
        </section>
        <section class="alert" aria-label="Subscribe">
          <div class="aicon" aria-hidden="true"></div>
          <div>
            <h3>Never miss an issue.</h3>
            <p>${escapeHtml(SITE_NAME)} lands in your feed every week.</p>
            <div class="field"><a class="readmore default" href="/rss">Get the RSS feed</a></div>
          </div>
        </section>
      </div>`;

    const featuredHtml = featuredPost ? renderFeaturedPost(featuredPost) : '';
    const listHtml = otherPosts.length
      ? `
        <section class="window">
          <div class="titlebar"><div class="box" aria-hidden="true"></div><div class="ttl"><span>${category ? escapeHtml(category) + ' posts' : 'Recent Posts'}</span></div><div class="box collapse" aria-hidden="true"></div></div>
          <div class="liststrip">${otherPosts.length + (featuredPost ? 1 : 0)} items, updated weekly</div>
          <div class="listwrap">
            <div class="rows">${otherPosts.map(renderPostRow).join('')}</div>
            <div class="rail" aria-hidden="true"><div class="arrow up"></div><div class="track"><div class="thumb"></div></div><div class="arrow dn"></div></div>
          </div>
        </section>`
      : featuredPost
        ? ''
        : '<div class="empty-state"><p>No posts yet. Check back soon.</p></div>';

    const html = `
      <div class="cols">
        <div>
          ${featuredHtml}
          ${listHtml}
        </div>
        ${sideHtml}
      </div>`;

    res.send(layout(SITE_NAME, html, { description: SITE_DESCRIPTION }));
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .send(layout('Error', '<div class="empty-state"><p>Blog data is not available yet. Check your database connection and try again.</p></div>'));
  }
});

app.get('/post/:slug', async (req, res) => {
  try {
    const db = await getPool();
    const [posts] = await db.execute(
      `SELECT p.*, c.name as category_name, c.slug as category_slug
       FROM posts p LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.slug = ? AND p.published = TRUE`,
      [req.params.slug]
    );

    if (posts.length === 0) {
      return res
        .status(404)
        .send(
          layout(
            'Not Found',
            renderBombDialog('Sorry, a system error occurred.', 'That post could not be found.', 404)
          )
        );
    }

    const post = posts[0];
    const tags = parseTags(post.tags);
    const metaBits = [post.category_name && escapeHtml(post.category_name), escapeHtml(formatDate(post.published_at || post.created_at)), escapeHtml(readingTime(post.content))].filter(Boolean).join(' &middot; ');
    const html = `
      <section class="window">
        <div class="titlebar"><div class="box" aria-hidden="true"></div><div class="ttl"><span>${escapeHtml(post.title)}</span></div><div class="box collapse" aria-hidden="true"></div></div>
        <div class="liststrip">${metaBits}</div>
        <div class="win-body">
          <article class="doc">
            ${post.excerpt ? `<p style="font-weight:bold;font-size:15px;margin:0 0 14px;">${escapeHtml(post.excerpt)}</p>` : ''}
            ${renderMarkdown(post.content)}
            <div style="margin-top:22px;padding-top:14px;border-top:1px solid #ccc;">
              ${renderTagList(tags)}
              <a href="/" class="readmore">&larr; Back to all posts</a>
            </div>
          </article>
        </div>
      </section>`;

    res.send(layout(post.title, html, { description: post.excerpt || SITE_DESCRIPTION, ogType: 'article' }));
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .send(layout('Error', '<main><div class="container"><div class="empty-state"><p>Something went wrong.</p></div></div></main>'));
  }
});

app.get('/rss', async (_req, res) => {
  try {
    const db = await getPool();
    const [posts] = await db.execute(
      `SELECT p.*, c.name as category_name
       FROM posts p LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.published = TRUE ORDER BY p.published_at DESC LIMIT 20`
    );

    const items = posts
      .map(
        (post) => `
    <item>
      <title><![CDATA[${post.title}]]></title>
      <link>${SITE_URL}/post/${post.slug}</link>
      <guid>${SITE_URL}/post/${post.slug}</guid>
      <description><![CDATA[${post.excerpt || ''}]]></description>
      ${post.category_name ? `<category>${post.category_name}</category>` : ''}
      <pubDate>${post.published_at ? new Date(post.published_at).toUTCString() : ''}</pubDate>
    </item>`
      )
      .join('');

    res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeHtml(SITE_NAME)}</title>
    <link>${SITE_URL}</link>
    <description>${escapeHtml(SITE_DESCRIPTION)}</description>
    <language>en-us</language>
    ${items}
  </channel>
</rss>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error generating RSS');
  }
});

app.get('/admin/login', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const throttle = loginThrottleState(req);
  const lockedMessage = throttle.blocked
    ? `<div class="alert alert-error">Too many login attempts. Try again in ${Math.ceil(throttle.remainingMs / 60000)} minute(s).</div>`
    : '';
  const error = req.query.error ? '<div class="alert alert-error">Invalid password.</div>' : '';
  res.send(
    layout(
      'Login',
      `
      <div class="login-box">
        <h1>Admin Login</h1>
        ${lockedMessage}
        ${error}
        <form method="POST" action="/admin/login">
          <div class="form-group">
            <label>Password</label>
            <input type="password" name="password" required autofocus ${throttle.blocked ? 'disabled' : ''}>
          </div>
          <button type="submit" class="btn" style="width:100%;" ${throttle.blocked ? 'disabled' : ''}>Log In</button>
        </form>
      </div>`,
      { isAdmin: true }
    )
  );
});

app.post('/admin/login', requireTrustedOrigin, (req, res) => {
  const throttle = loginThrottleState(req);
  if (throttle.blocked) {
    return res.redirect('/admin/login');
  }

  if (safeEqualStrings(req.body.password, ADMIN_PASSWORD)) {
    clearFailedLogins(req);
    setAdminSessionCookie(res, createAdminSession());
    return res.redirect('/admin');
  }

  registerFailedLogin(req);
  res.redirect('/admin/login?error=1');
});

app.get('/admin/logout', (_req, res) => {
  clearAdminSessionCookie(res);
  res.redirect('/admin/login');
});

app.get('/admin', adminAuth, async (req, res) => {
  try {
    const db = await getPool();
    const [posts] = await db.execute(
      `SELECT p.*, c.name as category_name FROM posts p LEFT JOIN categories c ON p.category_id = c.id ORDER BY p.created_at DESC`
    );

    const success = req.query.success ? `<div class="alert alert-success">${escapeHtml(req.query.success)}</div>` : '';
    const error = req.query.error ? '<div class="alert alert-error">The last change could not be completed.</div>' : '';
    const rows = posts
      .map((post) => {
        const date = formatDate(post.created_at);
        return `<tr>
          <td><a href="/admin/posts/${post.id}/edit">${escapeHtml(post.title)}</a></td>
          <td>${escapeHtml(post.category_name || '—')}</td>
          <td>${post.published ? '<span style="color:#027a48;font-weight:700;">Published</span>' : '<span style="color:#667085;font-weight:700;">Draft</span>'}</td>
          <td>${escapeHtml(date)}</td>
          <td class="actions">
            <a href="/admin/posts/${post.id}/edit" class="btn btn-sm">Edit</a>
            <form method="POST" action="/admin/posts/${post.id}/delete" style="display:inline;" onsubmit="return confirm('Delete this post?')">
              <input type="hidden" name="csrf_token" value="${escapeHtml(req.adminSession.csrf)}">
              <button type="submit" class="btn btn-sm btn-danger">Delete</button>
            </form>
          </td>
        </tr>`;
      })
      .join('');

    res.send(
      layout(
        'Posts',
        `
        <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:24px;">
          <div>
            <h1 class="page-title">Posts</h1>
            <p class="page-subtitle">Write company updates, publish launches, and embed product video directly in a post.</p>
          </div>
          <a href="/admin/posts/new" class="btn">New Post</a>
        </div>
        ${success}
        ${error}
        <table class="admin-table">
          <thead><tr><th>Title</th><th>Category</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" style="text-align:center;padding:36px;color:#667085;">No posts yet.</td></tr>'}</tbody>
        </table>`,
        { isAdmin: true }
      )
    );
  } catch (err) {
    console.error(err);
    res.status(500).send(layout('Error', '<p>Something went wrong.</p>', { isAdmin: true }));
  }
});

app.get('/admin/media', adminAuth, async (req, res) => {
  try {
    const db = await getPool();
    const [assets] = await db.execute('SELECT * FROM media_assets ORDER BY created_at DESC');
    const [totals] = await db.execute(
      'SELECT COUNT(*) AS total, COALESCE(SUM(size_bytes), 0) AS total_size FROM media_assets'
    );

    const stats = totals[0] || { total: 0, total_size: 0 };
    const success = req.query.success ? `<div class="alert alert-success">${escapeHtml(req.query.success)}</div>` : '';
    const error = req.query.error ? `<div class="alert alert-error">${escapeHtml(req.query.error)}</div>` : '';
    const rows = assets
      .map((asset) => {
        const publicPath = buildMediaPublicPath(asset);
        const shortcode = buildMediaShortcode(asset);
        return `<tr>
          <td>
            <div style="font-weight:800;">${escapeHtml(asset.original_name)}</div>
            <div class="form-help">${escapeHtml(asset.mime_type)} • ${escapeHtml(formatBytes(asset.size_bytes))}</div>
          </td>
          <td><span class="media-chip media-chip--${escapeHtml(asset.kind)}">${escapeHtml(asset.kind)}</span></td>
          <td>
            <code class="media-code">${escapeHtml(publicPath)}</code>
            ${asset.kind === 'image' || asset.kind === 'video' ? `<code class="media-code">${escapeHtml(shortcode)}</code>` : ''}
          </td>
          <td>${escapeHtml(formatDate(asset.created_at))}</td>
          <td class="actions">
            <a href="${escapeHtml(publicPath)}" class="btn btn-sm btn-secondary" target="_blank" rel="noreferrer">Open</a>
            <form method="POST" action="/admin/media/${asset.id}/delete" style="display:inline;" onsubmit="return confirm('Delete this media asset? Existing embeds will stop working.')">
              <input type="hidden" name="csrf_token" value="${escapeHtml(req.adminSession.csrf)}">
              <button type="submit" class="btn btn-sm btn-danger">Delete</button>
            </form>
          </td>
        </tr>`;
      })
      .join('');

    res.send(
      layout(
        'Media',
        `
        <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:24px;">
          <div>
            <h1 class="page-title">Media</h1>
            <p class="page-subtitle">Upload images and video to Dailey OS storage, then paste the generated paths into your posts.</p>
            <div class="stat-pills">
              <span class="stat-pill">${escapeHtml(String(stats.total))} asset${Number(stats.total) === 1 ? '' : 's'}</span>
              <span class="stat-pill">${escapeHtml(formatBytes(stats.total_size))} stored</span>
              <span class="stat-pill">${hasStorageConfig() ? 'Storage connected' : 'Storage unavailable'}</span>
            </div>
          </div>
        </div>
        ${success}
        ${error}
        <div class="admin-grid">
          <section class="admin-card">
            <h2>Upload Asset</h2>
            <p>Files are stored in S3-compatible object storage so embeds survive restarts, redeploys, and replica changes.</p>
            ${
              hasStorageConfig()
                ? `
            <form method="POST" action="/admin/media" enctype="multipart/form-data" style="margin-top:18px;">
              <input type="hidden" name="csrf_token" value="${escapeHtml(req.adminSession.csrf)}">
              <div class="form-group" style="margin-bottom:12px;">
                <label>Media File</label>
                <input type="file" name="file" accept="image/avif,image/gif,image/jpeg,image/png,image/webp,video/mp4,video/ogg,video/quicktime,video/webm,video/x-m4v" required>
              </div>
              <div class="form-help">Supported: JPG, PNG, WebP, GIF, AVIF, MP4, WebM, OGG, MOV, M4V. Max ${Math.round(
                MEDIA_UPLOAD_MAX_BYTES / (1024 * 1024)
              )} MB.</div>
              <button type="submit" class="btn" style="margin-top:16px;">Upload Media</button>
            </form>`
                : `
            <div class="alert alert-error" style="margin-top:18px;">
              Storage env vars are missing. Enable storage for this project in Dailey OS before uploading media.
            </div>`
            }
          </section>
          <aside class="notes-card" style="margin:0;">
            <strong>Usage</strong>
            <p>Video shortcode: <code>{{video:/media/123/launch-demo.mp4|Optional caption}}</code></p>
            <p>Image shortcode: <code>{{image:/media/456/team-photo.webp|Optional caption}}</code></p>
            <p>YouTube still works with <code>{{youtube:https://www.youtube.com/watch?v=VIDEO_ID|Optional caption}}</code>.</p>
            <p>${STORAGE_BUCKET ? `Bucket <code>${escapeHtml(STORAGE_BUCKET)}</code>` : 'Bucket will come from Dailey OS at runtime.'}${
              STORAGE_PREFIX ? ` Prefix <code>${escapeHtml(STORAGE_PREFIX)}</code>.` : ''
            }</p>
          </aside>
        </div>
        <table class="admin-table">
          <thead><tr><th>Asset</th><th>Type</th><th>Embed Path</th><th>Uploaded</th><th>Actions</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" style="text-align:center;padding:36px;color:#667085;">No media uploaded yet.</td></tr>'}</tbody>
        </table>`,
        { isAdmin: true }
      )
    );
  } catch (err) {
    console.error(err);
    res.status(500).send(layout('Error', '<p>Something went wrong.</p>', { isAdmin: true }));
  }
});

app.post('/admin/media', adminAuth, requireTrustedOrigin, requireStorageForAdmin, handleMediaUpload, requireAdminCsrf, async (req, res) => {
  try {
    if (!hasStorageConfig()) {
      return res.redirect('/admin/media?error=Storage%20is%20not%20configured%20for%20uploads.');
    }

    if (!req.file) {
      return res.redirect('/admin/media?error=Choose%20a%20file%20before%20uploading.');
    }

    const db = await getPool();
    const kind = mediaKindFromMime(req.file.mimetype);
    const storageKey = buildStorageObjectKey(req.file);

    await getStorageClient().send(
      new PutObjectCommand({
        Bucket: STORAGE_BUCKET,
        Key: storageKey,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        CacheControl: kind === 'image' || kind === 'video' ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      })
    );

    await db.execute(
      'INSERT INTO media_assets (original_name, storage_key, mime_type, size_bytes, kind) VALUES (?, ?, ?, ?, ?)',
      [path.basename(req.file.originalname), storageKey, req.file.mimetype, req.file.size, kind]
    );

    res.redirect('/admin/media?success=Media%20uploaded');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/media?error=Upload%20failed');
  }
});

app.post('/admin/media/:id/delete', adminAuth, requireTrustedOrigin, requireStorageForAdmin, requireAdminCsrf, async (req, res) => {
  try {
    if (!hasStorageConfig()) {
      return res.redirect('/admin/media?error=Storage%20is%20not%20configured%20for%20deletes.');
    }

    const db = await getPool();
    const [assets] = await db.execute('SELECT * FROM media_assets WHERE id = ?', [req.params.id]);
    if (assets.length === 0) {
      return res.redirect('/admin/media?error=Media%20asset%20not%20found');
    }

    const asset = assets[0];
    await getStorageClient().send(new DeleteObjectCommand({ Bucket: STORAGE_BUCKET, Key: asset.storage_key }));
    await db.execute('DELETE FROM media_assets WHERE id = ?', [req.params.id]);
    res.redirect('/admin/media?success=Media%20deleted');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/media?error=Delete%20failed');
  }
});

app.get('/admin/posts/new', adminAuth, async (_req, res) => {
  const db = await getPool();
  const [categories] = await db.execute('SELECT * FROM categories ORDER BY name');
  const catOptions = categories
    .map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`)
    .join('');

  res.send(layout('New Post', postForm({ catOptions, csrfToken: _req.adminSession.csrf }), { isAdmin: true }));
});

app.post('/admin/posts', adminAuth, requireTrustedOrigin, requireAdminCsrf, async (req, res) => {
  try {
    const db = await getPool();
    const { title, content, excerpt, category_id, tags, published } = req.body;
    const slug = slugify(title);
    const tagsArr = tags ? tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [];
    const isPublished = published === 'on' ? 1 : 0;

    await db.execute(
      `INSERT INTO posts (title, slug, content, excerpt, category_id, tags, published, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, slug, content, excerpt || null, category_id || null, JSON.stringify(tagsArr), isPublished, isPublished ? new Date() : null]
    );

    res.redirect('/admin?success=Post+created');
  } catch (err) {
    console.error(err);
    res.redirect('/admin?error=1');
  }
});

app.get('/admin/posts/:id/edit', adminAuth, async (req, res) => {
  try {
    const db = await getPool();
    const [posts] = await db.execute('SELECT * FROM posts WHERE id = ?', [req.params.id]);
    if (posts.length === 0) return res.redirect('/admin');

    const post = posts[0];
    const [categories] = await db.execute('SELECT * FROM categories ORDER BY name');
    const catOptions = categories
      .map(
        (category) =>
          `<option value="${category.id}" ${category.id === post.category_id ? 'selected' : ''}>${escapeHtml(category.name)}</option>`
      )
      .join('');

    res.send(
      layout(
        'Edit Post',
        postForm({
          catOptions,
          action: `/admin/posts/${post.id}`,
          csrfToken: req.adminSession.csrf,
          post,
          tags: parseTags(post.tags).join(', '),
          isEdit: true,
        }),
        { isAdmin: true }
      )
    );
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});

app.post('/admin/posts/:id', adminAuth, requireTrustedOrigin, requireAdminCsrf, async (req, res) => {
  try {
    const db = await getPool();
    const { title, content, excerpt, category_id, tags, published } = req.body;
    const slug = slugify(title);
    const tagsArr = tags ? tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [];
    const isPublished = published === 'on' ? 1 : 0;

    await db.execute(
      `UPDATE posts
       SET title = ?, slug = ?, content = ?, excerpt = ?, category_id = ?, tags = ?, published = ?,
           published_at = COALESCE(published_at, IF(?, NOW(), NULL)),
           updated_at = NOW()
       WHERE id = ?`,
      [title, slug, content, excerpt || null, category_id || null, JSON.stringify(tagsArr), isPublished, isPublished, req.params.id]
    );

    res.redirect('/admin?success=Post+updated');
  } catch (err) {
    console.error(err);
    res.redirect('/admin?error=1');
  }
});

app.post('/admin/posts/:id/delete', adminAuth, requireTrustedOrigin, requireAdminCsrf, async (req, res) => {
  try {
    const db = await getPool();
    await db.execute('DELETE FROM posts WHERE id = ?', [req.params.id]);
    res.redirect('/admin?success=Post+deleted');
  } catch (err) {
    console.error(err);
    res.redirect('/admin?error=1');
  }
});

app.get('/admin/categories', adminAuth, async (_req, res) => {
  try {
    const db = await getPool();
    const [categories] = await db.execute('SELECT * FROM categories ORDER BY name');
    const rows = categories
      .map(
        (category) => `<tr>
          <td>${escapeHtml(category.name)}</td>
          <td style="color:#667085;">${escapeHtml(category.slug)}</td>
          <td>
            <form method="POST" action="/admin/categories/${category.id}/delete" style="display:inline;" onsubmit="return confirm('Delete this category?')">
              <input type="hidden" name="csrf_token" value="${escapeHtml(_req.adminSession.csrf)}">
              <button type="submit" class="btn btn-sm btn-danger">Delete</button>
            </form>
          </td>
        </tr>`
      )
      .join('');

    res.send(
      layout(
        'Categories',
        `
        <h1 class="page-title">Categories</h1>
        <p class="page-subtitle">Keep the blog taxonomy tight. A few strong buckets reads better than a crowded category list.</p>
        <form method="POST" action="/admin/categories" style="display:flex;gap:12px;flex-wrap:wrap;margin:24px 0;">
          <input type="hidden" name="csrf_token" value="${escapeHtml(_req.adminSession.csrf)}">
          <input type="text" name="name" placeholder="New category name" required style="flex:1;min-width:220px;padding:12px 14px;border:1px solid #d8dee9;border-radius:12px;font-size:15px;">
          <button type="submit" class="btn">Add</button>
        </form>
        <table class="admin-table">
          <thead><tr><th>Name</th><th>Slug</th><th>Actions</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="3" style="text-align:center;padding:36px;color:#667085;">No categories yet.</td></tr>'}</tbody>
        </table>`,
        { isAdmin: true }
      )
    );
  } catch (err) {
    console.error(err);
    res.status(500).send(layout('Error', '<p>Something went wrong.</p>', { isAdmin: true }));
  }
});

app.post('/admin/categories', adminAuth, requireTrustedOrigin, requireAdminCsrf, async (req, res) => {
  try {
    const db = await getPool();
    const { name } = req.body;
    await db.execute('INSERT INTO categories (name, slug) VALUES (?, ?)', [name, slugify(name)]);
    res.redirect('/admin/categories');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/categories');
  }
});

app.post('/admin/categories/:id/delete', adminAuth, requireTrustedOrigin, requireAdminCsrf, async (req, res) => {
  try {
    const db = await getPool();
    await db.execute('DELETE FROM categories WHERE id = ?', [req.params.id]);
    res.redirect('/admin/categories');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/categories');
  }
});

function postForm({ catOptions, action, csrfToken, post, tags, isEdit }) {
  const currentPost = post || {};
  const encodedContent = escapeHtml(currentPost.content || '');

  return `
    <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;">
      <div>
        <h1 class="page-title">${isEdit ? 'Edit Post' : 'New Post'}</h1>
        <p class="page-subtitle">Keep the writing clean and the layout simple. The post body supports Markdown plus video shortcodes.</p>
      </div>
    </div>
    <div class="notes-card">
      <strong>Video Embeds</strong>
      <p>Use <code>{{youtube:https://www.youtube.com/watch?v=VIDEO_ID|Optional caption}}</code> for a YouTube embed.</p>
      <p>Use <code>{{video:/media/123/launch-demo.mp4|Optional caption}}</code> for hosted video and <code>{{image:/media/456/team-photo.webp|Optional caption}}</code> for hosted images.</p>
      <p>Upload assets in <a href="/admin/media">Media</a>. Every upload gets a stable <code>/media/...</code> path backed by Dailey OS object storage.</p>
    </div>
    <form method="POST" action="${action || '/admin/posts'}" style="margin-top:24px;">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken || '')}">
      <div class="form-group">
        <label>Title</label>
        <input type="text" name="title" value="${escapeHtml(currentPost.title || '')}" required>
      </div>
      <div class="form-group">
        <label>Excerpt</label>
        <input type="text" name="excerpt" value="${escapeHtml(currentPost.excerpt || '')}" placeholder="Short summary for the home page and SEO cards">
      </div>
      <div class="form-group">
        <label>Category</label>
        <select name="category_id"><option value="">— None —</option>${catOptions}</select>
      </div>
      <div class="form-group">
        <label>Tags (comma-separated)</label>
        <input type="text" name="tags" value="${escapeHtml(tags || '')}" placeholder="e.g. launch, engineering, company">
      </div>
      <div class="form-group">
        <label>Content (Markdown)</label>
        <textarea name="content" required>${encodedContent}</textarea>
        <div class="form-help">Markdown is supported for headings, lists, links, inline code, block quotes, and the media shortcodes above.</div>
      </div>
      <div class="form-group checkbox-group">
        <input type="checkbox" name="published" id="published" ${currentPost.published ? 'checked' : ''}>
        <label for="published" style="margin:0;">Published</label>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:24px;">
        <button type="submit" class="btn">${isEdit ? 'Update Post' : 'Create Post'}</button>
        <a href="/admin" class="btn btn-secondary">Cancel</a>
      </div>
    </form>`;
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

function validateSecurityConfig() {
  const issues = [];
  const warnings = [];

  if (ADMIN_PASSWORD === 'admin') {
    issues.push('ADMIN_PASSWORD is still set to the default value.');
  }

  if (!ADMIN_SESSION_SECRET) {
    issues.push('ADMIN_SESSION_SECRET is not set.');
  }

  if (!hasStorageConfig()) {
    const storageMessage =
      'S3-compatible storage is not configured. Enable storage in Dailey OS or set S3_ENDPOINT, S3_BUCKET_NAME, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY.';

    if (IS_PRODUCTION) {
      issues.push(storageMessage);
    } else {
      warnings.push(storageMessage);
    }
  }

  warnings.forEach((warning) => {
    console.warn(`[storage] ${warning} Uploads and hosted media are disabled until configured.`);
  });

  if (issues.length === 0) return;

  const message = issues.join(' ');
  if (IS_PRODUCTION) {
    throw new Error(message);
  }

  console.warn(`[security] ${message} Development fallback mode is enabled; set both before deploying.`);
}

app.use((req, res) => {
  res.status(404).send(layout('Not Found', renderBombDialog('Sorry, a system error occurred.', 'That page could not be found.', 404)));
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).send(layout('Error', renderBombDialog('Sorry, a system error occurred.', 'Something went wrong on our end.', 500)));
});

async function start() {
  validateSecurityConfig();

  try {
    await migrate();
  } catch (err) {
    console.error('[startup] Migration failed, continuing...', err.message);
  }

  app.listen(PORT, () => {
    console.log(`Blog running on port ${PORT}`);
  });
}

start();
