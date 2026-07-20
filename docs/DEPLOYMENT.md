# 生产部署与备份

## 推荐拓扑

微信小程序和客户 H5 必须访问公网 HTTPS 后端。推荐单台 Linux 主机运行 Caddy、一个 Node API 写实例和一个持久化 SQLite 卷：

```text
微信小程序（商家） / 客户 H5
             │ HTTPS
           Caddy
             │ 127.0.0.1:3100
       Node.js 24 + SQLite WAL
```

SQLite 模式只允许一个 API 写实例。不要在多个容器间共享同一 SQLite 文件；需要多实例时先迁移 PostgreSQL。

Windows 便携版是独立本地工具，不接入此线上数据库；生产 `server` 模式也不开放浏览器本地免登录入口。线上商家管理统一从微信小程序进入。

## 腾讯云轻量服务器初始化

首发建议使用中国大陆地域的 Ubuntu 24.04 LTS 轻量应用服务器。服务器重装并绑定专用 SSH 密钥后，把初始化脚本上传到主机并以 root 权限执行：

```bash
sudo bash scripts/bootstrap-production-host.sh
```

脚本可以重复执行，负责：

- 使用腾讯云 Docker CE 镜像安装 Docker、Buildx 和 Compose。
- 开启 UFW，仅允许 SSH、HTTP 和 HTTPS 入站。
- 禁止 root、密码和键盘交互式 SSH 登录，只保留公钥认证。
- 启用 Fail2ban、无人值守安全更新，并创建 `/opt/diangao` 生产目录。
- 将主机名和时区设置为 `diangao-prod`、`Asia/Shanghai`。

腾讯云控制台防火墙同样只保留 22、80、443 和按需的 ICMP；不要提交实例 ID、公网 IP、SSH 私钥、CAM 密钥或生产 `.env`。2GB 内存实例应保留约 2GB swap，并只运行一个应用写实例。

## 必需环境变量

| 名称                  | 说明                                                   |
| --------------------- | ------------------------------------------------------ |
| `NODE_ENV=production` | 启用生产失败关闭策略                                   |
| `DIANGAO_MODE=server` | 禁止本地免登录入口                                     |
| `APP_SECRET`          | 至少 32 字节随机值；用于认证签名和字段加密，需安全备份 |
| `PUBLIC_BASE_URL`     | 客户访问的 HTTPS 地址                                  |
| `WECHAT_APP_ID`       | 微信小程序 AppID                                       |
| `WECHAT_APP_SECRET`   | 只放部署平台 Secret，不写仓库和聊天                    |
| `DB_PATH`             | SQLite 持久路径                                        |
| `PDF_FONT_PATH`       | 随项目提供的 Noto Sans CJK SC OTF                      |

可以用 PowerShell 生成密钥：

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

## Docker Compose

在主机创建不提交 Git 的 `.env`：

```dotenv
DIANGAO_DOMAIN=quote.example.com
PUBLIC_BASE_URL=https://quote.example.com
APP_SECRET=...
WECHAT_APP_ID=...
WECHAT_APP_SECRET=...
BACKUP_SECRET=... # 与 APP_SECRET 不同，至少 16 字节
```

执行：

```bash
docker compose up -d --build
curl https://quote.example.com/api/health
```

域名必须完成适用地区的备案和 DNS 配置。微信后台需要把同一 HTTPS 主机加入 request、downloadFile 合法域名。

## 备份

运行镜像已经包含备份与恢复脚本，`/backups` 是独立持久卷。每天由任务计划或 cron 执行一次：

```bash
docker compose exec diangao node scripts/backup.mjs
docker compose exec diangao ls -lh /backups
```

脚本使用 SQLite 在线备份 API，随后 AES-256-GCM 加密并生成 SHA-256 文件。默认保留 30 天，可用 `BACKUP_RETENTION_DAYS` 调整。备份密钥不要与数据库放在同一磁盘。

要把备份复制到宿主机或异地存储：

```bash
docker compose cp diangao:/backups/diangao-xxx.db.enc ./secure-backups/
docker compose cp diangao:/backups/diangao-xxx.db.enc.sha256 ./secure-backups/
```

恢复前停止 API，先在隔离机器演练：

```bash
docker compose stop diangao
docker compose run --rm diangao node scripts/restore.mjs /backups/diangao-xxx.db.enc --confirm
docker compose up -d diangao
```

恢复脚本会先解密到权限受限的同目录临时文件并执行 `PRAGMA quick_check`，再通过原子重命名替换数据库；旧库仅作为事务性回滚临时文件存在，成功后立即安全删除。数据库自动升级生成的 `*.migration-*.bak.enc` 使用当时的 `APP_SECRET` 加密，也可由同一恢复脚本处理。目标为每日备份（RPO 不超过 24 小时）和 4 小时内完成恢复。

`APP_SECRET` 与数据库、迁移备份和公开链接是一组不可分割的密钥材料。不要直接轮换或丢失；变更前必须执行专用重加密迁移。Windows 本地版使用系统安全存储（Windows DPAPI）保护密钥，数据应在同一 Windows 用户/机器下使用；跨机迁移前先导出业务数据与 PDF。

## 运维检查

- 仅开放 80/443，3100 只监听回环或容器内部网络。
- 数据卷、备份目录和 Secret 只允许服务账号读取。
- 每月实际恢复一份备份，不把“生成了文件”等同于可恢复。
- 监控 `/api/health`、磁盘空间、SQLite WAL 大小、5xx 和 PDF 生成耗时。
- 更新前先备份；单写实例滚动重启，不并行启动两个 SQLite 写进程。
