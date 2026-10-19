# API 接口清单（M1）

> 前缀：`/api/v1`
> 代码位置：`apps/api/src/modules/*/routes.ts`
> 共享校验与类型：`packages/shared/src/*`

---

## 1. 通用约定

### 1.1 响应包

**一切响应都是这个形状**，包括错误。前端只需要判断 `code === 0`。

```jsonc
// 成功
{ "code": 0, "message": "ok", "data": { ... }, "requestId": "req_8f3a..." }

// 失败（HTTP 状态码同样有意义，便于网关/日志观测）
{ "code": 40100, "message": "邮箱或密码错误", "data": null, "requestId": "req_8f3a..." }
```

- `code` 是**业务错误码**，前端按它分支；HTTP 状态码只做粗粒度分类
- `requestId` 贯穿日志（`X-Request-Id` 请求头透传，便于排查）

### 1.2 鉴权

| 令牌 | 载体 | 有效期 | 说明 |
|---|---|---|---|
| Access Token | `Authorization: Bearer <jwt>` | 15m | 无状态，不查库；payload 含 `sub`(userId) / `sid`(sessionId) / `role` |
| Refresh Token | httpOnly + SameSite=Lax Cookie `nc_rt` | 30d | 只在 `/auth/refresh` 与 `/auth/logout` 使用 |

- Access Token 过期返回 **40101**，前端拦截到它应**静默调 `/auth/refresh` 后重放原请求**
- Refresh 重放（已被撤销的 token 再次出现）返回 **40102**，前端必须强制登出

### 1.3 错误码表

| code | HTTP | 含义 | 前端处理 |
|---|---|---|---|
| 0 | 200 | 成功 | — |
| 40000 | 400 | 参数校验失败 | 展示 `data.issues` 字段级错误 |
| 40010 | 400 | 邀请无效/过期/已达使用上限 | 提示并引导联系管理员 |
| 40100 | 401 | 未登录或 Access Token 无效 | 跳登录页 |
| 40101 | 401 | Access Token 过期 | **静默 refresh 后重试** |
| 40102 | 401 | Refresh Token 重放，会话族已吊销 | **强制登出** + 提示"登录状态异常" |
| 40103 | 401 | 账号已被停用 | 提示联系站点管理员 |
| 40300 | 403 | 无权限 | 提示无权限 |
| 40301 | 403 | 不是该工作区成员 | 从列表移除该工作区 |
| 40302 | 403 | 角色权限不足 | 提示需要什么角色 |
| 40310 | 403 | 站点已关闭注册 | 引导用邀请链接 |
| 40400 | 404 | 资源不存在 | — |
| 40900 | 409 | **乐观锁冲突**（版本不一致） | 弹「他人已修改」并提供 覆盖/放弃 |
| 40901 | 409 | 邮箱已被注册 | 表单字段级提示 |
| 40902 | 409 | 不能移除/降级最后一个 OWNER | 提示先转让所有权 |
| 40903 | 409 | slug 已被占用 | 提示换一个 |
| 41300 | 413 | 上传文件过大 | — |
| 42900 | 429 | 触发限流 | 按 `Retry-After` 重试 |
| 50000 | 500 | 服务端异常 | 展示 requestId 便于报障 |

### 1.4 分页

游标分页（`cursor` 为上一页最后一条的 `id`）：

```
GET /api/v1/workspaces/:id/members?limit=20&cursor=clx...
```
```jsonc
{ "code": 0, "data": { "items": [...], "nextCursor": "clx...", "hasMore": true } }
```

### 1.5 幂等与限流

- 写操作支持 `Idempotency-Key` 请求头（已实现，见 §15.3）
- 限流：`/auth/login`、`/auth/register`、`/auth/refresh` 按 IP + 账号双维度限制（`@fastify/rate-limit`）

---

## 2. 站点（无需登录）

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/site/status` | **前端启动第一个请求**：返回引导状态与注册策略 | 公开 |

```jsonc
// GET /site/status
{
  "code": 0,
  "data": {
    "siteName": "NoteCloud",
    "initialized": true,            // 是否已存在任何用户（false → 前端跳首次启动引导页）
    "registration": {
      "enabled": false,             // 公开注册开关（当前 false = 邀请制）
      "requireEmailVerification": false,
      "mailConfigured": false       // SMTP 是否配好（决定是否显示"忘记密码"）
    },
    "version": "0.1.0"
  }
}
```

> 前端逻辑：`initialized=false` → 引导页创建管理员；否则显示登录页，注册入口仅在 `registration.enabled=true` **或** URL 带邀请 token 时出现。

---

## 3. 认证 `/auth`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | `/auth/register` | 注册。三种放行条件：①系统无用户（首个即管理员）②`registration.enabled` ③带了有效邀请 token | 公开 |
| POST | `/auth/login` | 登录，下发 Access + Set-Cookie Refresh | 公开 |
| POST | `/auth/refresh` | 用 cookie 换新 Access，并轮转 Refresh | 公开（凭 cookie） |
| POST | `/auth/logout` | 吊销当前会话，清 cookie | 登录 |
| GET | `/auth/me` | 当前用户 + 其工作区列表 + 各工作区角色 | 登录 |
| PATCH | `/auth/me` | 改昵称 / 头像 / 时区 / 语言 | 登录 |
| POST | `/auth/password/change` | 改密码（需旧密码），**成功后吊销其他所有会话** | 登录 |
| POST | `/auth/password/forgot` | 发重置邮件 | 公开 |
| POST | `/auth/password/reset` | 用 token 重置 | 公开 |

<details>
<summary><b>POST /auth/register</b></summary>

```jsonc
// 请求
{
  "email": "zhang@example.com",
  "password": "至少10位，需含字母与数字",
  "name": "张三",
  "inviteToken": "可选，来自邀请链接"
}
// 响应 201
{
  "code": 0,
  "data": {
    "user": { "id": "clx...", "email": "...", "name": "张三", "role": "USER" },
    "accessToken": "eyJ...",
    "workspaces": [{ "id": "clx...", "name": "张三的个人空间", "role": "OWNER", "isPersonal": true }]
  }
}
```
<b>副作用</b>（同一个事务内）：
1. 创建 user（若系统无用户 → `role = ADMIN`）
2. 创建个人工作区 `isPersonal=true` + `WorkspaceMember(role=OWNER)`
3. 若有 `inviteToken` → 校验并加入对应工作区，`uses += 1`
4. 创建 session，Set-Cookie
</details>

<details>
<summary><b>POST /auth/login</b></summary>

```jsonc
// 请求
{ "email": "...", "password": "..." }
// 响应 200
{
  "code": 0,
  "data": {
    "accessToken": "eyJ...",
    "expiresIn": 900,
    "user": { "id": "...", "email": "...", "name": "...", "role": "ADMIN", "emailVerified": false }
  }
}
// Set-Cookie: nc_rt=<opaque>; HttpOnly; SameSite=Lax; Path=/api/v1/auth; Max-Age=2592000
```
失败一律返回 **40100**（不区分"邮箱不存在"与"密码错误"，避免账号枚举）。
`status=DISABLED` 返回 **40103**。
</details>

<details>
<summary><b>POST /auth/refresh</b>（轮转 + 重放检测）</summary>

```
Cookie: nc_rt=<opaque>
```
- 有效 → 旧 session `revokedAt = now`、`replacedById = 新session`，发新 Access + 新 Refresh，**同 familyId**
- 无效/过期 → 40100
- **已被撤销的 token 再次出现 → 吊销整个 familyId → 40102**
</details>

---

## 4. 当前用户 `/me`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/me/sessions` | 我的登录设备列表（UA 解析后展示：浏览器 / 系统 / IP / 最后活跃） |
| DELETE | `/me/sessions/:sessionId` | 撤销指定设备 |
| DELETE | `/me/sessions` | 撤销除当前外的全部设备 |

---

## 5. 工作区 `/workspaces`

| 方法 | 路径 | 说明 | 最低角色 |
|---|---|---|---|
| GET | `/workspaces` | 我加入的工作区列表（含 `role`、成员数、未读数占位） | 登录 |
| POST | `/workspaces` | 创建团队工作区（自动成为 OWNER） | 登录 |
| GET | `/workspaces/:id` | 详情 | MEMBER |
| PATCH | `/workspaces/:id` | 改名 / 图标 / 颜色 / slug | ADMIN |
| DELETE | `/workspaces/:id` | 软删除（需 `?confirm=<slug>` 二次确认） | OWNER |
| POST | `/workspaces/:id/transfer` | 转让所有权给指定成员 | OWNER |
| POST | `/workspaces/:id/leave` | 退出（最后一个 OWNER 返回 40902） | MEMBER |

---

## 6. 成员 `/workspaces/:id/members`

| 方法 | 路径 | 说明 | 最低角色 |
|---|---|---|---|
| GET | `/workspaces/:id/members` | 成员列表（游标分页，支持 `?q=` 搜索昵称/邮箱） | MEMBER |
| PATCH | `/workspaces/:id/members/:userId` | 改角色 `{ role: "ADMIN" }` | ADMIN |
| DELETE | `/workspaces/:id/members/:userId` | 移除成员 | ADMIN |

**服务端不变量（必须在事务里守住）**：
- 不能把自己降级（避免误操作锁死自己）→ 40302
- 不能修改/移除 `OWNER` → 40302
- 操作后若工作区 `OWNER` 数量为 0 → 40902
- 被移除的成员，其**个人空间不受影响**；后续（M2）其创建的私有资源归属需另行定义 ⚠️
- `GUEST` 不出现在普通成员列表里（单独 tab，M5 实现）

---

## 7. 邀请 `/workspaces/:id/invitations` 与 `/invitations`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/workspaces/:id/invitations` | 邀请列表（含状态、使用次数、剩余有效期） | ADMIN |
| POST | `/workspaces/:id/invitations` | 创建邀请 | ADMIN |
| DELETE | `/workspaces/:id/invitations/:invitationId` | 撤销邀请 | ADMIN |
| GET | `/invitations/:token` | **公开**：预览邀请（工作区名、邀请人、角色、是否还可接受） | 公开 |
| POST | `/invitations/:token/accept` | 接受邀请（已登录用户） | 登录 |

<details>
<summary><b>POST /workspaces/:id/invitations</b></summary>

```jsonc
// 请求：两种形态
{ "email": "li@example.com", "role": "MEMBER", "expiresInDays": 7 }   // 指定邮箱（需 SMTP，暂缓）
{ "role": "MEMBER", "maxUses": 5, "expiresInDays": 7 }                // 通用链接 ← 当前阶段用这个
// 响应 201（明文 token 只在这里出现一次）
{
  "code": 0,
  "data": {
    "id": "clx...",
    "url": "https://note.example.com/invite/3f8c1e9a...",
    "role": "MEMBER",
    "maxUses": 5,
    "expiresAt": "2026-10-23T09:00:00.000Z"
  }
}
```
</details>

**接受邀请的判定顺序**（每一步都要有明确错误码）：
1. token 查不到 → 40010
2. `status != PENDING` → 40010
3. 已过期 → 40010
4. `uses >= maxUses` → 40010
5. 已是成员 → 直接返回成功（幂等，不报错）
6. 指定邮箱且与当前用户不符 → 40300
7. 通过 → 事务内：建 `WorkspaceMember` + `uses += 1` + 写审计日志

---

## 8. 健康检查（无前缀）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 进程存活，不查库 |
| GET | `/readyz` | `SELECT 1` 探活数据库，失败返回 503 |

---

## 9. 笔记 / 笔记本 / 标签（M2）

全部挂在工作区下，权限下限 `MEMBER`。`GUEST` 的资源级授权留到 M5。

### 9.1 笔记本

| 方法 | 路径 | 说明 | 最低角色 |
|---|---|---|---|
| GET | `/workspaces/:id/notebooks` | 笔记本树。返回**扁平数组**（含 `parentId`/`depth`/`position`），前端自行组装 | MEMBER |
| POST | `/workspaces/:id/notebooks` | 新建，可带 `parentId`（最多 5 层） | MEMBER |
| POST | `/workspaces/:id/notebooks/reorder` | 整体重排：`{ parentId, orderedIds: string[] }`。含**环路检测**与**深度重算**，允许空数组 | MEMBER |
| PATCH | `/workspaces/:id/notebooks/:notebookId` | 改名 / 图标 / 颜色 | MEMBER |
| DELETE | `/workspaces/:id/notebooks/:notebookId` | 软删除（含全部子孙）。**只解除与笔记的关联，不删笔记** | 创建者或 ADMIN |

> 排序为什么用"整体重排"而不是稀疏索引？笔记本数量是几十级，整组重排更简单、更不容易出错。

### 9.2 标签

| 方法 | 路径 | 说明 | 最低角色 |
|---|---|---|---|
| GET | `/workspaces/:id/tags` | 标签列表（含引用计数） | MEMBER |
| POST | `/workspaces/:id/tags` | 新建。**同名直接复用**，不报错 | MEMBER |
| PATCH | `/workspaces/:id/tags/:tagId` | 改名 / 颜色（改名撞名返回 40903） | MEMBER |
| DELETE | `/workspaces/:id/tags/:tagId` | 硬删除，自动解除与笔记的关联 | ADMIN |

### 9.3 笔记

| 方法 | 路径 | 说明 | 最低角色 |
|---|---|---|---|
| GET | `/workspaces/:id/notes` | 列表，支持 `view` / `notebookId` / `tagId` / `q` / `limit` / `cursor` | MEMBER |
| GET | `/workspaces/:id/notes/search?q=` | 纯全文检索（ngram 相关度排序） | MEMBER |
| POST | `/workspaces/:id/notes` | 新建 | MEMBER |
| GET | `/workspaces/:id/notes/:noteId` | 详情（含 `content`） | MEMBER |
| PATCH | `/workspaces/:id/notes/:noteId` | 保存。**`version` 必填**，见 §9.4 | MEMBER |
| PUT | `/workspaces/:id/notes/:noteId/notebooks` | 整体覆盖笔记本归属 | MEMBER |
| PUT | `/workspaces/:id/notes/:noteId/tags` | 整体覆盖标签 | MEMBER |
| DELETE | `/workspaces/:id/notes/:noteId` | 移入回收站（软删） | MEMBER |
| POST | `/workspaces/:id/notes/:noteId/restore` | 从回收站恢复 | MEMBER |
| DELETE | `/workspaces/:id/notes/:noteId/purge` | 彻底删除 | 创建者或 ADMIN |
| DELETE | `/workspaces/:id/trash` | 清空回收站（只清自己有权删的） | MEMBER |

**列表参数语义**

| 参数 | 取值 |
|---|---|
| `view` | `all`（默认，排除归档/回收站）/ `starred` / `archived` / `trash` |
| `notebookId` | 笔记本 id；传 **`none`** 表示收件箱（不属于任何笔记本） |
| `tagId` | 按标签过滤 |
| `q` | 搜索词。**≥2 字符走 ngram 全文索引**；1 字符退化为标题 `LIKE`（ngram_token_size=2 时单字切不出词） |
| `unassigned` | `1` = 只看不在任何看板上的任务（往看板加卡片时用） |

### 9.4 乐观锁（最重要的约定）

保存必须带 `version`，服务端用原子 CAS：

```jsonc
// PATCH /workspaces/:id/notes/:noteId
{ "version": 3, "title": "新标题", "content": "..." }
```

- 版本匹配 → `200`，返回的 `note.version` 变成 `4`
- 版本不匹配 → **`40900`**，且 `data.current` 带回**服务端最新内容**：

```jsonc
{
  "code": 40900,
  "message": "内容已被他人修改",
  "data": {
    "current": { "id": "...", "version": 5, "title": "...", "content": "...", "updatedBy": { "name": "张三" } }
  }
}
```

前端必须让用户选择「用服务端版本」或「用我的覆盖」，**不允许静默重试覆盖**。
`data.current.version` 就是"用我的覆盖"时该提交的版本号。

---

## 10. 待办任务 / 子任务 / 评论（M3）

权限下限同样是 `MEMBER`。任务**没有** `visibility` 字段 —— 工作区内所有成员可见（与笔记不同）。

### 10.1 任务

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workspaces/:id/tasks` | 列表，支持 `view` / `status` / `tagId` / `q` / `limit` / `cursor` |
| POST | `/workspaces/:id/tasks` | 新建（可同时带 `checklist` 与 `tagIds`） |
| GET | `/workspaces/:id/tasks/:taskId` | 详情 |
| PATCH | `/workspaces/:id/tasks/:taskId` | 更新。**`version` 必填**，协议与笔记完全一致 |
| PATCH | `/workspaces/:id/tasks/:taskId/checklist/:itemId` | 勾选子任务 `{ done }`。**不需要 version** |
| PUT | `/workspaces/:id/tasks/:taskId/column` | 放进看板某列 / 移出看板：`{ columnId: string \| null }` |
| DELETE | `/workspaces/:id/tasks/:taskId` | 移入回收站 |
| POST | `/workspaces/:id/tasks/:taskId/restore` | 恢复 |
| DELETE | `/workspaces/:id/tasks/:taskId/purge` | 彻底删除（同时清掉它的评论） |

**`view` 取值**

| view | 含义 |
|---|---|
| `all` | 全部**未结束**的任务（排除 `DONE` / `CANCELED`） |
| `today` | 截止时间落在**用户本地时区**的今天 |
| `week` | 今天起 7 天内 |
| `overdue` | 已逾期且未结束 |
| `done` | `status = DONE` |
| `assigned` | 指派给我、未结束 |
| `mine` | 我创建的、未结束 |
| `trash` | 回收站 |

> `today` / `week` 用 `users.timezone` 算边界（服务端 `startOfDayInTz`）。
> 库里存的是 UTC，语义边界是本地时间。

**`PATCH` 的两个特别注意**

1. `version` 必填，冲突返回 `40900` + `data.current`（与笔记同构）。
2. `checklist` 与 `tagIds` 是**整体覆盖**：传了就替换全部，不传则不动。

### 10.2 评论

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workspaces/:id/tasks/:taskId/comments` | 按时间正序 |
| POST | `/workspaces/:id/tasks/:taskId/comments` | `{ body, mentions?: string[] }` |
| PATCH | `/workspaces/:id/comments/:commentId` | 只能改自己的 |
| DELETE | `/workspaces/:id/comments/:commentId` | 自己的或 ADMIN |

`mentions` 是 userId 数组，服务端会过滤掉非工作区成员。M3 只用于前端高亮，**不推通知**（M5）。

---

## 11. 看板（M4）

方案 A：**卡片就是任务**。看板的列只是任务的一个视图维度，拖进某列 = 改 `columnId` + 同步 `status`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workspaces/:id/boards` | 看板列表（含列数与卡片数） |
| POST | `/workspaces/:id/boards` | 新建（自动带 待办/进行中/已完成 三列） |
| GET | `/workspaces/:id/boards/:boardId` | 详情：`{ board, columns: [{ ...列, tasks: TaskDto[] }] }` |
| PATCH | `/workspaces/:id/boards/:boardId` | 改名 / 描述 / 图标 / 颜色 |
| DELETE | `/workspaces/:id/boards/:boardId` | 软删（**ADMIN**）。其中的任务脱离看板但不被删除 |
| POST | `/workspaces/:id/boards/:boardId/columns` | 添加列 `{ name, status, wipLimit?, color? }` |
| POST | `/workspaces/:id/boards/:boardId/columns/reorder` | 列排序 `{ orderedIds }` |
| PATCH | `/workspaces/:id/board-columns/:columnId` | 改名 / 改映射状态 / WIP / 颜色 |
| DELETE | `/workspaces/:id/board-columns/:columnId` | 删列（至少保留一列）。列内任务脱离看板 |
| POST | `/workspaces/:id/boards/:boardId/move` | **拖动卡片**，见下 |
| GET | `/workspaces/:id/board-columns` | 所有看板的列（扁平，供"把任务放进看板"的选择器用） |

### 11.1 拖动卡片

```jsonc
POST /workspaces/:id/boards/:boardId/move
{
  "taskId": "clx...",
  "columnId": "clx...",          // 目标列
  "orderedTaskIds": ["a", "b"]   // 目标列的**完整顺序**（含被拖动的卡片）
}
```

响应直接返回整个看板详情，前端拿到就能重绘，不用再发一次 GET。

服务端行为：

1. 校验列必须属于这块看板
2. **WIP 上限**：从别的列移进来才检查，列内重排不拦
3. 同一个事务里：`columnId` + `status = column.status` + `completedAt/canceledAt` + 按 `orderedTaskIds` 重排 `position`
4. `orderedTaskIds` 里不属于该列的 id 会被忽略（防止客户端打乱别的列）

> **不做乐观锁**：拖拽是高频操作，用 `version` 会让"别人刚改过标题"导致拖不动。
> 多人同时拖同一张卡时按到达顺序后写生效 —— 这是看板类产品的通行做法。

### 11.2 列的映射状态

`board_columns.status` 决定"拖进这一列的任务是什么状态"。
**改列的状态会同步这一列里所有任务的 `status`**（以及 `completedAt/canceledAt`），保证看板与待办一致。

---

## 12. 附件（M5-A）

### 12.1 上传

```jsonc
POST /workspaces/:id/attachments
Content-Type: multipart/form-data
file=<binary>

// 响应
{ "code": 0, "data": { "attachment": {
  "id": "clx...", "url": "/api/v1/attachments/clx.../<token>",
  "filename": "截图.png", "mimeType": "image/png", "size": 102400,
  "createdAt": "2026-10-17T..."
} } }
```

- 单文件、上限由 `.env` 的 `MAX_UPLOAD_MB` 控制
- 类型白名单：图片（png/jpeg/gif/webp/avif）、PDF、txt/md/csv/json、zip、docx/xlsx/pptx
- **刻意拒绝 `image/svg+xml`**：SVG 可内嵌脚本，同源直接打开会执行
- 存储键由服务端生成（`<workspaceId>/<yyyy>/<mm>/<uuid>.<ext>`），不含用户输入

### 12.2 读取（能力链接，无需登录）

```
GET /api/v1/attachments/:id/:token
```

这是全站**唯一**不需要鉴权的业务路由。URL 里的 `token` 是 32 字节随机值，不可猜测。

为什么不做成"必须登录"：Markdown 里的 `<img>` 无法携带 `Bearer` token，
要求登录态就得改写渲染逻辑（签名 URL 或代理）。对自部署团队工具来说，
不可猜测的 URL 已经足够 —— 等价于「知道链接即可访问」。

响应头：
- `Cache-Control: private, max-age=31536000, immutable`（token 绑定内容，内容不变）
- `X-Content-Type-Options: nosniff`
- 图片 `inline`，其它类型 `Content-Disposition: attachment`

### 12.3 其它

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workspaces/:id/attachments` | 工作区附件列表（**ADMIN**），用于排查与清理 |
| DELETE | `/workspaces/:id/attachments/:attachmentId` | 上传者或 ADMIN。同时删库记录与磁盘文件 |

### 12.4 孤儿清理

定时任务每天清理**上传超过 24 小时且没有任何未删除笔记引用**的附件：

```sql
-- 实际做法：逐个附件执行
SELECT COUNT(*) FROM notes
WHERE workspaceId = ? AND deletedAt IS NULL AND content LIKE CONCAT('%', ?, '%')
```

24 小时宽限是为了避免"刚粘贴图片、还没保存笔记"时被误删。
单次最多处理 200 个，全表扫描的代价在自部署规模下可接受；真到瓶颈再换引用表。

---

## 13. 通知 / 关注者（M5-B）

通知是**站内信**：写入即持久化，前端每 30 秒轮询未读数。不做邮件与 Web Push。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/me/notifications` | 我的通知（`unreadOnly=1` / `limit` / `cursor`） |
| GET | `/me/notifications/unread-count` | 未读数（轮询专用，比拉整页便宜） |
| POST | `/me/notifications/:id/read` | 标记单条已读 |
| POST | `/me/notifications/read-all` | 全部已读 |
| GET | `/workspaces/:id/tasks/:taskId/watchers` | `{ items, watching }`，`watching` 是「我是否关注」 |
| POST | `/workspaces/:id/tasks/:taskId/watch` | 关注 |
| DELETE | `/workspaces/:id/tasks/:taskId/watch` | 取消关注 |

### 13.1 什么时候会产生通知

| 类型 | 触发 | 收件人 |
|---|---|---|
| `TASK_ASSIGNED` | 任务创建时带负责人，或负责人被改 | 新负责人 |
| `MENTION` | 评论里 `mentions` 包含某人 | 被 @ 的人 |
| `TASK_COMMENT` | 任务有新评论 | 该任务的**关注者** |
| `TASK_DUE` | `reminderAt` 到期（每分钟扫描） | 负责人，没有则创建者 |

### 13.2 「关注者」的语义（重要）

收件人 = **@提及 ∪ 关注者**，只此两类。**创建者/负责人没有特殊待遇** ——

- 创建任务 → 创建者自动成为关注者
- 被指派 → 自动成为关注者
- 发表评论 → 评论者自动成为关注者

这样「取消关注」才是真的能停止通知。如果把创建者写死成必收，
按钮就会变成摆设。

### 13.3 其它约定

- **自己触发的操作不通知自己**（`recipientId === actorId` 直接跳过）
- `notifyMany` 会按 `收件人+类型+目标` 去重，一条评论不会重复轰炸
- 通知里的 `link` 是前端路径，点击后直接跳转（如 `/w/<id>/tasks?task=<id>`）
- 改 `reminderAt` 会重置 `reminderSentAt`，新的提醒才能再次触发

---

## 14. 同步 / 分享 / 智能视图 / 实时（M5-C、M5-D）

### 14.1 增量同步

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workspaces/:id/sync/changes?since=<seq>&limit=200` | 拉取游标之后的变更 |

- 不带 `since` → 只返回**当前游标**（客户端首次拿基线，不返回历史）
- 响应：`{ changes: [{ seq, entityType, entityId, op, version, changedAt }], cursor, hasMore }`
- `seq` 是 `BigInt` 自增，**序列化成字符串**（JSON 不能直接放 BigInt）
- `op`：`upsert` / `delete`
- 服务端写变更日志是**尽力而为**：写失败不影响主业务（丢一条最多让客户端多刷新一次）

### 14.2 实时推送（WebSocket）

```
GET /api/v1/ws?token=<accessToken>
```

- token 走 query —— 浏览器的 WebSocket 构造函数不支持自定义请求头
- 服务端校验 access token **和**会话是否仍有效（登出/改密会立刻断开）
- 断线由客户端指数退避重连（封顶 30 秒），4401 表示认证失败不重连

事件：

| type | 触发 | 前端动作 |
|---|---|---|
| `connected` | 握手成功 | 心跳确认 |
| `notification` | 有新通知 | 刷新未读角标 |
| `note.changed` | 笔记增删改 | 刷新笔记列表 |
| `task.changed` | 任务增删改 | 刷新任务列表 |
| `board.changed` | 卡片被拖动 | 重拉该看板 |

> 广播会**排除触发者自己**，避免自己刚拖完卡片又被自己的事件刷一遍。

### 14.3 分享链接

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/workspaces/:id/notes/:noteId/share` | 创建 `{ expiresInDays? }` |
| GET | `/workspaces/:id/notes/:noteId/share` | 该笔记的所有分享链接 |
| DELETE | `/workspaces/:id/share-links/:linkId` | 撤销 |
| GET | `/share/:token` | **公开**读取笔记内容 |

- 返回的 `path` 是**前端页面路径** `/share/<token>`；读内容走 `/api/v1/share/<token>`
- `PRIVATE` 的笔记也能被分享 —— 分享是独立于"工作区内可见性"的显式授权
- 撤销/过期后返回 `40400`

### 14.4 智能视图

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workspaces/:id/smart-views` | 共享的 + 自己私有的 |
| POST | `/workspaces/:id/smart-views` | `{ name, filter, isShared }` |
| PATCH | `/workspaces/:id/smart-views/:viewId` | 改名/改过滤/改共享 |
| DELETE | `/workspaces/:id/smart-views/:viewId` | 删除 |

`filter` 结构：`{ view?, notebookId?, tagId?, q? }`（目前只用于笔记列表）。
私有视图只有创建者能改；共享视图需要 ADMIN。

---

## 15. 站点管理 / 工作区恢复 / 幂等（M1 补全）

### 15.1 站点管理（仅 `SiteRole = ADMIN`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/overview` | 用户/工作区/笔记/任务/附件/在线会话的全局统计 |
| GET | `/admin/users?q=&limit=&cursor=` | 用户列表（可按邮箱或昵称搜索） |
| PATCH | `/admin/users/:userId` | `{ status?, role? }` —— 停用/启用、设为/取消站点管理员 |
| POST | `/admin/users/:userId/reset-password` | 生成临时密码（只返回一次），并吊销该用户全部会话 |

**不变量**

- 管理员**不能停用或降级自己** → `40300`
- **最后一个可用的站点管理员**不能被降级或停用 → `40300`
- 停用账号会立刻吊销其所有会话，已登录设备下一次请求就失效
- 重置密码不影响操作者自己（改自己的密码走 `/auth/password/change`）

> 临时密码是"线下转交"方案 —— 邮件体系还没接，不能发重置邮件。

### 15.2 工作区恢复

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workspaces/deleted` | 我作为 OWNER 的、已软删除的工作区（带剩余可恢复天数） |
| POST | `/workspaces/:id/restore` | 恢复（仅 OWNER，且必须在 30 天内） |

超过 30 天的由定时任务**物理删除**，连同其中的笔记、任务、看板、附件（磁盘文件也会删）。

### 15.3 幂等键

```
POST /workspaces/:id/notes
Idempotency-Key: <8~128 字符>
```

- 同一用户 + 同一 key + 同一端点，重放时**直接返回第一次的响应**，并带 `Idempotency-Replayed: true`
- 正在处理中（已有记录但没响应）→ `40000`，提示稍后重试
- **失败响应不缓存**（4xx/5xx 会删除记录），客户端可以放心重试
- 24 小时过期，由定时任务清理
- 已应用于：创建笔记、创建任务、发表评论

---

## 16. 前端路由与 API 的对应

| 前端路由 | 页面 | 需要的接口 |
|---|---|---|
| `/setup` | 首次启动引导（创建管理员） | `GET /site/status`、`POST /auth/register` |
| `/login` | 登录 | `POST /auth/login` |
| `/register` | 注册（仅 `registration.enabled` 时可达） | `POST /auth/register` |
| `/invite/:token` | 接受邀请（未登录先引导注册/登录，登录后 `accept`） | `GET /invitations/:token`、`POST /invitations/:token/accept` |
| `/` | 工作台外壳（侧栏 = 工作区切换器 + 导航） | `GET /auth/me` |
| `/settings/profile` | 个人资料 | `PATCH /auth/me` |
| `/settings/security` | 改密码 + 设备管理 | `POST /auth/password/change`、`GET/DELETE /me/sessions` |
| `/w/:id/settings` | 工作区设置 | `PATCH /workspaces/:id` |
| `/w/:id/members` | 成员与邀请（实际路由，非 `/settings/members`） | 成员 / 邀请全部接口 |
| `/w/:id/notes` | **笔记工作台**（三栏：笔记本树 / 笔记列表 / 编辑器） | 笔记本、标签、笔记全部接口 |
| `/w/:id/tasks` | **待办**（侧栏视图 / 任务列表 / 详情抽屉，支持 `?task=<id>` 直达） | 任务、子任务、评论全部接口 |
| `/w/:id/boards` | **看板列表** | 看板列表与创建 |
| `/w/:id/boards/:boardId` | **看板视图**（横向列 + 卡片拖拽） | 看板详情、拖动、列管理 |
| `/admin` | **站点管理**（仅站点管理员）：概览 + 用户管理 | `/admin/*` |
| `/share/:token` | **公开分享页**（只读渲染，无需登录） | `GET /share/:token` |
| `/admin` | 站点管理后台 | ⏳ **未实现**（M1 未做，需另排） |

---

## 17. 已确认

- ✅ 前端路由使用工作区 **`id`**（`/w/:id/...`），`slug` 不参与路由
- ✅ **MEMBER 不能邀请成员**，仅 `OWNER` / `ADMIN`
- ✅ 一条笔记可属于多个笔记本；删除笔记本只解关联
- ✅ 回收站保留 30 天
- ✅ 保存笔记必须带 `version`，冲突返回 409 + 服务端最新内容
- ✅ M2 不做图片上传
- ✅ **任务不设 Project 层**，分组靠 状态 + 标签 + 截止时间
- ✅ **任务与笔记共用同一套标签**
- ✅ 子任务勾选不走乐观锁；整体覆盖子任务列表时才校验 `version`
- ✅ 评论用多态目标（`targetType` + `targetId`），M3 只用于任务
- ✅ `@提及` 只高亮不推通知（通知中心是 M5）
- ✅ **看板卡片就是任务**，拖进某列 = 改 `columnId` + 同步 `status`
- ✅ 拖拽**不走乐观锁**（后写生效），子任务勾选同理
- ✅ WIP 上限只拦跨列移入，列内重排不拦
- ✅ 删列 / 删板**不删任务**，只让它们脱离看板
- ✅ **附件用能力链接**（URL 带随机 token），不需要登录态 —— 否则 Markdown 的 `<img>` 无法鉴权
- ✅ 附件**拒绝 SVG**，其它非图片类型强制 `Content-Disposition: attachment`
- ✅ 通知收件人 = **@提及 ∪ 关注者**；创建者/负责人靠"自动关注"而不是特殊照顾
- ✅ 通知只做站内信，不做邮件/Push；前端 30 秒轮询未读数
- ✅ 增量同步以 `seq` 游标推进，`BigInt` 序列化为字符串
- ✅ 实时推送走 WebSocket，广播**排除触发者自己**
- ✅ 分享链接返回 `path`（页面路径），读内容走 API 前缀
- ✅ `PRIVATE` 笔记也可分享 —— 分享与"工作区可见性"是两件事

## 18. 待确认 / 待实现

- [ ] 首个用户成为站点管理员后，后续注册用户是否需要「站点管理员审批才能激活」
- [ ] 站点管理后台 `/admin`（用户列表 / 禁用 / 配额）
- [ ] `Idempotency-Key` 目前只有约定，**尚未在服务端实现**（§1.5）
- [ ] 标签合并、笔记版本历史（见 `DATABASE.md` §10）
- [ ] 任务的重复规则（RRULE）与提醒
- [ ] 任务的日历视图
- [ ] 评论的 @提及通知（依赖 M5 通知中心）
