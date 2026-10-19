# 开发环境（隔离）

## 为什么要隔离

这台机器的现状：

| 事实 | 影响 |
|---|---|
| 系统里跑着 **MariaDB 13.0.2**，占用 3306 | 不能用 3306，也不能依赖它的行为 |
| MariaDB **没有 `ngram` 全文解析器** | 中文分词行为与生产 MySQL 8 完全不同 |
| 没有 Docker / Podman，`sudo` 需要密码 | 需要你本人执行安装命令 |

项目锁定 **MySQL 8.4 LTS**（`utf8mb4_0900_ai_ci` + `ngram` 分词），所以开发数据库必须是一个**独立实例**，绝不碰系统 MariaDB。

## 环境拓扑

```
                    ┌─────────────────────────────────────────┐
   宿主 MariaDB ──►  │ 3306  系统服务 mariadb（本项目不碰）      │
                    └─────────────────────────────────────────┘

   ┌─ Docker 网络: notecloud-dev ────────────────────────────────┐
   │  mysql:8.4  ──►  127.0.0.1:3307   ← 开发主库                  │
   │  adminer    ──►  127.0.0.1:8080   (profile: tools)          │
   │  mailpit    ──►  127.0.0.1:8025 / SMTP 1025 (profile: mail) │
   └─────────────────────────────────────────────────────────────┘
```

## 端口分配

| 端口 | 用途 |
|---|---|
| 3306 | 系统 MariaDB（**不要动**） |
| **3307** | 开发 MySQL 8.4（Docker） |
| 3000 | Fastify API |
| 5173 | Vite 前端 dev server |
| 8080 | Adminer（可选） |
| 8025 / 1025 | Mailpit Web UI / SMTP（可选） |

---

## 从零到跑起来（完整顺序）

```bash
# 1. 安装依赖
#    注意：pnpm 10+ 默认拦截依赖的构建脚本，仓库已在 pnpm-workspace.yaml 里
#    用 allowBuilds 放行了 esbuild / prisma / @prisma/engines，无需交互式 approve-builds
pnpm install

# 2. 检查 .env（已生成，含随机密码与 JWT 密钥）
#    当前阶段 SMTP_* 留空即可（见 .env 里的"邮件 —— 待办"）

# 3. 启动隔离的开发数据库（MySQL 8.4，端口 3307）
pnpm dev:db
pnpm dev:db:check     # 确认版本 / utf8mb4 / ngram_token_size=2

# 4. 生成 Prisma 客户端并建表
#    必须走 db:deploy —— 它会额外跑 ensure-indexes 重建 ngram 全文索引。
#    （Prisma 会把手工加的 FULLTEXT 索引当成 drift 删掉，详见 docs/DATABASE.md §8）
pnpm db:generate
pnpm db:deploy

# 5. 写入站点默认配置
pnpm db:seed

# 6. 启动前后端
pnpm dev              # API :3000  +  Web :5173

# 7. 浏览器打开 http://localhost:5173
#    首次会自动跳转 /setup —— 第一个注册的账号成为站点管理员
```

> **开发期改 schema 注意**：`prisma migrate dev` 会因为"手工加的 ngram 全文索引"被判为 drift，
> 从而**要求 reset 数据库**（会清空数据）。不要同意。用脚本生成迁移：
>
> ```bash
> bash deploy/scripts/new-migration.sh add_attachments   # 生成迁移文件
> pnpm db:deploy                                          # 应用（含索引自愈）
> ```
>
> 脚本内部用 `migrate diff` 生成 SQL 并剔除 `DROP INDEX ..._ft_...`。
> ⚠️ 不要直接跑 `prisma migrate deploy`，会漏掉索引自愈那一步。

## 第一步：安装 Docker（需要你自己执行）

我没有无密码 `sudo`，装不了系统包。请在终端里执行：

```bash
sudo pacman -S --needed docker docker-compose docker-buildx
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

**关键**：`usermod` 只对**新登录的会话**生效。装完后二选一：

- 在当前终端执行 `newgrp docker`（临时生效，够用）
- 或者注销重新登录

验证：

```bash
docker run --rm hello-world     # 能跑通就 OK
docker compose version
```

> 如果提示 `docker: 'compose' is not a docker command`，说明 compose 插件没装上：
> `sudo pacman -S --needed docker-compose`
>
> **镜像拉取慢/失败**（本机有 clash-verge 在 `127.0.0.1:7897`），给 Docker 守护进程配代理：
> ```bash
> sudo mkdir -p /etc/systemd/system/docker.service.d
> sudo tee /etc/systemd/system/docker.service.d/proxy.conf >/dev/null <<'EOF'
> [Service]
> Environment="HTTP_PROXY=http://127.0.0.1:7897"
> Environment="HTTPS_PROXY=http://127.0.0.1:7897"
> EOF
> sudo systemctl daemon-reload && sudo systemctl restart docker
> ```

---

## 第二步：配置 .env

```bash
cd /home/admin/Projects/NoteCloud
cp .env.example .env
```

我已经生成了一个带**随机密码和 JWT 密钥**的 `.env`，直接可用。首次启动前至少确认这几项：

- `MYSQL_PASSWORD` / `MYSQL_ROOT_PASSWORD`
- `DATABASE_URL`（其中密码要和 `MYSQL_PASSWORD` 一致）
- `SMTP_*`：**真实 SMTP 凭据**（注册验证、邀请、找回密码都依赖它）
- `WEB_ORIGIN`：默认 `http://localhost:5173`

## 第三步：启动

```bash
pnpm dev:db            # 启动 MySQL 8.4 并等待 healthy
pnpm dev:db:check      # 自检版本 / 字符集 / ngram 分词器
pnpm dev:db:cli        # 进入 mysql 命令行
```

可选：

```bash
pnpm dev:tools         # + Adminer   http://127.0.0.1:8080
pnpm dev:mail          # + Mailpit   http://127.0.0.1:8025  (SMTP 127.0.0.1:1025)
```

---

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev:db` | 启动数据库（幂等） |
| `pnpm dev:db:down` | 停止，保留数据 |
| `pnpm dev:db:reset` | **删卷重建**（需要输入 yes） |
| `pnpm dev:db:logs` | 跟日志 |
| `pnpm dev:db:cli` | mysql 命令行 |
| `pnpm dev:db:check` | 版本/字符集/ngram 自检 |
| `pnpm dev:tools` / `pnpm dev:mail` | 按需启动辅助服务 |
| `pnpm db:generate` | 重新生成 Prisma 客户端（改 schema 后必跑） |
| `pnpm db:migrate` | 开发期生成并应用新迁移（**自动重建全文索引**） |
| `pnpm db:deploy` | 应用已有迁移（**自动重建全文索引**） |
| `pnpm db:ensure` | 只检查/重建 ngram 全文索引 |
| `pnpm db:seed` | 写入站点默认配置 |
| `bash deploy/scripts/new-migration.sh <name>` | 生成迁移文件（自动剔除 ngram 索引的 DROP） |
| `pnpm smoke` | 端到端冒烟测试（**指向测试库**，见下节） |

等价于直接调脚本：`bash deploy/scripts/devstack.sh <up|down|reset|ps|logs|mysql|check|wait|url>`

---

## 端到端冒烟测试

```bash
pnpm smoke:full     # 自动重建测试库 → 迁移 → 起临时实例 → 跑 → 清理
```

它会重建 `notecloud_test`、在该库上起一个 3100 端口的临时 API 实例，跑完自动关掉。
**完全不碰 `notecloud` 主库**，所以你自己的账号和数据是安全的。

只跑测试（实例已就绪时）：

```bash
BASE=http://127.0.0.1:3100/api/v1 pnpm smoke
```

覆盖 82 项断言：

| 范围 | 内容 |
|---|---|
| 账户 | 引导、注册、登录、Refresh 轮转、**重放检测整族吊销** |
| 工作区 | CRUD、成员、邀请、全部权限不变量（最后一个 OWNER 不能退出等） |
| 笔记 | 笔记本树、**拖拽重排 + 环路保护 + 深度重算**、多笔记本归属、**乐观锁 409 + 带回服务端内容**、**ngram 中文检索**、标签、回收站、**删笔记本不删笔记** |
| 待办 | 任务 CRUD、**乐观锁 409**、子任务勾选、状态流转与 `completedAt`、8 个视图过滤、**ngram 检索**、标签计数、回收站、**评论** |

> 定时清理任务不在 HTTP 冒烟范围内。手动验证：
> ```bash
> # 把一条笔记的 deletedAt 改成 40 天前，再调用维护函数，应该被物理删除
> ```

## 文件存储

附件写到 `UPLOAD_DIR`（`.env` 默认 `./data/uploads`）。**相对路径以仓库根为基准**，
不是进程 cwd —— 这样从 `apps/api` 或仓库根启动行为一致。`.gitignore` 已忽略 `data/`。

| 项 | 值 |
|---|---|
| 驱动 | `STORAGE_DRIVER=local`（目前唯一实现，S3/MinIO 接口已留好） |
| 单文件上限 | `MAX_UPLOAD_MB=50` |
| 目录结构 | `<workspaceId>/<yyyy>/<mm>/<uuid>.<ext>` |
| 访问 | 能力链接 `/api/v1/attachments/<id>/<token>` |

> ⚠️ **备份时必须连 `data/uploads` 一起打包**。只 dump 数据库会让所有图片变成死链。

## 前端常见陷阱

- **绝不要对 Vue 响应式对象直接 `structuredClone`** —— 它会抛 `DataCloneError`
  （Proxy 不可结构化克隆）。做快照/回滚时用 `structuredClone(toRaw(x))`。
  > 看板拖拽就因此静默失败过一次：异常从 `await` 里抛出去被吞掉，界面既不动也不报错。
- Promise 里的异常**不会**走 `app.config.errorHandler`。`main.ts` 里加了
  `unhandledrejection` 兜底日志，调试时看控制台。
- 模板里对**导入的常量**做下标访问（如 `TASK_STATUS_LABEL[s]`）会被 Vue 编译器
  当成 ref 处理而报类型错。把选项在 `script` 里算好再传给组件。
- **Vite 代理要开 `ws: true`**，否则 `/api/v1/ws` 连不上（开发环境实时推送全靠它）。

## 实时与同步

- WebSocket 连接表在**进程内存**，只支持单实例。多实例部署要换 Redis pub/sub。
- 广播会排除触发者自己，避免"自己刚拖完卡片又被自己事件刷一遍"。
- `sync_changes` 是**尽力而为**写入：写失败不影响主业务。
- PWA 的 Service Worker **只在生产构建注册**（开发环境会和 HMR 打架）。
  `/api/` 请求一律不缓存 —— 缓存接口会造成"看起来保存了其实没保存"。

## 幂等键怎么用

前端对"点两下会出两条记录"的写操作带上：

```ts
http.post(url, body, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
```

服务端行为（`plugins/idempotency.ts`）：

- 同 key 重放 → 直接返回第一次的响应，并带 `Idempotency-Replayed: true`
- 处理中重复到达 → `40000`
- **失败响应不缓存**，客户端可以放心重试

已应用于：创建笔记、创建任务、发表评论。新增写接口时把 `idempotencyGuard`
加进 `preHandler` 数组（**必须在鉴权之后**）即可。

## 数据库约定

| 项 | 值 |
|---|---|
| 版本 | MySQL 8.4 LTS（与生产一致） |
| 字符集 | `utf8mb4` |
| 排序规则 | `utf8mb4_0900_ai_ci` |
| 全文检索 | `FULLTEXT ... WITH PARSER ngram`，`ngram_token_size=2` |
| 时区 | 服务端 `+00:00`，**数据库只存 UTC**，展示时区由应用层负责 |
| 迁移 | Prisma Migrate（唯一入口，禁止手改表结构） |

> ⚠️ Prisma 不原生支持 `WITH PARSER ngram`。全文索引需要在迁移里手写原生 SQL
> （`prisma migrate dev --create-only` 生成后编辑），或用自定义迁移脚本维护。
> 这一点在 M2 做笔记检索时落地。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `permission denied ... docker.sock` | 当前 shell 没有 docker 组权限 → `newgrp docker` 或重新登录 |
| `Cannot connect to the Docker daemon` | `sudo systemctl start docker` |
| `docker: 'compose' is not a docker command` | `sudo pacman -S --needed docker-compose` |
| 拉镜像超时 | 按上面配 Docker 守护进程代理 |
| 3307 被占用 | 改 `.env` 的 `MYSQL_PORT`，同步改 `DATABASE_URL` |
| MySQL 起不来 | `pnpm dev:db:logs` 看日志；换数据卷重来用 `pnpm dev:db:reset` |
| 想连系统 MariaDB | **不要**。行为不一致，会埋 ngram / 排序规则的坑 |
