# image2cf

基于 [typix-image](https://github.com/kiseding/typix-image) 改造的多用户 AI 生图平台，支持管理员管控用户、自定义中转站、过往图片引用（图生图）。

## 核心能力

1. **多用户（无公开注册）**  
   - 仅登录，不支持自助注册  
   - 管理员可创建 / 禁用 / 重置密码 / 删除用户  
   - 首次部署用环境变量创建管理员账号

2. **多中转站**  
   - 用户可自行添加多个中转站（OpenAI / Google 兼容）  
   - 配置 Base URL、API Key、模型列表  
   - 中转站模型会出现在创作页模型选择器中

3. **过往图片引用（图生图）**  
   - 消息操作栏新增「用作参考图」  
   - 可将历史生成/上传图片加入输入区，进行图生图

## 快速开始（Node.js）

```bash
pnpm install
cp .env.node.example .env
# 编辑 .env，至少配置：
# DATABASE_URL=file:./db.sqlite
# ADMIN_EMAIL=admin@example.com
# ADMIN_PASSWORD=your-password

pnpm db:push   # 或 pnpm db:migrate
pnpm dev
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | SQLite 连接（Node） |
| `ADMIN_EMAIL` | 首个管理员邮箱（库为空时自动创建） |
| `ADMIN_PASSWORD` | 首个管理员密码 |
| `ADMIN_NAME` | 管理员显示名，可选 |
| `MODE` | 固定使用 `mixed`（服务端多用户） |
| `PROVIDER_CLOUDFLARE_BUILTIN` | 是否启用 CF 内置 AI |

## Cloudflare Workers

```bash
# 修改 wrangler.toml 中的 D1 database_id
pnpm build
pnpm db:migrate:worker
# 设置 secrets / vars：ADMIN_EMAIL、ADMIN_PASSWORD
pnpm deploy
```

`wrangler.toml` 中 `MODE` 已改为 `mixed`。

## 使用说明

1. 使用管理员账号登录  
2. **设置 → 用户管理**：创建普通用户  
3. **设置 → 中转站**：添加 API 中转与模型  
4. **设置 → AI 提供商**：配置系统内置提供商（可选）  
5. 在对话中生成图片后，悬停消息点「用作参考图」继续图生图  

## 技术栈

- React + Vite + TanStack Router  
- Hono + better-auth + Drizzle ORM  
- Cloudflare Workers / Node 双运行时  
