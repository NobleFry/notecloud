# NoteCloud

可自部署、前后端分离的协作工作台：**云同步笔记 + TodoList + 分类体系 + 看板 + 账户/工作区权限**。

面向 3~20 人小团队，数据完全掌握在自己手里。

**项目地址**：<https://github.com/NobleFry/notecloud>

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vue 3 + Vite + TypeScript + Pinia + Vue Router + Naive UI |
| 后端 | Node + Fastify + TypeScript + Prisma + Zod |
| 数据库 | MySQL 8.4 LTS（`utf8mb4_0900_ai_ci`，全文检索用 `ngram`） |
| 鉴权 | JWT Access + Refresh（httpOnly cookie）+ argon2 |
| 部署 | Docker Compose（nginx + api + mysql） |

## 目录结构

```
NoteCloud/
├─ apps/
│  ├─ web/                 # Vue 3 前端
│  └─ api/                 # Fastify 后端
├─ packages/
│  ├─ shared/              # 共享类型 / 常量 / Zod schema
│  └─ config/              # eslint / prettier / tsconfig
├─ deploy/
│  ├─ compose/             # docker-compose（dev / prod）
│  └─ scripts/             # 开发环境与运维脚本
├─ docs/
│  ├─ FEATURES.md          # 功能列表与里程碑
│  └─ DEV.md               # 开发环境搭建
└─ .env.example
```

## 快速开始

```bash
git clone https://github.com/NobleFry/notecloud.git
cd notecloud

cp .env.example .env     # 填好数据库密码（已生成过一份可直接用的 .env）
pnpm install
pnpm dev:db              # 启动隔离的开发数据库（需先装 Docker，见 docs/DEV.md）
pnpm db:generate
pnpm db:deploy           # 应用迁移 + 自动重建全文索引
pnpm dev                 # API :3000 + Web :5173
```

打开 http://localhost:5173 ，首次会引导你创建站点管理员账号。

### 生产部署

#### 1. 系统依赖（只在缺 Docker 时需要）

```bash
bash deploy/scripts/install-deps.sh          # 需要 sudo
bash deploy/scripts/install-deps.sh --check  # 只检查，不改系统
```

支持 **Debian / Ubuntu**（含 Mint、Pop 等衍生版）与 **Arch / Manjaro**，自动安装：

| 包 | 用途 |
|---|---|
| `docker-ce` / `docker` | 容器运行时 |
| `docker-compose-plugin` / `docker-compose` | `docker compose` 命令 |
| `openssl` | 生成随机密钥 |
| `curl` | 镜像健康检查 |

<details>
<summary>不想用脚本？手动命令（Ubuntu / Debian 12+）</summary>

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg openssl
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
                        docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
newgrp docker        # 或注销重新登录
```

Debian 把上面两处 `ubuntu` 换成 `debian`。Arch：

```bash
sudo pacman -S --needed docker docker-compose docker-buildx openssl
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
newgrp docker
```

</details>

#### 2. 部署

```bash
bash deploy/scripts/install.sh
```

脚本会自动生成带随机密钥的 `.env`、构建、启动、等健康，并打印访问地址。

```bash
bash deploy/scripts/install.sh --domain note.example.com --with-backup   # 有域名 + 每日备份
bash deploy/scripts/install.sh --install-deps                            # 连 Docker 一起装
bash deploy/scripts/install.sh --port 8081                               # 换端口
```

首次打开会跳 `/setup` 创建站点管理员。

完整说明（HTTPS、备份策略、升级与回滚、故障排查）见
**[docs/DEPLOY.md](docs/DEPLOY.md)**。

开发环境搭建见 **[docs/DEV.md](docs/DEV.md)**，
功能范围与里程碑见 **[docs/FEATURES.md](docs/FEATURES.md)**，
数据库设计见 **[docs/DATABASE.md](docs/DATABASE.md)**，
接口清单见 **[docs/API.md](docs/API.md)**，
未完成事项见 **[docs/BACKLOG.md](docs/BACKLOG.md)**。

## 当前进度

**M0–M5 全部完成，且补齐 M1 遗留（站点管理、工作区恢复、幂等键），均通过类型检查、生产构建与端到端冒烟测试（174 项断言）。**

| 模块 | 状态 |
|---|---|
| monorepo（pnpm workspaces）+ TypeScript + 构建链路 | ✅ |
| Docker 隔离开发环境（MySQL 8.4 / Adminer / Mailpit） | ✅ |
| 账户：注册、登录、登出、Refresh 轮转 + 重放检测 | ✅ |
| 安全：argon2id、HttpOnly cookie、设备会话管理、改密吊销其它会话 | ✅ |
| 工作区：CRUD、软删除、转让所有权、退出 | ✅ |
| 成员与角色：OWNER/ADMIN/MEMBER/GUEST，含全部不变量校验 | ✅ |
| 邀请制注册：通用链接 / 指定邮箱、限次限时、幂等接受 | ✅ |
| 笔记本：树形层级、**拖拽移动与排序**、环路检测、删除只解关联 | ✅ |
| 标签：工作区级、多对多、**笔记与任务共用** | ✅ |
| 笔记：Markdown、多笔记本归属、自动保存、**乐观锁冲突提示** | ✅ |
| **中文全文检索**（MySQL 8 ngram，笔记 + 任务） | ✅ |
| 回收站：软删除 + 30 天保留 + 恢复 / 彻底删除 + **定时清理** | ✅ |
| 编辑器：CodeMirror 6 自封装（工具栏 / 分栏预览 / 滚动同步 / 代码高亮） | ✅ |
| **待办**：四态状态、五级优先级、截止时间、负责人、子任务、8 个智能视图 | ✅ |
| **任务评论 + @提及**（高亮，不推通知） | ✅ |
| **看板**：看板/列/卡片、拖拽跨列（卡片即任务）、WIP 上限、列映射状态 | ✅ |
| **附件**：上传、粘贴/拖拽插图、能力链接访问、孤儿清理 | ✅ |
| **通知**：站内通知中心、@提及投递、关注者、任务提醒 | ✅ |
| **实时**：WebSocket 推送（看板移动、笔记变更、通知） | ✅ |
| **增量同步**：`sync_changes` 变更日志 + 游标接口 | ✅ |
| **分享链接**：笔记只读公开分享（能力链接、可撤销/过期） | ✅ |
| **智能视图**：保存的过滤器（笔记列表） | ✅ |
| **PWA**：manifest + Service Worker 离线壳 | ✅ |
| **站点管理**：全局概览、用户停用/启用、重置密码、设管理员 | ✅ |
| **工作区恢复**：删除后 30 天内可恢复，到期物理删除 | ✅ |
| **幂等键**：`Idempotency-Key` 防重复提交 | ✅ |
| **生产部署**：多阶段镜像 + nginx 反代 + compose + 备份/恢复/升级脚本 | ✅ |
| 审计日志 | ✅ |
| 离线数据同步、邮件/Push 通知、看板级权限 | ⏳ 待做 |

## 设计取向

- **服务端是唯一权威数据源**，多端通过增量同步 + 乐观锁（`version`）保持一致，冲突显式提示而非静默覆盖
- **看板卡片即任务**，看板的列就是任务状态，TodoList 与看板天然不分叉
- **工作区（Workspace）是顶层容器**，笔记/标签/看板/任务都挂在它下面，个人空间与团队空间相互隔离
- **自部署体验是一等公民**：一条 `docker compose up` 起来，一条命令备份，升级路径向后兼容
