# Dailey Template Blog

This repo is set up to run as a lean company blog on Dailey OS rather than as a generic demo.

## Why this base

For `blog.dailey.cloud`, this lightweight Express/MySQL app is the better foundation than the heavier `dailey-template-corporate` stack:

- It is much easier to simplify and brand.
- It keeps the authoring path obvious.
- It now supports both YouTube embeds and Dailey OS-hosted media inside posts.

The Strapi/Next corporate starter in `/home/jonny/apps/dailey-template-corporate` is useful for reference, but it is a materially larger stack and its upstream starter has been archived.

## Run locally

1. Copy the env file:

```bash
cp .env.example .env
```

2. Install dependencies:

```bash
npm install
```

3. Start MySQL locally:

```bash
npm run dev:db
```

4. Start the blog:

```bash
npm run dev
```

5. Open:

```text
http://localhost:3000
```

Admin login is at `/admin` and uses `ADMIN_PASSWORD` from `.env`.
Set `ADMIN_SESSION_SECRET` to a long random string before deploying. In production, the app now refuses to boot with the default password or without that session secret.

## Dailey OS runtime

This template is now aligned with the Dailey OS deployment model:

- MySQL is read from `DATABASE_URL`
- object storage is read from the injected S3-compatible env vars
- uploaded media is stored in object storage, not on the container filesystem

The manifest in `dailey.json` now requests both `database` and `storage`, which matches the Dailey OS notes about managed DB and storage being provisioned automatically.

## Media support

The post editor supports normal Markdown plus storage-backed media embeds:

### YouTube

```text
{{youtube:https://www.youtube.com/watch?v=VIDEO_ID|Optional caption}}
```

### Hosted video

```text
{{video:/media/123/launch-demo.mp4|Optional caption}}
```

### Hosted image

```text
{{image:/media/456/team-photo.webp|Optional caption}}
```

Upload media in `/admin/media`. Each asset gets a stable `/media/...` path backed by Dailey OS storage.

You can also paste a standalone YouTube URL or a standalone `.mp4`, `.m4v`, `.webm`, `.ogg`, or `.mov` URL on its own line in the post body and it will render as an embed.

## UI direction

The front end has been simplified into an editorial company-blog layout:

- quieter navigation
- a single featured story
- a compact story list
- cleaner article pages
- less decorative chrome

This is a good base for `blog.dailey.cloud`. The next step would be deciding whether you want:

- a custom Dailey brand treatment layered on this layout
- a stronger content model for authors, featured images, and video-first posts
