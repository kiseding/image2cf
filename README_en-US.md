# image2cf

Multi-user AI image generation platform with admin-managed users, custom relay stations, and image-to-image references. Deploy to Cloudflare Workers or Node.js.

Forked and extended from [typix-image](https://github.com/kiseding/typix-image).

<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

---

## Features

| Feature | Description |
|---------|-------------|
| **Multi-user** | No public signup; admin creates / bans / resets / deletes users |
| **Relay stations** | Per-user OpenAI / Google-compatible proxies (Base URL + API Key + models) |
| **Image references** | One-click reuse of past generations as i2i inputs |
| **Providers** | Cloudflare Workers AI, OpenAI, Google, Flux, Fal, and more |
| **Runtimes** | Cloudflare Workers (recommended) / Node.js self-host |

---

## Stack

- **Frontend**: React + Vite + TanStack Router  
- **Backend**: Hono + better-auth + Drizzle ORM  
- **DB**: Cloudflare D1 (Workers) / SQLite (Node)  
- **Mode**: `MODE=mixed` (login required, server-side storage)

---

## Deploy: Cloudflare Workers + GitHub Actions

### Prerequisites

- Cloudflare account  
- This repo on GitHub  
- Node.js 20+ (only if editing config locally)

### 1. Create D1 database

Cloudflare Dashboard → **Workers & Pages → D1** → create database (e.g. `image2cf`).

Put the **Database ID** into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "image2cf"
database_id = "your-database-id"   # ← replace
migrations_dir = "drizzle/migrations"
```

### 2. Create API Token

**My Profile → API Tokens → Create Token**

Suggested permissions:

- Account → Cloudflare Workers → Edit  
- Account → D1 → Edit  
- Account → Account Settings → Read  

Note your **API Token** and **Account ID**.

### 3. GitHub Secrets

Repo → **Settings → Secrets and variables → Actions**:

| Name | Value |
|------|--------|
| `CLOUDFLARE_API_TOKEN` | API Token |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID |

### 4. Worker variables / secrets

After first deploy, set in **Workers → image2cf → Settings → Variables** (or `wrangler secret put`):

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_EMAIL` | ✅ | Bootstrap admin email (created only when user table is empty) |
| `ADMIN_PASSWORD` | ✅ | Bootstrap admin password |
| `ADMIN_NAME` | | Display name (default `Admin`) |
| `PROVIDER_CLOUDFLARE_BUILTIN` | | Use built-in Workers AI (default `true` in `wrangler.toml`) |

### 5. Trigger deploy

- **Auto**: push to `main`  
- **Manual**: Actions → **Deploy Cloudflare Workers** → Run workflow  

Pipeline: install → build → D1 migrate → `wrangler deploy`.

URL: `https://image2cf.<subdomain>.workers.dev`

### Local deploy (optional)

```bash
pnpm install
# edit database_id in wrangler.toml
pnpm build
pnpm deploy
```

---

## Local development (Node.js)

```bash
git clone https://github.com/kiseding/image2cf.git
cd image2cf
pnpm install
cp .env.node.example .env
```

`.env` minimum:

```env
DATABASE_URL="file:./db.sqlite"
ADMIN_EMAIL="admin@example.com"
ADMIN_PASSWORD="change-me"
MODE="mixed"
```

```bash
pnpm db:push
pnpm dev
```

---

## Environment variables

| Variable | Runtime | Description |
|----------|---------|-------------|
| `MODE` | all | Use `mixed` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | all | Bootstrap admin |
| `PROVIDER_CLOUDFLARE_BUILTIN` | Workers | Built-in Workers AI |
| `DATABASE_URL` | Node | e.g. `file:./db.sqlite` |
| `FILE_STORAGE` | Node | `base64` / `disk` / `r2` |
| `CLOUDFLARE_API_TOKEN` | Actions | Deploy token (secret) |
| `CLOUDFLARE_ACCOUNT_ID` | Actions | Account ID (secret) |

---

## Usage

1. **Login** with bootstrap admin credentials  
2. **Settings → Users** — create accounts (no public registration)  
3. **Settings → Relay stations** — add Base URL, API key, models  
4. **Settings → AI providers** — configure built-in providers (optional)  
5. **Chat** — generate images; hover a message → **Use as reference** for i2i  

---

## Scripts

```bash
pnpm dev                 # local Vite + server
pnpm dev:worker          # wrangler local
pnpm build               # Cloudflare build
pnpm build:node          # Node build
pnpm db:push             # push schema (local SQLite)
pnpm db:migrate:worker   # remote D1 migrations
pnpm deploy              # migrate + deploy Workers
pnpm deploy:no-migrate   # deploy only (CI)
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Actions auth failure | Check `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` |
| D1 migrate fails | Verify `database_id` and token D1 permissions |
| No admin login | Ensure `ADMIN_*` set and DB was empty on first boot |
| Relay generate fails | Verify Base URL, API key, model IDs |
| i2i disabled | Switch to a model with I2I ability |

---

## License

Apache-2.0 (upstream license).

## Credits

- [typix](https://github.com/monkeyWie/typix) / [typix-image](https://github.com/kiseding/typix-image)
