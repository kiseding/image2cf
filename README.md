# image2cf

多用户 AI **图像生成** 平台：管理员管账号、用户自配中转站、历史图引用图生图，默认部署在 **Cloudflare Workers + D1 + R2**。

基于 [typix-image](https://github.com/kiseding/typix-image) 改造。

<p align="center">
  <a href="README_en-US.md">English</a> · 简体中文
</p>

在线示例：`https://image.kiseding.top`（以你自己的域名为准）

---

## 功能一览

| 能力 | 说明 |
|------|------|
| **多用户 / 禁注册** | 仅管理员创建用户；用户名登录（非邮箱） |
| **默认管理员** | 用户名固定 `admin`，密码来自 `ADMIN_PASSWORD` |
| **中转站** | 自配协议 + Base URL + API Key + 模型；三路径：文生图 / 图生图 / 编辑 |
| **图生图** | 上传或引用历史图；有图走 i2i 路径，无图走 t2i |
| **尺寸** | 对话内数字宽高；中转模型可配默认 W/H |
| **存储** | 默认 **R2** 存图；D1 存元数据与会话；预览链接永久，对象默认 **30 天**清理 |
| **进度** | 服务端阶段进度（排队→请求→解析→保存）；多数生图 API **不支持**像素流式 |
| **Debug** | `DEBUG=true` 时开放 `/api/debug/*`（排查生成卡住等） |

---

## 技术栈

- **前端**：React + Vite + TanStack Router + i18n  
- **后端**：Hono（Cloudflare Workers）  
- **鉴权**：better-auth + 用户名登录 `/api/login`  
- **数据**：Drizzle ORM · **D1**（会话/用户）· **R2**（图片）  
- **部署**：GitHub Actions → Cloudflare Queues + `wrangler deploy --keep-vars`

---

## 快速部署（推荐）

### 1. Cloudflare

1. 创建 **D1** 数据库（如 `image2cf`），记下 **Database ID**  
2. 创建 **API Token**（Workers Edit、D1 Edit、Account Read；R2 需 Edit）  
3. 记下 **Account ID**  
4. R2 桶：CI 默认创建/使用 `image2cf`（可用 Secret 改名）

### 2. GitHub Secrets

仓库 → **Settings → Secrets and variables → Actions**：

| Secret | 必填 | 说明 |
|--------|------|------|
| `CLOUDFLARE_API_TOKEN` | ✅ | API Token |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | Account ID |
| `CLOUDFLARE_D1_DATABASE_ID` | ✅ | D1 UUID |
| `ADMIN_PASSWORD` | ✅ | 管理员 `admin` 密码（部署时写入 Worker Secret） |
| `CLOUDFLARE_R2_BUCKET_NAME` | 可选 | 默认 `image2cf` |
| `CREDENTIALS_SECRET` | 建议 | 凭据加密密钥；不设时回退 `ADMIN_PASSWORD`，设置后不要更换 |

**不要**把真实 D1 ID / 密钥写进仓库里的 `wrangler.toml`。

### 3. 触发部署

- push 到 `main`，或 Actions → **Deploy Cloudflare Workers** → Run workflow  

流程：安装依赖 → 创建 R2/Queues → 构建 → D1 迁移 → 部署 → 同步管理员和凭据加密 Secret。管理员仅在不存在时自动创建，不会覆盖已有密码。

### 4. 登录

1. 打开站点  
2. 用户名：`admin`  
3. 密码：GitHub Secret `ADMIN_PASSWORD`  

以下 setup 接口首次安装时可用；已有用户后仅管理员可访问：

```text
GET  /api/setup/status
POST /api/setup/bootstrap
```

---

## Worker 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `ADMIN_PASSWORD` | — | Secret，管理员密码 |
| `ADMIN_NAME` | `Admin` | 显示名 |
| `MODE` | `mixed` | 必须登录，数据在服务端 |
| `FILE_STORAGE` | `r2` | `r2` / `base64` |
| `R2_RETENTION_DAYS` | `30` | R2 **文件字节**保留天数；D1 预览链接仍永久 |
| `DEBUG` | 关 | 设为 `true` 开启 `/api/debug/*` |
| `PROVIDER_CLOUDFLARE_BUILTIN` | `true` | 是否启用内置 Workers AI |
| `BETTER_AUTH_SECRET` | 可选 | 会话签名；不设则回落 `ADMIN_PASSWORD` |
| `CREDENTIALS_SECRET` | 建议 | AES-GCM 加密中转/Provider Key；不设则回退其他服务端 Secret |

绑定（`wrangler.toml`）：

- `DB` → D1  
- `R2` → R2 bucket  
- `AI` → Workers AI（可选）  
- `GENERATION_QUEUE` → Cloudflare Queue（持久执行生图任务）
- Cron：`0 3 * * *` 清理过期 R2 对象  
- Cron：每 5 分钟回收超过 15 分钟仍未结束的生成任务

---

## 使用说明

### 管理员

1. **设置 → 用户管理**：创建用户、改密、禁用、删除（无公开注册）  
2. 建议只保留一个管理员账号  

### 中转站（核心）

**设置 → 中转站** 添加：

| 字段 | 示例 |
|------|------|
| 名称 | 我的中转 |
| 协议 | OpenAI 兼容 |
| Base URL | `https://api.example.com/v1` |
| API Key | `sk-...` |
| 文生图路径 | `/images/generations` |
| 图生图路径 | `/images/edits` |
| 编辑路径 | `/images/edits`（可与图生图相同） |
| 模型 | Model ID + 显示名 + 默认宽高 |

说明：

- **模型只是 ID**，路由由「有没有参考图」决定：无图 → t2i，有图 → i2i  
- 最后添加的模型会排在前面  
- 编辑时 API Key 留空表示不修改  

### 对话

- 新建会话标题：`新创作 1`、`新创作 2`…  
- 偏好设置：张数、宽高（像素）  
- 引用历史图 / 上传图 → 自动图生图  
- 删除会话会清理消息、生成记录、文件行与 R2 对象  

---

## 生成进度与限制

多数图像 API **不会**流式返回半张图。前端展示的是服务端阶段：

`排队 → 准备 → 调用接口 → 解析 → 保存 → 完成`

生成请求通过 Cloudflare Queue 持久执行，HTTP 请求只负责原子抢占并入队。同一任务通过 attempt 版本防止并发重复计费和旧结果覆盖；超过 **15 分钟**仍未完成的任务由定时任务标记为 `TIMEOUT`。

---

## Debug（需 `DEBUG=true`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/debug/` | 绑定与存储模式 |
| GET | `/api/debug/generations` | 最近生成记录 |
| GET | `/api/debug/generations/:id` | 单条 + 文件预览信息 |
| POST | `/api/debug/generations/fail-stale?maxAgeSec=120` | 将卡住的 pending/generating 标为 TIMEOUT |
| GET | `/api/debug/relays` | 中转配置（Key 打码） |
| POST | `/api/debug/parse-images` | 测试 JSON 图片解析 |
| GET | `/api/debug/r2/list` | 列出 R2 对象 |

生产用完后请关闭 `DEBUG`。

示例：

```bash
curl -sS "https://你的域名/api/debug/generations"
curl -sS -X POST "https://你的域名/api/debug/generations/fail-stale?maxAgeSec=60"
```

---

## 本地开发

```bash
git clone https://github.com/kiseding/image2cf.git
cd image2cf
pnpm install
```

```env
# .env（勿提交）
DATABASE_URL="file:./db.sqlite"
ADMIN_PASSWORD="change-me"
MODE="mixed"
FILE_STORAGE="base64"
```

```bash
pnpm db:push
pnpm dev
```

Worker 本地：

```bash
pnpm dev:worker
```

---

## 常用命令

```bash
pnpm dev                 # 本地开发
pnpm build               # Cloudflare 构建
pnpm build:node          # Node 构建
pnpm db:push             # 本地 schema
pnpm db:migrate:worker   # 远程 D1 迁移
pnpm deploy              # 注入 D1 + 迁移 + 部署
```

---

## 目录结构

```
image2cf/
├── .github/workflows/deploy.yml
├── drizzle/migrations/
├── src/app/                 # 前端
├── src/server/
│   ├── api/routes/          # login / chat / relay / admin / debug / setup
│   ├── ai/provider/         # 中转三路径、解析
│   ├── service/             # 业务
│   └── worker.ts            # fetch + 定时清理 R2
└── wrangler.toml            # 无真实密钥 / D1 ID
```

---

## 故障排查

| 现象 | 处理 |
|------|------|
| 无法登录 | 检查 `ADMIN_PASSWORD`；管理员登录后查看 setup 状态；初始化不会覆盖已有密码 |
| Actions 失败 | 检查 Token / Account ID / D1 ID；Token 是否含 R2 |
| 中转失败 | Base URL、Key、三路径、模型 ID；勿把文本模型当生图模型 |
| 一直「生成中」 | 部署最新代码；`DEBUG=true` 看 generations；`fail-stale` 清理僵尸任务；看中转是否真返回 url/b64 |
| 中转成功但无图 | 返回体字段不标准；用 `/api/debug/parse-images` 测 JSON；优先让中转返回 `url` |
| 图片 410 | R2 对象超过 `R2_RETENTION_DAYS` 已清理，链接仍在 |
| 删除会话 | 硬删除：消息、生成、files、R2 一并清 |

### 生成状态字段（debug）

- `pending`：已建任务  
- `generating`：执行中（`parameters.progress` 含阶段与百分比）  
- `completed`：有 `fileIds`  
- `failed`：看 `errorReason`（`TIMEOUT` / `API_ERROR` / `CONFIG_ERROR` 等）  

---

## 安全注意

- 中转和 Provider **API Key** 使用 AES-GCM 加密后存 D1，列表/详情不向前端返回明文
- 中转 Base URL 仅允许 HTTPS，禁止字面私网/metadata，逐跳检查重定向并限制响应大小与时间
- 登录、消息和生图使用 D1 原子限流，多 Worker isolate 共享
- 上传最多 8 张图，单张 10 MiB、总计 20 MiB；远程图片限制 10 MiB，并校验图片魔数
- `DEBUG` 勿长期开在公网  

---

## 许可证

Apache-2.0（继承上游）。

## 致谢

- [typix](https://github.com/monkeyWie/typix) / [typix-image](https://github.com/kiseding/typix-image)
