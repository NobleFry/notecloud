# 生产部署

> 目标读者：拿到仓库、在一台 Linux 服务器上部署 NoteCloud 的人。
> 全流程只需 Docker，不需要装 Node / MySQL。
> 仓库地址：<https://github.com/NobleFry/notecloud>

---

## 0. 前置要求

| 项 | 要求 |
|---|---|
| Docker | 24+，带 compose 插件（`docker compose version` 能跑） |
| 系统 | Debian / Ubuntu（含衍生版）、Arch / Manjaro；其它发行版需手动装 Docker |
| 内存 | 2 GB 起（MySQL 512MB buffer pool + API + Nginx） |
| 磁盘 | 20 GB 起（数据库 + 附件，按团队规模加） |
| 域名 | 可选；有域名才能上 HTTPS |

**自动安装依赖**：

```bash
bash deploy/scripts/install-deps.sh          # Debian/Ubuntu/Arch，需要 sudo
bash deploy/scripts/install-deps.sh --check   # 只检查
```

它用**官方 apt 仓库**装 Docker（不是 `curl get.docker.com | sh`，那样等于把 root
交给远程脚本）。装完会把你加入 docker 组，需要 `newgrp docker` 或重新登录才生效。

`install.sh` 也支持一步到位：

```bash
bash deploy/scripts/install.sh --install-deps
```

> **不支持 MariaDB/MariaDB 托管服务**：项目依赖 MySQL 8 的 `ngram` 全文解析器。
> 用 `docker compose` 自带的 `mysql:8.4` 镜像最省事。

---

## 1. 准备配置

### 一键（推荐）

```bash
bash deploy/scripts/install.sh
```

它会：检查 Docker → 生成带随机密钥的 `.env` → 构建 → 启动 → 等健康 → 打印访问地址。

常用参数：

| 参数 | 作用 |
|---|---|
| `--domain note.example.com` | 有域名时用，`PUBLIC_URL` 自动设为 https |
| `--port 8081` | 换对外端口（默认 8080） |
| `--with-backup` | 顺便装每日 3:30 的备份 cron |
| `--no-build` | 复用已有镜像，只重启 |

### 手动

如果想自己控制每一行配置：

```ini
# 站点名
SITE_NAME=NoteCloud

# 浏览器访问的地址（有域名就填域名，决定分享链接与 CORS）
PUBLIC_URL=https://note.example.com
HTTP_PORT=8080

# 数据库密码：⚠️ 只使用字母和数字
# 因为要拼进 DATABASE_URL，含 @ : / 会破坏连接串
MYSQL_PASSWORD=<随机字母数字>
MYSQL_ROOT_PASSWORD=<随机字母数字>

# 必须换成随机值：openssl rand -base64 48
JWT_SECRET=<48 字节随机串>
```

其余项（注册开关、附件上限、SMTP）按需调整。生成随机密码：

```bash
openssl rand -base64 24 | tr -d '/+=' | cut -c1-24
```

---

## 2. 启动

```bash
docker compose --env-file .env -f deploy/compose/docker-compose.prod.yml up -d --build
```

第一次会拉镜像 + 构建，约 3~6 分钟。完成后：

```bash
docker compose --env-file .env -f deploy/compose/docker-compose.prod.yml ps
```

三个服务都应该是 `running`，`api` 额外显示 `healthy`。

浏览器打开 `http://<服务器IP>:8080`，会跳转 `/setup` 创建第一个管理员账号。

> **迁移是自动的**：API 容器的入口脚本会先跑 `prisma migrate deploy` +
> 全文索引自愈，再启动服务。迁移失败容器会直接退出，不会带病运行。

---

## 3. 上 HTTPS（有域名时）

仓库里有现成的模板：`deploy/nginx/https.conf.example`。

```bash
# 1) 申请证书（宿主机上，需要 80 端口短暂占用）
sudo certbot certonly --standalone -d note.example.com

# 2) 复制证书到项目内
mkdir -p deploy/certs
sudo cp /etc/letsencrypt/live/note.example.com/fullchain.pem deploy/certs/
sudo cp /etc/letsencrypt/live/note.example.com/privkey.pem  deploy/certs/

# 3) 换掉 nginx 模板
cp deploy/nginx/https.conf.example deploy/nginx/default.conf.template

# 4) compose 里给 web 加 443 与证书挂载
#    ports: ["80:80", "443:443"]
#    volumes: ["../certs:/etc/nginx/certs:ro"]

# 5) 重建 web
docker compose --env-file .env -f deploy/compose/docker-compose.prod.yml up -d --build web
```

然后把 `.env` 的 `PUBLIC_URL` 改成 `https://note.example.com` 并重启 api，
否则分享链接还是 `http://`。

---

## 4. 备份

```bash
bash deploy/scripts/backup.sh
```

产出 `backups/notecloud-YYYYmmdd-HHMMSS.tar.gz`，里面是：

```
db.sql            完整 mysqldump
uploads.tar.gz    所有附件
```

> ⚠️ **只 dump 数据库不够**。附件在独立 volume 里，漏了会让所有图片变死链。
> 脚本已经把两者打在一起，别自己手写一份只 dump 库的。

定时备份（每天 3:30，保留 14 份）：

```cron
30 3 * * * cd /opt/notecloud && BACKUP_DIR=/var/backups/notecloud KEEP=14 bash deploy/scripts/backup.sh >> /var/log/notecloud-backup.log 2>&1
```

**异地备份**：把 `BACKUP_DIR` 指到挂载的 NAS，或备份完再 rsync 走。

### 恢复

```bash
bash deploy/scripts/restore.sh backups/notecloud-20261019-120000.tar.gz
```

会先停 API，覆盖数据库与附件，再启动。脚本会要求输入 `yes` 二次确认。

---

## 5. 升级与回滚

```bash
bash deploy/scripts/upgrade.sh            # 备份 → 重建 → 重启 → 健康检查
bash deploy/scripts/upgrade.sh --pull     # 先 git pull
```

升级脚本的顺序是刻意的：**先备份**，再构建，再重启。任何一步失败都会退出，
并且告诉你回滚命令。

### 回滚

```bash
# 1) 回到上一个版本的代码
git log --oneline -5
git checkout <上一个 commit 或 tag>

# 2) 恢复数据（如果这次升级已经跑过迁移）
bash deploy/scripts/restore.sh backups/<升级前那份>.tar.gz

# 3) 用旧代码重建
docker compose --env-file .env -f deploy/compose/docker-compose.prod.yml up -d --build
```

> 数据库迁移**只向前不向后**。所以回滚 = 旧代码 + 旧数据，两者一起回。

---

## 6. 数据在哪

| 内容 | 位置 |
|---|---|
| 数据库 | Docker volume `notecloud-prod-mysql-data` |
| 附件 | Docker volume `notecloud-prod-uploads`（容器内 `/data/uploads`） |
| 配置 | 仓库根 `.env` |

Docker volume 默认在 `/var/lib/docker/volumes/`。**不要**手工删这两个卷。

想确认附件占了多少：

```bash
docker run --rm -v notecloud-prod-uploads:/data alpine du -sh /data/uploads
```

---

## 7. 故障排查

| 现象 | 处理 |
|---|---|
| `api` 一直 unhealthy | `docker compose ... logs -f api`；多半是 `DATABASE_URL`/`JWT_SECRET` 没配 |
| 页面打开是 502 | api 还没起完；`docker compose ... ps` 看状态 |
| 上传大文件失败 | `.env` 的 `MAX_UPLOAD_MB` 与 nginx 的 `client_max_body_size` 要同时调 |
| 实时推送不工作 | 反代必须透传 `Upgrade` / `Connection` 头（模板里已配） |
| 中文搜索搜不到 | 索引被 Prisma 删了；容器启动会自动重建，也可手动 `docker compose exec api node dist/ensure-indexes.js` |
| 忘记管理员密码 | 只能是另一个管理员在 `/admin` 重置；没有第二个管理员时见下 |

**所有管理员都进不去时**（没有 SMTP，无法自助找回）：

```bash
bash deploy/scripts/reset-password.sh you@example.com
```

它会用容器内的 argon2 算出哈希、直接改库、并吊销该账号所有会话，最后把新密码打印出来。
也可以自己指定密码：`bash deploy/scripts/reset-password.sh you@example.com 'MyNewPass123'`。

> 登录后立刻在「安全设置」里改掉。

---

## 8. 资源占用参考

| 团队规模 | 建议配置 | 说明 |
|---|---|---|
| 1~5 人 | 1 核 2 GB | 够用，MySQL buffer pool 512MB |
| 5~20 人 | 2 核 4 GB | 推荐 |
| 附件多 | 加磁盘，不改内存 | 附件在 volume 里 |

### 只有 1 GB 内存时

可以跑，但要按下面处理，否则前端构建和运行时都可能 OOM：

```bash
# 1. 补 2GB swap（install.sh 在 root 下会自动做，--no-swap 可关闭）
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 2. 降低 MySQL 内存占用
echo 'MYSQL_BUFFER_POOL=256M' >> .env
```

`install.sh` 检测到内存 < 1.8GB 时会自动补 swap、把 buffer pool 写进 `.env`，并在构建时加
`--build-arg TYPECHECK=0` 跳过 `vue-tsc`（峰值约 600MB）。类型检查由 CI 负责，`vite build` 本身不到 512MB。

手动构建时也可以显式指定：

```bash
docker compose --env-file .env -f deploy/compose/docker-compose.prod.yml build --build-arg TYPECHECK=0
```

---

## 9. 已知限制

- **单实例**：WebSocket 连接表与定时任务都在进程内。要多副本需要 Redis pub/sub（未做）。
- **不做实时协同编辑**：多人同时编辑同一篇笔记会走乐观锁冲突提示。
- **没有内置 SMTP**：邀请只能复制链接；找回密码需要管理员重置。
- **备份脚本要求服务在运行**（它用 `docker compose exec` 读数据库）。
- **镜像约 550MB**：运行时包含 Prisma CLI 与引擎（迁移需要）。可以拆成独立迁移镜像来瘦身。

---

## 10. 部署相关的踩坑记录

这些是实际构建/运行中遇到并修掉的问题，改部署相关文件时注意别退回去。

| 坑 | 症状 | 正确做法 |
|---|---|---|
| **ENTRYPOINT 吞掉 `docker compose run` 的命令** | `docker compose run api tar ...` 变成跑 API 服务器，永不退出（备份脚本卡死） | 入口脚本先判断 `$#`，有参数就 `exec "$@"` |
| **不能 `rm -rf` volume 挂载点** | `rm: cannot remove '/data/uploads': Device or resource busy` | 清空内容：`find /data/uploads -mindepth 1 -delete` |
| **tsup 多入口保留目录结构** | 输出成 `dist/src/index.js`，容器里 `node dist/index.js` 找不到 | 用命名入口 `{ index, 'ensure-indexes' }` |
| **`prisma generate` 在镜像里缺变量** | `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL` | 构建阶段设一个假的 `DATABASE_URL`（generate 不连库） |
| **Prisma 引擎缺 openssl** | `Prisma failed to detect the libssl/openssl version` | 镜像里 `apt-get install openssl` |
| **安全响应头重复** | 响应里两个 `X-Content-Type-Options`，前端/测试拿到 `nosniff, nosniff` | 反代里 `proxy_hide_header` 掉上游同名头 |
| **`--frozen-lockfile` 失败** | 改了 package.json 但没更新 lockfile | 先在仓库根跑 `pnpm install` 再构建 |
| **备份只 dump 数据库** | 恢复后所有图片变死链 | 备份脚本已把 `uploads` 一起打包 |
| **1GB 内存构建前端 OOM** | `FATAL ERROR: Reached heap limit`，`vue-tsc` 在 ~478MB 崩溃 | 补 2GB swap + 构建加 `--build-arg TYPECHECK=0`（`install.sh` 会自动处理） |
