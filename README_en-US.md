# image2cf

Multi-user AI image generation with admin-managed users, custom relay stations, and image-to-image references. Deploy to Cloudflare Workers or Node.js.

Based on [typix-image](https://github.com/kiseding/typix-image).

<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

---

## Features

| Feature | Description |
|---------|-------------|
| **Multi-user** | No public signup; admin creates / bans / resets / deletes users |
| **Relay stations** | Per-user OpenAI / Google-compatible proxies |
| **Image references** | Reuse past generations as i2i inputs |
| **Providers** | Cloudflare Workers AI, OpenAI, Google, Flux, Fal, … |
| **Runtimes** | Cloudflare Workers (recommended) / Node.js |

Config and secrets come from **GitHub Secrets / Cloudflare Dashboard / env vars** — **do not commit real IDs into `wrangler.toml`**.

---

## Deploy: Workers + GitHub Actions

### 1. Create D1

Dashboard → **D1** → create DB (e.g. `image2cf`) → copy **Database ID**. Keep it out of the repo.

### 2. API Token

Permissions: Workers Edit, D1 Edit, Account Settings Read. Note **Token** and **Account ID**.

### 3. GitHub Secrets

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | API token |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID |
| `CLOUDFLARE_D1_DATABASE_ID` | D1 database UUID |

CI injects the D1 ID into a temporary `wrangler.toml` at runtime (never committed).

### 4. Worker variables (Dashboard)

After first deploy → **Workers → image2cf → Variables and Secrets**:

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_EMAIL` | ✅ | Bootstrap admin email |
| `ADMIN_PASSWORD` | ✅ | Bootstrap admin password |
| `ADMIN_NAME` | | Display name |

Deploy uses `--keep-vars` so Dashboard vars/secrets are preserved.

### 5. Trigger

- Push to `main`, or  
- Actions → **Deploy Cloudflare Workers** → Run workflow  

### Local deploy (env only)

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_D1_DATABASE_ID=...

pnpm install && pnpm build && pnpm deploy
```

---

## Local development (Node)

```bash
cp .env.node.example .env
# set DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, MODE=mixed
pnpm db:push && pnpm dev
```

---

## Usage

1. Login with bootstrap admin  
2. **Settings → Users** — create accounts  
3. **Settings → Relay stations** — Base URL / API key / models  
4. **Settings → AI providers** — optional system providers  
5. Chat → **Use as reference** for image-to-image  

---

## Scripts

```bash
pnpm deploy              # inject D1 ID + migrate + deploy --keep-vars
pnpm deploy:no-migrate   # inject D1 ID + deploy only
pnpm build / pnpm dev / pnpm db:push
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Missing `CLOUDFLARE_D1_DATABASE_ID` | Add the secret |
| Auth / migrate failures | Check token, account ID, D1 ID |
| Dashboard vars wiped | Ensure deploy uses `--keep-vars` |
| No admin | Set `ADMIN_*` on Worker; empty DB on first boot |

---

## License

Apache-2.0.

## Credits

[typix](https://github.com/monkeyWie/typix) / [typix-image](https://github.com/kiseding/typix-image)
