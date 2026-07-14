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

---

## 推荐部署：Cloudflare Workers + GitHub Actions

### 前置条件

- Cloudflare 账号
- 本仓库已推送到 GitHub
- Node.js 20+（仅本地改配置时需要）

### 步骤 1：创建 D1 数据库

在 Cloudflare Dashboard → **Workers & Pages → D1** 创建数据库，名称建议 `image2cf`。

复制 **Database ID**，写入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "image2cf"
database_id = "你的-database-id"   # ← 替换这里
migrations_dir = "drizzle/migrations"
```

### 步骤 2：创建 API Token

Cloudflare Dashboard → **My Profile → API Tokens → Create Token**

建议权限：

- Account → Cloudflare Workers → Edit
- Account → D1 → Edit
- Account → Account Settings → Read

记下 **API Token** 与 **Account ID**（Dashboard 右侧栏）。

### 步骤 3：配置 GitHub Secrets

仓库 → **Settings → Secrets and variables → Actions**，新增：

| Name | Value |
|------|--------|
| `CLOUDFLARE_API_TOKEN` | 上一步的 API Token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |

### 步骤 4：配置 Worker 环境变量

部署成功后，在 Cloudflare Dashboard → **Workers → image2cf → Settings → Variables** 中配置：

| 变量 | 必填 | 说明 |
|------|------|------|
| `ADMIN_EMAIL` | ✅ | 首个管理员邮箱（用户表为空时自动创建） |
| `ADMIN_PASSWORD` | ✅ | 首个管理员密码 |
| `ADMIN_NAME` | | 显示名，默认 `Admin` |
| `MODE` | | 默认已在 `wrangler.toml` 设为 `mixed` |
| `PROVIDER_CLOUDFLARE_BUILTIN` | | 是否启用 CF 内置 AI，默认 `true` |

也可用 CLI（本地已登录 wrangler 时）：

```bash
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_PASSWORD
```

> 注意：`ADMIN_*` 仅在**数据库尚无任何用户**时生效，用于引导创建管理员。之后请用后台「用户管理」维护账号。

### 步骤 5：触发部署

- **自动**：向 `main` 分支 push 代码  
- **手动**：GitHub → **Actions** → **Deploy Cloudflare Workers** → **Run workflow**

Workflow 会依次执行：

1. `pnpm install`
2. `pnpm build`（Cloudflare 前端 + Worker）
3. D1 远程迁移（`pnpm db:migrate:worker`）
4. `wrangler deploy`

部署成功后访问：`https://image2cf.<你的子域>.workers.dev`

### 本地部署（可选）

```bash
pnpm install
# 编辑 wrangler.toml 中的 database_id
pnpm build
pnpm deploy   # 含 D1 迁移 + deploy
```

需已执行 `npx wrangler login`，或设置环境变量 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`。

---

## 本地开发（Node.js）

```bash
git clone https://github.com/kiseding/image2cf.git
cd image2cf
pnpm install
cp .env.node.example .env
```

编辑 `.env`：

```env
DATABASE_URL="file:./db.sqlite"
ADMIN_EMAIL="admin@example.com"
ADMIN_PASSWORD="change-me"
ADMIN_NAME="Admin"
MODE="mixed"
FILE_STORAGE="base64"
```

初始化数据库并启动：

```bash
pnpm db:push
pnpm dev
```

浏览器打开终端提示的本地地址（通常为 Vite 开发服务）。

---

## 环境变量一览

### 通用

| 变量 | 运行时 | 说明 |
|------|--------|------|
| `MODE` | 全部 | 请使用 `mixed` |
| `ADMIN_EMAIL` | 全部 | 引导管理员邮箱 |
| `ADMIN_PASSWORD` | 全部 | 引导管理员密码 |
| `ADMIN_NAME` | 全部 | 管理员显示名 |
| `PROVIDER_CLOUDFLARE_BUILTIN` | Workers | 是否使用 Workers AI 内置能力 |

### Node 专用

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | SQLite，如 `file:./db.sqlite` |
| `FILE_STORAGE` | `base64` / `disk` / `r2` |
| `FILE_STORAGE_DISK_PATH` | disk 模式存储目录，默认 `.files` |

### GitHub Actions

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | 部署用 API Token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |

---

## 使用指南

### 1. 管理员登录

使用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 登录（首次启动自动建号）。

### 2. 用户管理

**设置 → 用户管理**（仅管理员可见）：

- 创建用户（邮箱 + 密码 + 角色）
- 禁用 / 解禁
- 重置密码
- 删除用户
- 调整角色（admin / user）

系统**不支持公开注册**，账号均由管理员发放。

### 3. 中转站

**设置 → 中转站**（每个用户独立配置）：

1. 添加中转站：名称、协议（OpenAI / Google 兼容）、Base URL、API Key  
2. 配置模型：Model ID、显示名、能力（T2I / I2I）、最大输入图数  
3. 启用后，模型会出现在创作页的模型选择器中（标识为中转站）

### 4. AI 提供商（系统内置）

**设置 → AI 提供商**：为 Cloudflare / OpenAI / Google / Flux / Fal 等填写 API Key 并启用模型。

### 5. 创作与图生图

1. 新建对话，选择模型  
2. 输入提示词生成图片  
3. 悬停消息 → 点击 **用作参考图**  
4. 参考图进入输入区后，可继续编辑提示词做图生图  

也可直接上传本地图片进行图生图（模型需支持 I2I）。

---

## 常用命令

```bash
pnpm dev                 # 本地开发（Vite + 后端）
pnpm dev:worker          # 本地 wrangler 模拟 Workers
pnpm build               # Cloudflare 构建
pnpm build:node          # Node 构建
pnpm db:push             # 同步 schema 到本地 SQLite
pnpm db:generate         # 生成迁移
pnpm db:migrate:worker   # 远程 D1 迁移
pnpm deploy              # 迁移 + 部署 Workers
pnpm deploy:no-migrate   # 仅部署（CI 用）
```

---

## 目录结构（简要）

```
image2cf/
├── .github/workflows/deploy.yml   # Actions 自动部署
├── drizzle/migrations/            # 数据库迁移
├── src/
│   ├── app/                       # 前端
│   │   └── routes/
│   │       ├── chat/              # 创作对话
│   │       └── settings/          # 设置（用户 / 中转站 / 提供商）
│   └── server/
│       ├── api/                   # Hono 路由
│       ├── service/               # 业务（admin / relay / chat / ai）
│       ├── db/schemas/            # Drizzle schema
│       └── worker.ts              # Workers 入口
├── wrangler.toml
└── package.json
```

---

## 故障排查

| 现象 | 处理 |
|------|------|
| Actions 部署失败：auth | 检查 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` |
| D1 migration 失败 | 确认 `wrangler.toml` 中 `database_id` 正确且 Token 有 D1 权限 |
| 无法登录 / 无管理员 | 确认已配置 `ADMIN_*` 且库为空时完成过首次启动；否则手动在 D1 检查 `user` 表 |
| 中转站生成失败 | 检查 Base URL、API Key、模型 ID 是否与中转服务一致 |
| 图生图按钮灰掉 | 当前模型为纯 T2I，请切换到支持 I2I 的模型 |

---

## 许可证

Apache-2.0（继承上游项目许可）。

## 致谢

- [typix](https://github.com/monkeyWie/typix) / [typix-image](https://github.com/kiseding/typix-image)
