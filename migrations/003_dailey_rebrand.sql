-- Seed content for demo: Dailey Company Blog
-- Replaces all content on each deploy to keep demo fresh

DELETE FROM posts;
DELETE FROM categories;

INSERT INTO categories (name, slug) VALUES ('Product', 'product');
INSERT INTO categories (name, slug) VALUES ('Engineering', 'engineering');
INSERT INTO categories (name, slug) VALUES ('Company', 'company');
INSERT INTO categories (name, slug) VALUES ('Customers', 'customers');

INSERT INTO posts (title, slug, content, excerpt, category_id, tags, published, published_at) VALUES (
  'Introducing Dailey OS 2.0: Deploy Anything, Connect Everything',
  'introducing-dailey-os-2',
  '## A New Chapter\n\nToday we are launching Dailey OS 2.0, the biggest update since we started the company. This release is the result of months of engineering, hundreds of conversations with developers, and a complete rethink of what a deployment platform should be.\n\n## What''s New\n\n### Docker Image Deploys\n\nPaste any Docker image name — WordPress, Ghost, Grafana, n8n — and Dailey OS pulls and deploys it in seconds. No Dockerfile needed. No build step. Database credentials, SSL, and DNS are configured automatically.\n\n### Service Linking\n\nConnect your apps together with one command. `dailey link my-frontend my-api` injects an internal URL as an environment variable. Traffic stays inside the cluster — no public internet, no VPN, no networking config.\n\n### Marketplace\n\n15 pre-configured apps ready to deploy: WordPress, Ghost, VS Code, Gitea, n8n, Grafana, Metabase, Adminer, and more. Each one comes with the correct port, environment variables, and database credential mapping.\n\n### Smart Deploy Button\n\nThe dashboard now checks GitHub for new commits and shows you exactly when a new version is available. One click to deploy, with the commit message right there so you know what changed.\n\n## Why This Matters\n\nDeployment platforms have been stuck solving the same problem — running your code. Dailey OS solves the next problem: running your stack. Your apps, your databases, your tools, all connected and managed from one platform.\n\n## Available Now\n\nDailey OS 2.0 is live for all customers. Log in at [os.dailey.cloud](https://os.dailey.cloud) and try it.',
  'Docker image deploys, service linking, a 15-app marketplace, and a smart deploy button that checks GitHub for new commits. Here is everything in Dailey OS 2.0 and why we built it.',
  (SELECT id FROM categories WHERE slug = 'product'),
  '["launch", "product", "2.0"]',
  TRUE,
  '2026-03-27 10:00:00'
);

INSERT INTO posts (title, slug, content, excerpt, category_id, tags, published, published_at) VALUES (
  'How We Built Per-Project Database Isolation in Production',
  'per-project-database-isolation',
  '## The Bug\n\nWe discovered a critical issue: deploying a new app with a database would overwrite the shared credentials secret, breaking every existing app''s database connection. One deploy could take down ten apps.\n\n## The Root Cause\n\nOur database provisioner used a single Kubernetes secret per namespace — `database-credentials`. Every new project would:\n\n1. Generate a new password\n2. Run `ALTER USER` which changed the password for ALL projects\n3. Overwrite the shared secret with the new project''s database name\n\nThis meant the last app deployed would work, but every previous app would lose its database connection.\n\n## The Fix\n\n### Per-Project Secrets\n\nEach project now gets its own `[slug]-db-credentials` secret. When Gitea deploys, it gets `gitea-db-credentials`. When WordPress deploys, it gets `wordpress-db-credentials`. No more overwriting.\n\n### Password Reuse\n\nThe provisioner now checks if the MySQL user already exists by reading the existing secret. If it does, it reuses the password instead of regenerating it. New databases get created, but the shared user password stays stable.\n\n### Secret Priority\n\nThe deployment''s `envFrom` now lists the per-project secret first, before the shared fallback. Kubernetes resolves conflicts by using the first value, so per-project credentials always win.\n\n## Testing\n\nWe deployed three apps back-to-back and verified:\n- Each got its own secret with the correct database name\n- The shared secret password never changed\n- All three databases existed in MySQL\n- All three apps could connect independently\n\n7 out of 7 tests passed. The fix is live.\n\n## Lesson\n\nShared mutable state is the root of most infrastructure bugs. When in doubt, isolate.',
  'One deploy was breaking every other app''s database. Here is exactly how we found the bug, built per-project secret isolation, and tested it with a 7-step regression suite — all in production.',
  (SELECT id FROM categories WHERE slug = 'engineering'),
  '["infrastructure", "databases", "kubernetes"]',
  TRUE,
  '2026-03-27 08:00:00'
);

INSERT INTO posts (title, slug, content, excerpt, category_id, tags, published, published_at) VALUES (
  'Dailey OS is Now in Private Beta',
  'private-beta-announcement',
  '## The News\n\nAfter months of building, testing, and iterating, Dailey OS is officially in private beta. We have our first customers deploying real applications on the platform.\n\n## What We''ve Built\n\nDailey OS is a managed application platform built on dedicated hardware we own. No AWS bills. No cloud provider markup. Just push your code and we handle infrastructure, databases, storage, scaling, and monitoring.\n\n### The Platform\n\n- **6-node Kubernetes cluster** running on dedicated hardware\n- **Managed MySQL databases** with per-project isolation\n- **S3-compatible object storage** via Cloudflare R2\n- **Automatic SSL** on every app via Cloudflare\n- **Push-to-deploy** from GitHub\n- **CLI and MCP tools** for terminal and AI-assisted workflows\n\n### For Developers\n\nWe detect your stack automatically — Node.js, Python, Go, Next.js, Astro, static sites. If you have a Dockerfile, we use it. If you don''t, we generate one. Your app is live at `yourapp.dailey.cloud` in under 60 seconds.\n\n## What''s Next\n\n- Custom domains with automatic SSL\n- PostgreSQL support\n- Background workers and cron jobs\n- Team collaboration features\n- EU data residency\n\n## Join the Beta\n\nWe''re onboarding developers who want to ship faster without managing infrastructure. If that''s you, reach out at [hello@dailey.llc](mailto:hello@dailey.llc).',
  'After months of building on dedicated infrastructure, Dailey OS is officially in private beta. First customers are live. Here is what we built, what is next, and how to join.',
  (SELECT id FROM categories WHERE slug = 'company'),
  '["beta", "announcement", "launch"]',
  TRUE,
  '2026-03-25 09:00:00'
);

INSERT INTO posts (title, slug, content, excerpt, category_id, tags, published, published_at) VALUES (
  'How a Solo Developer Deployed 7 Apps in One Week',
  'customer-story-solo-dev',
  '## The Situation\n\nA full-stack developer building multiple side projects was running them across three different platforms — one for APIs, one for frontends, and a VPS for everything else. Managing deployments, databases, and DNS across all three was eating into building time.\n\n## The Switch\n\nAfter signing up for Dailey OS, they had deployed 7 apps within the first week:\n\n1. A Node.js API backend with a managed MySQL database\n2. A React frontend connected to the API via service linking\n3. WordPress for a client marketing site\n4. Uptime Kuma to monitor all their apps\n5. n8n for workflow automation\n6. Adminer for database management\n7. A static landing page for a new project\n\n## What Changed\n\n### Before\n\n- 3 platforms, 3 billing accounts, 3 sets of credentials\n- Manual database backups on the VPS\n- DNS changes took 30 minutes of context switching\n- No visibility into what was running where\n\n### After\n\n- Everything in one dashboard\n- Database credentials visible and auto-injected\n- Service linking for internal communication\n- One CLI for everything: `dailey deploy`, `dailey logs`, `dailey creds`\n\n## The Takeaway\n\nConsolidating from three platforms to one eliminated the context switching tax. Service linking meant the frontend could talk to the API without any networking configuration. And having all credentials visible in one dashboard removed the last reason to SSH into anything.',
  'Three platforms, three billing accounts, zero visibility. One developer consolidated everything onto Dailey OS in a week — 7 apps, managed databases, service linking, and one dashboard.',
  (SELECT id FROM categories WHERE slug = 'customers'),
  '["case-study", "beta", "developer"]',
  TRUE,
  '2026-03-23 09:00:00'
);

INSERT INTO posts (title, slug, content, excerpt, category_id, tags, published, published_at) VALUES (
  'Why We Own Our Servers (And You Should Care)',
  'why-we-own-our-servers',
  '## The Cloud Tax\n\nMost deployment platforms run on AWS, GCP, or Azure. They pay the cloud provider, add their margin, and pass the cost to you. That margin is typically 3-5x the raw compute cost.\n\nWe took a different approach: we bought our own servers.\n\n## Our Infrastructure\n\nDailey OS runs on dedicated hardware in US data centers:\n\n- **6 production nodes** with NVMe storage\n- **Kubernetes orchestration** for container management\n- **HAProxy edge** with Cloudflare for SSL and DDoS protection\n- **Private networking** via Tailscale mesh\n\n## Why It Matters For You\n\n### 1. Better Pricing\n\nWhen we don''t pay the cloud tax, we don''t pass it on. Our Builder plan gives you 4 vCPUs, 4GB RAM, and a 5GB database — try getting that from Railway or Render at the same price.\n\n### 2. Predictable Performance\n\nNo noisy neighbors. Your containers run on dedicated hardware, not shared VMs where someone else''s traffic spike affects your latency.\n\n### 3. Data Sovereignty\n\nYour data lives on hardware we physically control in the US. No cloud provider subprocessor agreements. No data flowing through third-party infrastructure you don''t know about.\n\n### 4. We Eat Our Own Cooking\n\nEvery Dailey product — Due, Signal, Forms, Photos, HR — runs on Dailey OS. We serve thousands of customers on the same infrastructure you deploy to. If it breaks, we feel it first.\n\n## The Tradeoff\n\nWe can''t spin up a new region in 5 minutes like AWS. Scaling means buying and racking hardware. But for 99% of applications, the performance, pricing, and control advantages are worth it.\n\n## The Point\n\nThe cloud is not the only option. For platforms that need predictable pricing, consistent performance, and real data ownership, dedicated hardware is making a comeback. We''re proof.',
  'Most platforms pay the AWS tax and pass it to you at 3-5x markup. We bought our own servers instead. Here is why that means better pricing, predictable performance, and real data sovereignty for your apps.',
  (SELECT id FROM categories WHERE slug = 'engineering'),
  '["infrastructure", "pricing", "servers"]',
  TRUE,
  '2026-03-20 09:00:00'
)
