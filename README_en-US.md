# image2cf

Multi-user **AI image generation** on **Cloudflare Workers + D1 + R2**: admin-managed accounts, user-defined relay stations, and reference images for i2i.

Forked from [typix-image](https://github.com/kiseding/typix-image).

<p align="center">
  English · <a href="README.md">简体中文</a>
</p>

---

## Features

| Feature | Notes |
|---------|--------|
| Multi-user, no public signup | Admin creates users; username login |
| Default admin | Username `admin`, password from `ADMIN_PASSWORD` |
| Relays | OpenAI-compatible Base URL + API Key + models; paths: t2i / i2i / edit |
| Image-to-image | Upload or cite history images → i2i path |
| Storage | **R2** for bytes; D1 for metadata; preview links permanent; objects purged after **30 days** (configurable) |
| Progress | Server-side stages (most image APIs are not pixel-streamable) |
| Debug | `DEBUG=true` enables `/api/debug/*` |

---

## Deploy (GitHub Actions)

### Secrets

| Secret | Required |
|--------|----------|
| `CLOUDFLARE_API_TOKEN` | ✅ |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ |
| `CLOUDFLARE_D1_DATABASE_ID` | ✅ |
| `ADMIN_PASSWORD` | ✅ |
| `WORKER_URL` | Recommended |
| `CLOUDFLARE_R2_BUCKET_NAME` | Optional (default `image2cf`) |

Push to `main` or run **Deploy Cloudflare Workers** workflow.

Login: `admin` + `ADMIN_PASSWORD`.  
Check: `GET /api/setup/status`, `POST /api/setup/bootstrap`.

### Important Worker vars

| Var | Default | Purpose |
|-----|---------|---------|
| `FILE_STORAGE` | `r2` | Image backend |
| `R2_RETENTION_DAYS` | `30` | Object lifetime |
| `DEBUG` | off | Debug API |
| `MODE` | `mixed` | Login required |

---

## Relay setup

Settings → Relay:

- Base URL e.g. `https://api.example.com/v1`
- Paths: `/images/generations` (t2i), `/images/edits` (i2i/edit)
- Models: IDs only; routing by presence of reference images
- Newest models listed first

---

## Debug (`DEBUG=true`)

```bash
curl -sS "https://YOUR_HOST/api/debug/generations"
curl -sS -X POST "https://YOUR_HOST/api/debug/generations/fail-stale?maxAgeSec=120"
```

| Path | Purpose |
|------|---------|
| `GET /api/debug/generations` | Recent jobs |
| `POST /api/debug/generations/fail-stale` | Mark stuck jobs as TIMEOUT |
| `GET /api/debug/generations/:id` | One job + file info |

Turn `DEBUG` off in production when done.

---

## Local

```bash
pnpm install
# DATABASE_URL=file:./db.sqlite ADMIN_PASSWORD=... MODE=mixed
pnpm db:push && pnpm dev
```

---

## Troubleshooting

| Issue | Action |
|-------|--------|
| Stuck “generating” | Deploy latest; `fail-stale`; check relay returns `url`/`b64_json` |
| Relay OK, app empty | Parse fields; prefer URL responses |
| 410 on image | R2 object expired (`R2_RETENTION_DAYS`) |
| Login fails | Secret + bootstrap |

---

## License

Apache-2.0.
