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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "script-src 'none'",
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
      trimmed.startsWith('<figure class="embed-block"') ||
      trimmed.startsWith('</')
    ) {
      rendered.push(trimmed);
    } else {
      rendered.push(`<p>${trimmed}</p>`);
    }
  }

  return rendered.join('\n').replace(/<\/ul>\s*<ul>/g, '');
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

function renderCategoryPill(name, slug) {
  if (!name) return '';
  const color = getCategoryColor(slug);
  return `<span class="category-pill" style="background:${color.bg};color:${color.text};border-color:${color.border};">${escapeHtml(
    name
  )}</span>`;
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
    <article class="featured-post">
      <div class="featured-label">Featured Story</div>
      ${renderCategoryPill(post.category_name, post.category_slug)}
      <h2><a href="/post/${escapeHtml(post.slug)}">${escapeHtml(post.title)}</a></h2>
      ${renderMeta(post)}
      <p class="featured-summary">${escapeHtml(post.excerpt || SITE_DESCRIPTION)}</p>
      <div class="post-footer-bar">
        ${renderTagList(tags)}
        <a href="/post/${escapeHtml(post.slug)}" class="row-arrow">Read story</a>
      </div>
    </article>`;
}

function renderPostRow(post) {
  const tags = parseTags(post.tags);
  const date = formatDate(post.published_at || post.created_at);

  return `
    <article class="post-row">
      <div class="post-row-date">${escapeHtml(date)}</div>
      <div>
        <div class="row-topline">
          ${renderCategoryPill(post.category_name, post.category_slug)}
          <span class="row-reading-time">${escapeHtml(readingTime(post.content))}</span>
        </div>
        <h3><a href="/post/${escapeHtml(post.slug)}">${escapeHtml(post.title)}</a></h3>
        <p>${escapeHtml(post.excerpt || '')}</p>
        ${renderTagList(tags)}
      </div>
      <a href="/post/${escapeHtml(post.slug)}" class="row-arrow">Read story</a>
    </article>`;
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
  <style>
    :root {
      /* Dailey brand-blue 1997 web-zine palette */
      --royal: #315FAC;       /* deep royal blue — masthead/banner */
      --cyan: #0093CB;        /* cyan-blue — links, nav, titles */
      --sky: #73D1F8;         /* light blue — hovers, accent rules */
      --pale: #C3E8F7;        /* pale sky — panel-header tints */
      --bg: #eef6fb;          /* paper — pale blue page background */
      --panel: #ffffff;
      --ink: #14213d;         /* deep navy-blue body text */
      --muted: #4a5b7a;
      --line: #9fc4e6;
      --accent: #0093CB;
      --accent-strong: #315FAC;
      --accent-soft: #C3E8F7;
      --danger: #b42318;
      --danger-soft: #fef3f2;
      --success: #027a48;
      --success-soft: #ecfdf3;
      --admin-ink: #14213d;
      --admin-line: #9fc4e6;
      /* beveled "3D" edge colors (Win95 look) */
      --bevel-light: #ffffff;
      --bevel-dark: #1f4a86;
      --bevel-mid: #73D1F8;
      /* period-accurate system fonts */
      --font-body: Verdana, Geneva, Arial, sans-serif;
      --font-head: Georgia, 'Times New Roman', serif;
      --font-mono: 'Courier New', Courier, monospace;
    }

    *, *::before, *::after { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      font-family: var(--font-body);
      font-size: 15px;
      line-height: 1.65;
      color: var(--ink);
      background: var(--bg);
    }
    a { color: var(--cyan); text-decoration: underline; }
    a:hover { color: var(--royal); }

    .site-nav {
      background: var(--royal);
    }

    /* ===== Masthead banner (deep-blue, beveled) ===== */
    .masthead {
      max-width: 1120px;
      margin: 0 auto;
      padding: 22px 32px 18px;
      background: var(--royal);
      color: #fff;
      /* Win95 3D bevel: light top/left, dark bottom/right */
      border-top: 2px solid var(--bevel-mid);
      border-left: 2px solid var(--bevel-mid);
      border-bottom: 3px solid var(--bevel-dark);
      border-right: 3px solid var(--bevel-dark);
    }
    .masthead-name {
      display: inline-flex;
      align-items: baseline;
      font-family: var(--font-head);
      font-size: clamp(2rem, 6vw, 3.4rem);
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0.01em;
      color: #fff;
      text-decoration: none;
      text-shadow: 2px 2px 0 rgba(20, 33, 61, 0.45);
    }
    .masthead-name:hover { color: var(--sky); }
    .masthead-mark {
      width: 14px;
      height: 14px;
      margin-right: 12px;
      background: var(--sky);
      border: 2px solid #fff;
      flex: none;
      align-self: center;
    }
    .masthead-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 16px;
      margin-top: 12px;
      font-family: var(--font-mono);
      font-size: 12px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--pale);
    }
    .masthead-tagline { color: var(--sky); }
    .masthead-date { color: #fff; letter-spacing: 0.16em; }
    .masthead-rule {
      height: 4px;
      max-width: 1120px;
      margin: 0 auto;
      background: linear-gradient(90deg, var(--sky) 0 50%, var(--cyan) 50% 100%);
      border-bottom: 2px solid var(--bevel-dark);
    }

    /* ===== Nav bar (Win95 button row) ===== */
    .nav-inner {
      max-width: 1120px;
      margin: 0 auto;
      padding: 8px 32px;
      min-height: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      background: var(--pale);
      border-bottom: 2px solid var(--bevel-dark);
    }
    .logo {
      display: none;
    }
    .logo-mark { display: none; }
    .site-nav nav {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .site-nav nav a {
      padding: 6px 14px;
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      text-decoration: none;
      color: var(--royal);
      background: var(--panel);
      border-top: 2px solid var(--bevel-light);
      border-left: 2px solid var(--bevel-light);
      border-bottom: 2px solid var(--bevel-dark);
      border-right: 2px solid var(--bevel-dark);
    }
    .site-nav nav a:hover {
      color: var(--royal);
      background: var(--sky);
    }
    .site-nav nav a.nav-rss {
      color: #fff;
      background: var(--cyan);
    }
    .site-nav nav a.nav-rss:hover {
      color: var(--royal);
      background: var(--sky);
    }

    .container {
      max-width: 1120px;
      margin: 0 auto;
      padding: 0 32px;
    }
    .container--narrow {
      max-width: 860px;
      margin: 0 auto;
      padding: 0 32px;
    }
    main {
      min-height: calc(100vh - 190px);
      padding: 24px 0 72px;
    }

    .page-intro {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(240px, 280px);
      gap: 24px;
      align-items: end;
      padding: 32px 0 28px;
      /* 3D groove divider */
      border-bottom: 1px solid var(--bevel-dark);
      box-shadow: 0 1px 0 #fff;
      margin-bottom: 4px;
    }
    .eyebrow {
      display: inline-block;
      margin-bottom: 14px;
      padding: 4px 10px;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--royal);
      background: var(--pale);
      border-top: 1px solid var(--bevel-light);
      border-left: 1px solid var(--bevel-light);
      border-bottom: 2px solid var(--bevel-dark);
      border-right: 2px solid var(--bevel-dark);
    }
    .page-intro h1,
    .post-header h1,
    .featured-post h2,
    .post-row h3,
    .page-title,
    .login-box h1 {
      margin: 0;
      font-family: var(--font-head);
      letter-spacing: 0;
      color: var(--royal);
    }
    .page-intro h1 {
      max-width: 14ch;
      font-size: clamp(2.4rem, 6vw, 4rem);
      line-height: 1.02;
    }
    .page-intro p {
      max-width: 48rem;
      margin: 16px 0 0;
      font-size: 16px;
      color: var(--muted);
    }
    .intro-note {
      padding: 0;
      background: var(--panel);
      border-top: 2px solid var(--bevel-light);
      border-left: 2px solid var(--bevel-light);
      border-bottom: 3px solid var(--bevel-dark);
      border-right: 3px solid var(--bevel-dark);
      box-shadow: 2px 2px 0 rgba(20, 33, 61, 0.12);
    }
    .intro-note strong {
      display: block;
      margin-bottom: 0;
      padding: 8px 14px;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--royal);
      background: var(--pale);
      border-bottom: 1px solid var(--bevel-dark);
    }
    .intro-note p {
      margin: 0;
      padding: 14px 16px;
      font-size: 13px;
      color: var(--muted);
    }

    .category-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 20px 0 28px;
    }
    .category-bar a {
      padding: 6px 12px;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      text-decoration: none;
      color: var(--cyan);
      background: var(--panel);
      border-top: 2px solid var(--bevel-light);
      border-left: 2px solid var(--bevel-light);
      border-bottom: 2px solid var(--bevel-dark);
      border-right: 2px solid var(--bevel-dark);
    }
    .category-bar a:hover { color: var(--royal); background: var(--sky); }
    .category-bar a.active {
      color: #fff;
      background: var(--cyan);
    }

    .featured-post {
      padding: 28px;
      background: var(--panel);
      border-top: 2px solid var(--bevel-light);
      border-left: 2px solid var(--bevel-light);
      border-bottom: 4px solid var(--bevel-dark);
      border-right: 4px solid var(--bevel-dark);
      box-shadow: 3px 3px 0 rgba(20, 33, 61, 0.15);
      margin-bottom: 36px;
    }
    .featured-label {
      display: inline-block;
      padding: 4px 10px;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: #fff;
      background: var(--cyan);
      margin-bottom: 14px;
    }
    .featured-post h2 {
      max-width: 18ch;
      font-size: clamp(1.9rem, 4vw, 2.8rem);
      line-height: 1.05;
      margin: 14px 0;
    }
    .featured-post h2 a { color: var(--royal); text-decoration: none; }
    .featured-post h2 a:hover { color: var(--cyan); text-decoration: underline; }
    .featured-summary {
      max-width: 46rem;
      font-size: 15px;
      color: var(--ink);
      margin: 16px 0 0;
    }
    .post-footer-bar {
      margin-top: 22px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    .category-pill {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 4px 10px;
      border: 0;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #fff;
      background: var(--cyan);
    }
    .meta-row {
      display: flex;
      align-items: center;
      gap: 10px 12px;
      flex-wrap: wrap;
      color: var(--muted);
      font-family: var(--font-mono);
      font-size: 12px;
      letter-spacing: 0.04em;
      margin: 16px 0 0;
    }
    .dot {
      width: 4px;
      height: 4px;
      background: var(--sky);
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 4px 9px;
      border: 1px solid var(--line);
      background: var(--bg);
      color: var(--royal);
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
    }
    .post-section-title {
      display: inline-block;
      padding: 6px 12px;
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--royal);
      background: var(--pale);
      border-top: 1px solid var(--bevel-light);
      border-left: 1px solid var(--bevel-light);
      border-bottom: 2px solid var(--bevel-dark);
      border-right: 2px solid var(--bevel-dark);
      margin: 0 0 14px;
    }
    .post-list {
      border-top: 2px solid var(--bevel-dark);
      box-shadow: 0 1px 0 #fff inset;
    }
    .post-row {
      display: grid;
      grid-template-columns: 160px minmax(0, 1fr) auto;
      gap: 20px;
      align-items: start;
      padding: 22px 0;
      border-bottom: 1px solid var(--line);
    }
    .post-row-date {
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--cyan);
      padding-top: 4px;
    }
    .row-topline {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 12px;
      align-items: center;
      margin-bottom: 12px;
    }
    .row-reading-time {
      font-size: 13px;
      font-weight: 700;
      color: var(--muted);
    }
    .post-row h3 {
      font-size: clamp(1.4rem, 3vw, 1.9rem);
      line-height: 1.12;
      margin-bottom: 10px;
    }
    .post-row h3 a { color: var(--cyan); text-decoration: none; }
    .post-row h3 a:hover { color: var(--royal); text-decoration: underline; }
    .post-row p {
      margin: 0 0 12px;
      max-width: 40rem;
      font-size: 14px;
      color: var(--muted);
    }
    .row-arrow,
    .back-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--cyan);
      text-decoration: underline;
      white-space: nowrap;
    }
    .row-arrow:hover,
    .back-link:hover { color: var(--royal); }
    .empty-state {
      padding: 56px 24px;
      border: 2px dashed var(--line);
      text-align: center;
      color: var(--muted);
      background: var(--panel);
    }
    .empty-state p {
      margin: 0;
      font-size: 16px;
    }

    .post-shell { padding-top: 16px; }
    .post-header {
      padding: 24px 0 24px;
      border-bottom: 2px solid var(--bevel-dark);
      box-shadow: 0 1px 0 #fff;
      margin-bottom: 30px;
    }
    .post-header h1 {
      max-width: 22ch;
      font-size: clamp(2rem, 5vw, 3.4rem);
      line-height: 1.05;
      margin: 16px 0;
    }
    .post-subtitle {
      max-width: 44rem;
      margin: 16px 0 0;
      font-size: 16px;
      color: var(--muted);
    }
    .post-content {
      font-size: 16px;
      color: var(--ink);
    }
    .post-content h1 {
      margin: 34px 0 14px;
      font-family: var(--font-head);
      color: var(--royal);
      font-size: 30px;
      line-height: 1.15;
    }
    .post-content h2 {
      margin: 36px 0 14px;
      font-family: var(--font-head);
      color: var(--royal);
      font-size: 24px;
      line-height: 1.2;
    }
    .post-content h3 {
      margin: 26px 0 10px;
      font-family: var(--font-head);
      color: var(--royal);
      font-size: 19px;
      line-height: 1.3;
      font-weight: 700;
    }
    .post-content p,
    .post-content li {
      color: var(--ink);
      line-height: 1.75;
    }
    .post-content p { margin: 16px 0; }
    .post-content ul,
    .post-content ol { margin: 16px 0 16px 26px; }
    .post-content li { margin: 8px 0; }
    .post-content strong { font-weight: 700; color: var(--ink); }
    .post-content code {
      padding: 2px 6px;
      background: var(--pale);
      color: var(--royal);
      font-family: var(--font-mono);
      font-size: 14px;
    }
    .post-content pre {
      margin: 26px 0;
      padding: 20px;
      background: #14213d;
      color: #e2e8f0;
      overflow-x: auto;
      border-top: 2px solid var(--bevel-light);
      border-left: 2px solid var(--bevel-light);
      border-bottom: 3px solid var(--bevel-dark);
      border-right: 3px solid var(--bevel-dark);
    }
    .post-content pre code {
      padding: 0;
      background: none;
      color: inherit;
      font-size: 13px;
    }
    .post-content hr {
      border: 0;
      border-top: 2px solid var(--bevel-dark);
      box-shadow: 0 1px 0 #fff;
      margin: 34px 0;
    }
    .post-content a {
      color: var(--cyan);
      text-decoration: underline;
    }
    .post-content a:hover { color: var(--royal); }
    .post-content blockquote {
      margin: 26px 0;
      padding: 10px 0 10px 18px;
      border-left: 4px solid var(--sky);
      background: var(--bg);
      color: var(--muted);
    }
    .post-content blockquote p { margin: 0; }
    .embed-block { margin: 34px 0; }
    .embed-shell {
      position: relative;
      padding-top: 56.25%;
      overflow: hidden;
      border-top: 2px solid var(--bevel-light);
      border-left: 2px solid var(--bevel-light);
      border-bottom: 3px solid var(--bevel-dark);
      border-right: 3px solid var(--bevel-dark);
      background: #14213d;
      box-shadow: 3px 3px 0 rgba(20, 33, 61, 0.15);
    }
    .embed-shell iframe,
    .embed-shell video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      border: 0;
      object-fit: cover;
      background: #101828;
    }
    .embed-caption {
      margin: 12px 0 0;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--muted);
      text-align: center;
    }
    .image-embed {
      margin: 34px 0;
    }
    .image-embed img {
      display: block;
      width: 100%;
      border-top: 2px solid var(--bevel-light);
      border-left: 2px solid var(--bevel-light);
      border-bottom: 3px solid var(--bevel-dark);
      border-right: 3px solid var(--bevel-dark);
      background: #fff;
      box-shadow: 3px 3px 0 rgba(20, 33, 61, 0.12);
    }
    .image-embed .embed-caption {
      margin-top: 12px;
    }
    .post-footer {
      margin-top: 34px;
      padding-top: 24px;
      border-top: 2px solid var(--bevel-dark);
      box-shadow: 0 1px 0 #fff;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    footer {
      margin-top: 56px;
      background: var(--royal);
      color: var(--pale);
      border-top: 3px solid var(--bevel-mid);
      padding: 26px 0 36px;
    }
    .footer-inner {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      flex-wrap: wrap;
    }
    .footer-name {
      font-family: var(--font-head);
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.02em;
      color: #fff;
    }
    .footer-copy,
    .footer-links {
      font-family: var(--font-mono);
      font-size: 12px;
      letter-spacing: 0.04em;
      color: var(--pale);
    }
    .footer-links a { color: var(--sky); }
    .footer-links a:hover { color: #fff; }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      padding: 0 18px;
      background: var(--cyan);
      color: #fff;
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      text-decoration: none;
      cursor: pointer;
      border-top: 2px solid var(--bevel-light);
      border-left: 2px solid var(--bevel-light);
      border-bottom: 3px solid var(--bevel-dark);
      border-right: 3px solid var(--bevel-dark);
    }
    .btn:hover {
      color: var(--royal);
      background: var(--sky);
    }
    .btn:active {
      border-top: 3px solid var(--bevel-dark);
      border-left: 3px solid var(--bevel-dark);
      border-bottom: 2px solid var(--bevel-light);
      border-right: 2px solid var(--bevel-light);
    }
    .btn-danger {
      background: var(--danger);
      color: #fff;
    }
    .btn-danger:hover {
      background: #d4453a;
      color: #fff;
    }
    .btn-sm {
      min-height: 34px;
      padding: 0 12px;
      font-size: 12px;
    }
    .btn-secondary {
      background: #5a6b8a;
      color: #fff;
    }
    .btn-secondary:hover {
      background: #6c7d9c;
      color: #fff;
    }

    .admin-header { background: var(--royal); }
    .admin-header .nav-inner {
      background: var(--royal);
      border-bottom: 3px solid var(--bevel-dark);
      border-top: 2px solid var(--bevel-mid);
      justify-content: space-between;
    }
    .admin-header .logo {
      display: inline-flex;
      align-items: center;
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      text-decoration: none;
      color: #fff;
    }
    .admin-header .logo:hover { color: var(--sky); }
    .admin-header nav a.nav-rss { color: #fff; }

    .admin-table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border-top: 2px solid var(--bevel-light);
      border-left: 2px solid var(--bevel-light);
      border-bottom: 3px solid var(--bevel-dark);
      border-right: 3px solid var(--bevel-dark);
    }
    .admin-table th {
      text-align: left;
      padding: 12px 16px;
      background: var(--pale);
      color: var(--royal);
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      border-bottom: 2px solid var(--bevel-dark);
    }
    .admin-table td {
      padding: 14px 16px;
      border-top: 1px solid var(--line);
      font-size: 14px;
      color: var(--admin-ink);
      vertical-align: top;
    }
    .admin-table tr:hover td { background: var(--bg); }
    .page-title {
      font-size: 34px;
      line-height: 1.05;
    }
    .page-subtitle {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 16px;
    }
    .form-group {
      margin-bottom: 18px;
    }
    .form-group label {
      display: block;
      margin-bottom: 7px;
      font-size: 14px;
      font-weight: 800;
      color: var(--admin-ink);
    }
    .form-group input,
    .form-group textarea,
    .form-group select {
      width: 100%;
      padding: 10px 12px;
      border-top: 2px solid var(--bevel-dark);
      border-left: 2px solid var(--bevel-dark);
      border-bottom: 1px solid var(--bevel-light);
      border-right: 1px solid var(--bevel-light);
      background: #fff;
      color: var(--admin-ink);
      font: inherit;
    }
    .form-group textarea {
      min-height: 340px;
      line-height: 1.6;
      resize: vertical;
      font-family: var(--font-mono);
    }
    .form-group input:focus,
    .form-group textarea:focus,
    .form-group select:focus {
      outline: 2px solid var(--cyan);
      outline-offset: 0;
    }
    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .checkbox-group input[type="checkbox"] { width: auto; }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .alert {
      padding: 12px 14px;
      margin-bottom: 18px;
      font-size: 14px;
      font-weight: 700;
    }
    .alert-error {
      background: var(--danger-soft);
      color: var(--danger);
      border: 1px solid #fecdca;
    }
    .alert-success {
      background: var(--success-soft);
      color: var(--success);
      border: 1px solid #abefc6;
    }
    .login-box {
      max-width: 440px;
      margin: 56px auto 0;
      padding: 34px;
      background: var(--panel);
      border-top: 2px solid var(--bevel-light);
      border-left: 2px solid var(--bevel-light);
      border-bottom: 4px solid var(--bevel-dark);
      border-right: 4px solid var(--bevel-dark);
      box-shadow: 3px 3px 0 rgba(20, 33, 61, 0.18);
    }
    .login-box h1 {
      font-size: 30px;
      margin-bottom: 20px;
      text-align: center;
    }
    .notes-card {
      margin-bottom: 18px;
      padding: 16px 18px;
      border: 1px solid var(--line);
      background: var(--bg);
    }
    .notes-card strong {
      display: block;
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--royal);
    }
    .notes-card p {
      margin: 10px 0 0;
      font-size: 14px;
      color: var(--muted);
    }
    .notes-card code,
    .form-help code {
      padding: 2px 6px;
      background: var(--pale);
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .form-help {
      margin-top: 8px;
      font-size: 13px;
      color: var(--muted);
    }
    .admin-grid {
      display: grid;
      grid-template-columns: minmax(0, 360px) minmax(0, 1fr);
      gap: 20px;
      margin-bottom: 24px;
      align-items: start;
    }
    .admin-card {
      padding: 22px;
      border-top: 2px solid var(--bevel-light);
      border-left: 2px solid var(--bevel-light);
      border-bottom: 3px solid var(--bevel-dark);
      border-right: 3px solid var(--bevel-dark);
      background: var(--panel);
    }
    .admin-card h2 {
      margin: 0 0 8px;
      font-family: var(--font-head);
      font-size: 18px;
      font-weight: 700;
      color: var(--royal);
    }
    .admin-card p {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
    }
    .media-chip {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 3px 10px;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      border: 1px solid transparent;
    }
    .media-chip--video {
      color: #fff;
      background: #9e255d;
    }
    .media-chip--image {
      color: #fff;
      background: var(--cyan);
    }
    .media-chip--file {
      color: var(--royal);
      background: var(--pale);
      border-color: var(--line);
    }
    .media-code {
      display: block;
      margin-top: 8px;
      padding: 10px 12px;
      background: var(--bg);
      border: 1px solid var(--line);
      color: var(--ink);
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .stat-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 16px;
    }
    .stat-pill {
      display: inline-flex;
      align-items: center;
      min-height: 32px;
      padding: 6px 12px;
      background: var(--pale);
      border: 1px solid var(--line);
      color: var(--royal);
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
    }

    @media (max-width: 900px) {
      .page-intro,
      .post-row,
      .admin-grid {
        grid-template-columns: 1fr;
      }
      .post-row-date {
        padding-top: 0;
      }
      .row-arrow {
        justify-self: start;
      }
    }

    @media (max-width: 768px) {
      .masthead,
      .nav-inner,
      .container,
      .container--narrow {
        padding-left: 18px;
        padding-right: 18px;
      }
      .masthead { padding-top: 18px; padding-bottom: 14px; }
      .masthead-meta {
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
        font-size: 11px;
        letter-spacing: 0.16em;
      }
      .site-nav nav {
        width: 100%;
      }
      .site-nav nav a { flex: 1 1 auto; text-align: center; }
      .featured-post {
        padding: 22px;
      }
      .page-intro h1 {
        max-width: 100%;
      }
      .post-header h1 {
        max-width: 100%;
      }
      .post-footer,
      .post-footer-bar,
      .footer-inner {
        align-items: flex-start;
      }
    }

    @media (max-width: 520px) {
      .page-intro {
        padding-top: 24px;
      }
      .featured-post,
      .login-box {
        padding: 18px;
      }
      .admin-table {
        display: block;
        overflow-x: auto;
      }
    }
  </style>
</head>
<body>
  <header class="site-nav${isAdmin ? ' admin-header' : ''}">
    ${isAdmin ? '' : `
    <div class="masthead">
      <a href="/" class="masthead-name"><span class="masthead-mark"></span>${escapeHtml(SITE_NAME)}</a>
      <div class="masthead-meta">
        <span class="masthead-tagline">SOFTWARE &middot; CLOUD</span>
        <span class="masthead-date">${escapeHtml(new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }))}</span>
      </div>
    </div>
    <div class="masthead-rule"></div>`}
    <div class="nav-inner">
      <a href="${isAdmin ? '/admin' : '/'}" class="logo">${isAdmin ? 'Blog Admin' : publicLogo}</a>
      <nav>
        ${isAdmin ? `
          <a href="/admin">Posts</a>
          <a href="/admin/categories">Categories</a>
          <a href="/admin/media">Media</a>
          <a href="/" target="_blank" rel="noreferrer">View Blog</a>
          <a href="/admin/logout">Logout</a>
        ` : `
          <a href="/">Home</a>
          <a href="/rss" class="nav-rss">RSS</a>
        `}
      </nav>
    </div>
  </header>
  ${isAdmin ? `<main><div class="container">${content}</div></main>` : content}
  <footer>
    <div class="container">
      <div class="footer-inner">
        <div>
          <div class="footer-name">${escapeHtml(SITE_NAME)}</div>
          <div class="footer-copy">&copy; ${new Date().getFullYear()} ${escapeHtml(SITE_NAME)}. All rights reserved.</div>
        </div>
        <div class="footer-links">
          Official publishing surface for Dailey, hosted on <a href="https://dailey.cloud" target="_blank" rel="noreferrer">Dailey OS</a>
          with <a href="/admin">the built-in editor</a>.
        </div>
      </div>
    </div>
  </footer>
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
        .send(layout('Not Found', '<main><div class="container"><div class="empty-state"><p>Media asset not found.</p></div></div></main>'));
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
    const categoryLinks = categories
      .map(
        (c) =>
          `<a href="/?category=${escapeHtml(c.slug)}" class="${category === c.slug ? 'active' : ''}">${escapeHtml(
            c.name
          )}</a>`
      )
      .join('');

    const introHtml = `
      <section class="page-intro">
        <div>
          <span class="eyebrow">Official Company Blog</span>
          <h1>${escapeHtml(SITE_NAME)}</h1>
          <p>${escapeHtml(SITE_DESCRIPTION)}</p>
        </div>
        <aside class="intro-note">
          <strong>Video-ready publishing</strong>
          <p>Built for launch notes, engineering explainers, company updates, and embedded product video.</p>
        </aside>
      </section>`;

    const featuredHtml = featuredPost ? renderFeaturedPost(featuredPost) : '';
    const listHtml = otherPosts.length
      ? `
        <section>
          <h2 class="post-section-title">Latest Stories</h2>
          <div class="post-list">${otherPosts.map(renderPostRow).join('')}</div>
        </section>`
      : featuredPost
        ? ''
        : '<div class="empty-state"><p>No posts yet. Check back soon.</p></div>';

    const html = `
      <main>
        <div class="container">
          ${introHtml}
          <div class="category-bar">
            <a href="/" class="${!category ? 'active' : ''}">All Posts</a>
            ${categoryLinks}
          </div>
          ${featuredHtml}
          ${listHtml}
        </div>
      </main>`;

    res.send(layout(SITE_NAME, html, { description: SITE_DESCRIPTION }));
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .send(layout('Error', '<main><div class="container"><div class="empty-state"><p>Blog data is not available yet. Check your database connection and try again.</p></div></div></main>'));
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
            '<main><div class="container"><div class="empty-state"><p>Post not found.</p></div></div></main>'
          )
        );
    }

    const post = posts[0];
    const tags = parseTags(post.tags);
    const html = `
      <main>
        <div class="container--narrow post-shell">
          <header class="post-header">
            ${renderCategoryPill(post.category_name, post.category_slug)}
            <h1>${escapeHtml(post.title)}</h1>
            ${renderMeta(post)}
            ${post.excerpt ? `<p class="post-subtitle">${escapeHtml(post.excerpt)}</p>` : ''}
          </header>
          <article class="post-content">
            ${renderMarkdown(post.content)}
          </article>
          <div class="post-footer">
            ${renderTagList(tags)}
            <a href="/" class="back-link">Back to all posts</a>
          </div>
        </div>
      </main>`;

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
