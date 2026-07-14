# image2cf

多用户 AI 图像生成平台。支持管理员管控用户、自定义中转站、历史图片引用（图生图），可部署到 Cloudflare Workers 或 Node.js。

基于 [typix-image](https://github.com/kiseding/typix-image) 改造。

<p align="center">
  <a href="README_en-US.md">English</a> | 简体中文
</p>

---

## 功能特性

| 功能 | 说明 |
|------|------|
| **多用户** | 禁止公开注册；管理员创建 / 禁用 / 重置密码 / 删除用户 |
| **多中转站** | 用户自配 OpenAI / Google 兼容接口（Base URL + API Key + 模型） |
| **图生图引用** | 将历史生成或上传图片一键加入输入区作为参考图 |
| **多模型** | Cloudflare Workers AI、OpenAI、Google、Flux、Fal 等 |
| **双运行时** | Cloudflare Workers（推荐）/ Node.js 自托管 |

---

## 架构说明

- **前端**：React + Vite + TanStack Router
- **后端**：Hono + better-auth + Drizzle ORM
- **数据库**：Cloudflare D1（Workers）/ SQLite（Node）
- **模式**：`MODE=mixed`（必须登录，服务端存储）

配置与密钥通过 **GitHub Secrets / Cloudflare Dashboard / 环境变量** 注入，**无需修改并提交 `wrangler.toml`**。

---

## 推荐部署：Cloudflare Workers + GitHub Actions

### 前置条件

- Cloudflare 账号
- 本仓库已推送到 GitHub

### 步骤 1：创建 D1 数据库

Cloudflare Dashboard → **Workers & Pages → D1** → 创建数据库（名称建议 `image2cf`）。

记下 **Database ID**（UUID）。**不要**写进仓库里的 `wrangler.toml`。

### 步骤 2：创建 API Token

**My Profile → API Tokens → Create Token**，建议权限：

- Account → Cloudflare Workers → Edit  
- Account → D1 → Edit  
- Account → Account Settings → Read  

记下 **API Token** 与 Dashboard 右侧的 **Account ID**。

### 步骤 3：配置 GitHub Secrets

仓库 → **Settings → Secrets and variables → Actions**，新增：

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | API Token |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID |
| `CLOUDFLARE_D1_DATABASE_ID` | D1 Database ID（UUID） |

CI 会在运行时把 `CLOUDFLARE_D1_DATABASE_ID` 注入到临时 `wrangler.toml`，不会回写仓库。

### 步骤 4：配置 Worker 运行时变量（Dashboard）

部署成功后，在 **Workers → image2cf → Settings → Variables and Secrets** 配置：

| 变量 | 必填 | 说明 |
|------|------|------|
| `ADMIN_USERNAME` | ✅ | 首个管理员用户名（用户表为空时自动创建） |
| `ADMIN_PASSWORD` | ✅ | 首个管理员密码（建议用 Secret） |
| `ADMIN_NAME` | | 显示名，默认 `Admin` |

部署命令使用 `--keep-vars`，**不会覆盖** Dashboard 上已配置的变量/密钥。

也可在本地（已登录 wrangler）执行：

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_D1_DATABASE_ID=...

npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
```

> `ADMIN_*` 仅在数据库尚无用户时用于引导创建管理员，之后请用后台「用户管理」维护账号。

### 步骤 5：触发部署

- **自动**：push 到 `main`
- **手动**：Actions → **Deploy Cloudflare Workers** → Run workflow

流程：`pnpm install` → 注入 D1 ID → `pnpm build` → D1 迁移 → `wrangler deploy --keep-vars`

成功后访问：`https://image2cf.<子域>.workers.dev`

### 本地一键部署（可选）

不改仓库文件，只通过环境变量：

```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_D1_DATABASE_ID="你的-d1-uuid"

pnpm install
pnpm build
pnpm deploy   # 自动 inject → migrate → deploy --keep-vars
```

---

## 本地开发（Node.js）

```bash
git clone https://github.com/kiseding/image2cf.git
cd image2cf
pnpm install
cp .env.node.example .env
```

编辑 `.env`（仅本地，勿提交）：

```env
DATABASE_URL="file:./db.sqlite"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="change-me"
ADMIN_NAME="Admin"
MODE="mixed"
FILE_STORAGE="base64"
```

```bash
pnpm db:push
pnpm dev
```

---

## 环境变量一览

### GitHub Actions Secrets

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | 部署鉴权 |
| `CLOUDFLARE_ACCOUNT_ID` | 账户 ID |
| `CLOUDFLARE_D1_DATABASE_ID` | D1 Database ID |

### Cloudflare Worker（Dashboard Variables / Secrets）

| 变量 | 说明 |
|------|------|
| `ADMIN_USERNAME` | 引导管理员用户名 |
| `ADMIN_PASSWORD` | 引导管理员密码 |
| `ADMIN_NAME` | 管理员显示名 |
| `PROVIDER_CLOUDFLARE_BUILTIN` | 是否用内置 Workers AI（`wrangler.toml` 默认 `true`，可用 Dashboard 覆盖） |

### Node 本地

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | 如 `file:./db.sqlite` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_NAME` | 引导管理员 |
| `MODE` | 使用 `mixed` |
| `FILE_STORAGE` | `base64` / `disk` / `r2` |

---

## 使用指南

1. 使用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录  
2. **设置 → 用户管理**：创建用户（无公开注册）  
3. **设置 → 中转站**：配置 Base URL、API Key、模型  
4. **设置 → AI 提供商**：配置系统内置提供商（可选）  
5. 对话生成后，悬停消息点 **用作参考图** 做图生图  

---

## 常用命令

```bash
pnpm dev                 # 本地开发
pnpm dev:worker          # 本地 wrangler
pnpm build               # Cloudflare 构建
pnpm build:node          # Node 构建
pnpm db:push             # 本地 SQLite schema
pnpm db:migrate:worker   # 远程 D1 迁移（需已 inject 或 env 齐全）
pnpm deploy              # inject D1 ID + 迁移 + 部署
pnpm deploy:no-migrate   # inject D1 ID + 仅部署
```

---

## 目录结构（简要）

```
image2cf/
├── .github/workflows/deploy.yml   # Actions：Secrets 注入 D1 ID 后部署
├── scripts/inject-d1-id.mjs       # 本地 deploy 时注入 D1 ID
├── drizzle/migrations/
├── src/app/                       # 前端
├── src/server/                    # Hono API / Worker
└── wrangler.toml                  # 不含真实 database_id
```

---

## 故障排查

| 现象 | 处理 |
|------|------|
| Actions：Missing `CLOUDFLARE_D1_DATABASE_ID` | 在仓库 Secrets 中配置该值 |
| Actions 鉴权失败 | 检查 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` |
| D1 迁移失败 | 确认 Database ID 正确，Token 有 D1 Edit |
| Dashboard 变量被清掉 | 部署已加 `--keep-vars`；勿在 `wrangler.toml` 重复定义会覆盖的 vars |
| 无法登录 | 确认 Dashboard 已设 `ADMIN_*`，且库为空时完成过首次启动 |
| 中转站失败 | 检查 Base URL / API Key / 模型 ID |
| 图生图不可用 | 切换到支持 I2I 的模型 |

---

## 许可证

Apache-2.0（继承上游项目许可）。

## 致谢

- [typix](https://github.com/monkeyWie/typix) / [typix-image](https://github.com/kiseding/typix-image)
