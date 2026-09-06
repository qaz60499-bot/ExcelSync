# ExcelSync

ExcelSync 是一个 Windows 桌面文件同步工具。客户端负责本地文件、队列、版本与恢复；Cloudflare Worker 负责认证、权限、版本一致性与 API；Cloudflare D1 保存业务索引和状态；实际文件可以存入 Telegram Bot 或 Telegram 私人群组。

> 发布版客户端不内置任何开发者个人账号、密码、Telegram Token、Telegram Session、Cloudflare Account ID、D1 ID 或固定 Worker 地址。使用者需要连接自己的 ExcelSync Worker，或加入已经部署好的 ExcelSync 组织。

## 1. 架构

```text
Windows 本地文件
      |
      v
ExcelSync Desktop (Electron)
      |
      | HTTPS
      v
Cloudflare Worker
  ├─ 登录 / Session / 邀请码
  ├─ Workspace / 权限 / 版本控制
  ├─ 幂等 / 冲突控制 / 上传状态
  └─ Storage Router
       |                 |
       v                 v
Cloudflare D1       Telegram Storage
元数据 / 索引 / 状态   ├─ Telegram Bot
                    └─ Telegram 私人群组 (MTProto)
```

### 数据放在哪里

- **本机**：本地 SQLite、同步队列、重试状态、本地版本状态、客户端设置。
- **Cloudflare D1**：账号、Workspace、权限、文件索引、版本元数据、上传状态等业务数据。
- **Telegram**：文件二进制内容。
- **客户端安装包**：不应包含用户账号、密码、Telegram Token、Telegram API Hash、Session 或个人 Cloudflare 配置。

---

## 2. 最快开始

### 情况 A：加入已经部署好的 ExcelSync

你只需要：

1. 安装 `ExcelSync-Setup-1.4.1-x64.exe`，或直接运行 Portable 版。
2. 打开 ExcelSync。
3. 填写管理员提供的 **Worker 地址**，例如：

   ```text
   https://your-excelsync-worker.example.com
   ```

4. 使用已有账号登录；或者选择 **“邀请码加入”**，输入管理员生成的一次性邀请码并设置自己的密码。

### 情况 B：自己部署一套 ExcelSync

需要准备：

- 一个 Cloudflare 账号；
- 一个 D1 数据库；
- ExcelSync Worker；
- 至少一种 Telegram 存储：
  - Telegram Bot；或
  - Telegram 私人群组；
- 首次创建 Owner 时使用的 Setup Code。

下面是完整流程。

---

# 3. 部署 Cloudflare Worker + D1

## 3.1 安装开发环境

建议安装当前 LTS 版本 Node.js，然后在项目目录执行：

```powershell
npm install
```

登录 Cloudflare：

```powershell
npx wrangler login
```

检查登录状态：

```powershell
npx wrangler whoami
```

## 3.2 创建 D1

创建数据库：

```powershell
npx wrangler d1 create excel-sync
```

Wrangler 会返回新的 `database_id`。把这个 ID 写入你自己的 `wrangler.jsonc`。

### 推荐的通用配置结构

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "excel-sync-worker",
  "main": "worker/src/index.ts",
  "compatibility_date": "2026-08-30",
  "compatibility_flags": ["nodejs_compat"],

  // 最简单的个人部署可以先使用 workers.dev。
  "workers_dev": true,

  "vars": {
    "RETENTION_LIMIT": "20",
    "SESSION_TTL_SECONDS": "2592000",
    "CLIENT_LATEST_VERSION": "1.4.1",
    "CLIENT_MINIMUM_VERSION": "1.3.1",
    "CLIENT_ROLLOUT_PERCENT": "100",
    "API_VERSION": "2026-08-31"
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "excel-sync",
      "database_id": "YOUR_D1_DATABASE_ID"
    }
  ],

  "observability": {
    "enabled": true,
    "head_sampling_rate": 0.1
  }
}
```

如果你使用自己的域名，可以关闭 `workers_dev`，并把 `routes` 改成你自己的 Cloudflare 域名配置。

**不要复制其他人的 D1 ID、Cloudflare Account ID 或 Worker 域名。**

## 3.3 执行 D1 Migration

```powershell
npm run d1:migrate:remote
```

Migration 完成后，D1 会建立 ExcelSync 所需的数据表与索引。

## 3.4 设置 `STORAGE_MASTER_KEY`

Telegram Bot Token 需要由 Worker 加密后再保存，因此自部署时必须配置 `STORAGE_MASTER_KEY`。

先生成一个随机密钥：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

然后写入 Cloudflare Worker Secret：

```powershell
npx wrangler secret put STORAGE_MASTER_KEY
```

按提示粘贴刚刚生成的随机值。

检查 Secret 是否已经存在：

```powershell
npx wrangler secret list
```

不要把真实密钥写入 README、Git、源码或公开日志。

## 3.5 部署 Worker

先做一次 Dry Run：

```powershell
npm run worker:deploy:dry
```

确认无错误后部署：

```powershell
npm run worker:deploy
```

部署完成后记录自己的 Worker HTTPS 地址，例如：

```text
https://excel-sync-worker.<your-subdomain>.workers.dev
```

或你绑定的自定义域名。

---

# 4. 创建第一个 Owner

全新 D1 没有账号。第一次使用时，需要先生成一个一次性 Setup Code。

在已经配置好目标 D1 的项目目录执行：

```powershell
node scripts/provision-bootstrap.mjs
```

脚本会：

1. 随机生成一次性 Setup Code；
2. 只把 Setup Code 的 SHA-256 Hash 写入 D1；
3. 把原始 Setup Code 临时保存到：

```text
%APPDATA%\ExcelSync\secure\bootstrap-nonce.pending
```

打开这个文件，复制其中的 Setup Code。

然后启动 ExcelSync：

1. 选择 **“创建 Owner”**；
2. 填写自己的 Worker 地址；
3. 输入 Owner 用户名；
4. 输入密码；
5. 粘贴 Setup Code；
6. 点击 **“创建 Owner 并登录”**。

创建成功后，Worker 会删除 D1 中对应的 Setup Code Hash，使这个 Setup Code 失效。

---

# 5. Telegram Bot 存储

Telegram Bot 模式适合配置简单、文件较小的环境。

当前 ExcelSync 对 **Telegram Bot 路径**按可靠性边界限制为：

- 上传：20 MiB；
- 下载：20 MiB；
- 单文件建议上限：20 MiB。

如果需要更大的文件，建议使用后面的 **Telegram 私人群组模式**。

## 5.1 创建 Bot

在 Telegram 中打开官方 `@BotFather`：

1. 发送 `/newbot`；
2. 设置 Bot 名称；
3. 设置 Bot username；
4. 保存 BotFather 返回的 **Bot Token**。

Bot Token 相当于密码，不要公开。

## 5.2 准备 Telegram 群组

1. 创建一个用于 ExcelSync 的 Telegram 私人群组；
2. 把刚创建的 Bot 加入群组；
3. 确保 Bot 有发送消息和文件所需权限。

## 5.3 在 ExcelSync 中添加 Bot

使用 Owner / Admin 登录 ExcelSync，在管理/存储连接页面：

1. 选择添加 Telegram 存储；
2. 输入连接名称；
3. 输入 Bot Token；
4. 点击 **“验证并添加”**。

Worker 会调用 Telegram `getMe` 验证 Token。验证成功后：

- Token 不会写进 EXE；
- Token 不会返回给 Renderer；
- Worker 使用 `STORAGE_MASTER_KEY` + AES-GCM 加密；
- 加密后的凭据保存到 D1。

## 5.4 配对目标聊天/群组

在 ExcelSync 中启动 Telegram 配对后，程序会给出一次性配对信息。

按照界面提示，在目标 Telegram 聊天/群组中向 Bot 发送：

```text
/start <配对码>
```

回到 ExcelSync 确认配对，然后把该 Telegram 存储连接绑定到需要使用的 Workspace。

## 5.5 关于 `TELEGRAM_BOT_TOKEN` Worker Secret

当前版本优先推荐在 ExcelSync 管理界面中添加 Bot，并让 Worker 使用 `STORAGE_MASTER_KEY` 加密保存。

源码仍保留 `TELEGRAM_BOT_TOKEN` 作为兼容/旧式服务器级配置路径。如果没有兼容旧部署的需求，不建议把全局 Bot Token 固定在 Worker 配置中。

---

# 6. Telegram 私人群组存储（MTProto）

私人群组模式使用 Telegram 用户账号，而不是 Bot API。它适合大文件和个人私有存储。

当前客户端能力模型支持的可靠文件上限为约 **2 GiB/文件**。

## 6.1 获取 Telegram API ID / API Hash

使用你自己的 Telegram 账号进入 Telegram 官方开发者页面，创建 API application，取得：

- `api_id`
- `api_hash`

这两个值属于你的 Telegram 开发者凭据，不应上传 GitHub 或发给其他人。

## 6.2 准备私人群组

1. 创建或选择一个 Telegram 私人群组；
2. 确保用于 ExcelSync 登录的 Telegram 用户已经加入这个群组；
3. 确保该账号有发送文件权限；
4. 记住群组名称。

## 6.3 在 ExcelSync 中配置

进入 ExcelSync 的 Telegram 私人群组设置，依次填写：

1. Telegram API ID；
2. Telegram API Hash；
3. 私人群组名称；
4. 点击 **“保存 Telegram 配置”**。

随后进行 Telegram 用户授权：

1. 输入手机号；
2. 输入 Telegram 收到的验证码；
3. 如果账号开启了两步验证，再输入 2FA 密码；
4. 授权成功后点击 **“绑定私人群组”**。

客户端会解析目标群组，并记录 Telegram Chat ID。

## 6.4 凭据保存方式

Telegram 用户模式中的：

- API ID；
- API Hash；
- 授权 Session；
- Chat ID；

保存在当前 Windows 用户的 ExcelSync 本地数据目录中，并通过 Electron `safeStorage` 加密。

它们不会写入发布版安装包，也不会作为普通明文配置上传到 GitHub。

如果 Telegram 授权失效，可以在客户端中重新授权，不需要重新安装 ExcelSync。

---

# 7. 邀请其他用户

Owner / Admin 可以在管理中心创建邀请码。

新用户：

1. 安装 ExcelSync；
2. 填写同一个 Worker 地址；
3. 选择 **“邀请码加入”**；
4. 输入管理员提供的一次性邀请码；
5. 设置自己的密码；
6. 完成加入后正常登录。

邀请码应该通过可信渠道单独发送，不要公开贴在 GitHub Issue、README 或群聊中。

## 7.1 主账户、分发账户与权限关系

ExcelSync 通常由一个 `OWNER` 主账户管理同一套 Worker / D1，不需要给每个使用者单独部署一套后端。其他使用者通过邀请加入，再按角色、Workspace 和资源范围分发权限。

### 系统角色

| 角色 | 定位 | 主要权限 |
| --- | --- | --- |
| `OWNER` | 主账户 / 组织所有者 | 最高组织权限；可管理 Admin、成员、Workspace、Storage、资源权限和系统状态 |
| `ADMIN` | 管理员 / 分发管理账户 | 可管理成员、邀请、Workspace、存储连接和日常管理操作 |
| `MEMBER` | 普通分发账户 | 只使用被分配的 Workspace 和资源 |

第一个通过 Setup Code 创建的账号就是 `OWNER`。通常只保留主要 Owner，需要协助管理的人由 Owner 把内部成员提升为 `ADMIN`；普通使用者保持 `MEMBER` 即可。

### 内部与外部账号

- `INTERNAL`：内部成员，可以被 Owner 提升为 Admin，也可以成为 Workspace 负责人；
- `EXTERNAL`：外部协作人，用于客户、外包、审计或临时分发，不能成为系统管理员或 Workspace 负责人，并可设置访问到期时间。

### Workspace 角色

- `MANAGER`：负责人；
- `EDITOR`：编辑者；
- `VIEWER`：查看者。

系统角色与 Workspace Role 是两层权限。`ADMIN` 是组织管理员；`MANAGER` 只是某个 Workspace 的负责人，两者不能互相替代。

### 资源范围

普通成员还可以进一步限制到：

- 整个 Workspace；
- 指定 Storage / Bot；
- 指定文件夹；
- 指定文件。

资源动作支持 `VIEW`、`EDIT`、`MANAGE`。成员最终有效权限同时受 Workspace Role、个人资源规则和用户组规则约束。

### 用户组批量分发

如果多人权限相同，可以创建“财务组”“外部审计组”“项目 A 组”等用户组，再一次性分配 Workspace / Storage / Folder / File 范围，不需要逐个账号重复设置。

### 多 Bot / 多 Storage 分发

同一组织可以添加多个 Telegram Storage 连接，再把不同 Workspace 指向不同 Storage，例如：

```text
财务 Workspace   -> Telegram Storage A
项目 A Workspace -> Telegram Storage B
归档 Workspace   -> Telegram Storage C
```

更换 Bot Token 时直接使用“更换 Token”。切换 Workspace 默认 Storage 只影响之后写入的新版本；历史版本仍按原来的 `storage_connection_id` 读取，不会自动迁移。

### 推荐的主账户 / 分发流程

1. Setup Code 创建首个 Owner；
2. Owner 配置 Workspace 和 Telegram Storage；
3. 可信内部管理人员加入后，由 Owner 提升为 Admin；
4. 普通内部用户通过邀请码加入为 Member；
5. 临时或外部人员使用 External，并设置到期时间；
6. 给账号分配 Workspace Role；
7. 必要时限制到 Storage / Folder / File；
8. 多人相同权限时使用用户组批量分发。

---

# 8. 文件同步、版本与恢复

- 本地文件事件会经过 debounce、稳定性检查和 SHA-256 去重。
- 本地 SQLite 保存待上传任务、重试状态和同步状态。
- 网络中断不会阻止文件继续保存在本地。
- Pending 任务可以跨应用重启恢复。
- 删除本地文件不会自动删除 SaaS 端文件；已上传文件会成为“仅云端”。
- “从 SaaS 删除”是显式操作，会把逻辑文件移动到 D1 的 `trashed` 状态。
- 恢复旧版本会创建一个新的当前版本，不会把版本号倒退。
- 同步冲突使用 `base_version` 检测，不进行 Excel 单元格级自动合并。

### 支持的常见类型

- Excel：`.xlsx` `.xlsm` `.xls` `.xlsb` `.csv` `.tsv`
- 文档：`.pdf` `.docx` `.txt` `.md` `.rtf`
- 压缩包：`.zip`
- 数据：`.json` `.jsonl` `.xml` `.yaml` `.yml`
- 演示文稿：`.pptx`
- 图片：`.png` `.jpg` `.jpeg` `.webp` `.bmp` `.tif` `.tiff`

`.xlsm` 只作为文件保存和恢复，ExcelSync 不执行其中的 VBA Macro。

---

# 9. 安全说明

发布前建议确认以下原则：

- 不在源码或 Release 中提交真实密码；
- 不提交 Telegram Bot Token；
- 不提交 Telegram Session；
- 不提交 Telegram API Hash；
- 不提交 `STORAGE_MASTER_KEY`；
- 不提交个人 Cloudflare Account ID；
- 不把个人 D1 ID 当成公共默认值；
- 不把开发者自己的 Worker 地址编译进通用客户端；
- 每个自部署用户使用自己的 Cloudflare 与 Telegram 凭据。

账号密码由 Worker 处理。Session 使用随机不透明 Token，D1 只保存 Session Token 的 SHA-256 Hash。Windows 客户端使用 Electron `safeStorage` 保存敏感本地 Session 数据。

---

# 10. Setup 与 Portable 的区别

### `ExcelSync-Setup-1.4.1-x64.exe`

- 标准 Windows 安装程序；
- 可选择安装目录；
- 创建桌面/开始菜单入口；
- 适合长期使用。

### `ExcelSync-Portable-1.4.1-x64.exe`

- 无需安装即可运行；
- 适合测试、临时使用或携带；
- 用户数据仍由应用自己的 Windows 用户数据目录管理，并不是“所有数据都塞在 EXE 里”。

---

# 11. 开发、测试与构建

## 开发

```powershell
npm install
npm run typecheck
npm test
npm run dev
```

## Worker 检查

```powershell
npm run worker:types
npm run worker:deploy:dry
```

## 完整检查

```powershell
npm run check
```

## Windows 构建

```powershell
npm run package:win
```

生成：

- Setup 安装版；
- Portable 便携版；
- unpacked 调试/验收目录。

---

# 12. 常见问题

### 客户端提示 Worker 地址不可用

- 确认地址是完整 HTTPS URL；
- 确认 Worker 已部署；
- 确认不是把 D1 URL、Cloudflare Dashboard URL 或 GitHub URL 填进去；
- 正式打包客户端要求远程 Worker 使用 HTTPS。

### 无法创建 Owner

- 确认是全新/尚未初始化的部署；
- 重新执行 `node scripts/provision-bootstrap.mjs`；
- 使用最新生成的 Setup Code；
- 确认脚本操作的 D1 与客户端连接的 Worker 使用的是同一个 D1。

### Telegram Bot 验证失败

- 检查 Bot Token；
- 检查 Bot 是否被 BotFather 删除/重置；
- 检查 Worker 是否可以访问 `api.telegram.org`；
- 检查 `STORAGE_MASTER_KEY` 是否已经配置。

### Telegram Bot 能连接但无法保存文件

- 确认 Bot 已经加入目标群组；
- 确认完成 `/start <配对码>`；
- 确认 Bot 有发送文件权限；
- 检查文件是否超过当前 Bot 模式 20 MiB 边界。

### Telegram 私人群组无法登录

- 检查 API ID / API Hash；
- 检查手机号国家区号；
- 检查 Telegram 验证码；
- 如果启用了 2FA，需要继续输入两步验证密码。

### Telegram 私人群组找不到群组

- 确认当前登录的 Telegram 账号已经加入目标群组；
- 确认群组名称填写正确；
- 确认账号有访问/发送文件权限；
- 保存配置后重新执行“绑定私人群组”。

### 分发账户登录成功，但看不到文件

依次检查：

1. 账号状态是否为 `ACTIVE`；
2. 是否已经加入正确的 Workspace；
3. Workspace Role 是否正确；
4. 是否只授权了部分 Storage / Folder / File；
5. 是否存在用户组继承规则；
6. External 账号是否已经过期。

### 想让某个分发账户帮忙管理其他账号

由 Owner 把该 `INTERNAL` 成员的系统角色从 `MEMBER` 提升为 `ADMIN`。只把 Workspace Role 改成 `MANAGER` 不等于系统管理员。

### 更换 Telegram Bot 后旧文件怎么办

如果只是给原 Storage 执行“更换 Token”，要确保新 Bot 能访问对应 Telegram 存储位置。如果新建了 Storage 并切换 Workspace 默认存储，则只影响后续新版本；历史版本仍依赖原 Storage，不会自动搬迁。

### 上传任务卡住、断网或重启后没有立即完成

- 保持本地源文件存在且可读；
- 重开客户端后让持久化 Pending / Retry 队列继续恢复；
- 检查 Worker、D1 和当前 Storage 健康状态；
- 检查登录 Session 是否失效；
- Bot 模式检查文件是否超过 20 MiB；
- 不要手工删除本地 SQLite、缓存或状态目录来“重置”，否则可能破坏待恢复队列。

### 本地删除文件后为什么云端还在

这是设计行为。本地删除不会自动删除 SaaS 端副本；已上传文件会成为“仅云端”。真正需要从 SaaS 删除时，应使用客户端的“从 SaaS 删除”。

### 恢复旧版本后为什么版本号继续增加

这是设计行为。恢复旧版本会创建新的当前版本，例如当前 V10 恢复 V7 后生成 V11，而不是把版本时间线倒退到 V7。

---

# 13. GitHub 发布方式

推荐做法：

1. 把本 `README.md` 放在 GitHub 仓库根目录；
2. 在 GitHub 创建对应版本的 **Release**，例如 `v1.4.1`；
3. 把以下两个文件作为 Release Assets 上传：
   - `ExcelSync-Setup-1.4.1-x64.exe`
   - `ExcelSync-Portable-1.4.1-x64.exe`
4. 同时上传 `SHA256SUMS.txt`，方便用户校验下载文件；
5. 不建议把大型 EXE 直接提交到 Git 源码历史中。

Release 页面可以简单说明：Setup 适合正常安装，Portable 适合免安装测试和临时使用。

# 14. 发布包隐私边界

官方/通用 Release 应当保持为纯净客户端：

```text
不包含开发者 Worker URL
不包含开发者 D1 ID
不包含 Cloudflare Account ID
不包含账号密码
不包含 Telegram Bot Token
不包含 Telegram API Hash
不包含 Telegram Session
不包含本地 SQLite / 缓存 / 日志
```

首次启动后，由用户自己输入 Worker 地址并完成登录、邀请加入或 Owner 初始化。

这也是推荐的 GitHub 发布方式。
