# 店告项目新机接手说明

> 更新时间：2026-07-16  
> GitHub：`git@github.com:conhoankhong98175-lab/wx2B.git`  
> 当前目标：在真实小程序账号、生产域名和微信开发者工具就绪后完成预览、提审与发布

## 1. 已完成状态

- Windows 本地报价工具、Web 客户页、Node API、SQLite、PDF、备份恢复和原生微信小程序均已完成。
- 小程序具备价格库、报价草稿、服务端权威计算、版本冻结、客户接受/提问/修改、PDF、分页长图、数据导出和账号删除。
- 无套餐、支付、订阅、广告、平台水印或商业化限制。
- 小程序显式启用微信隐私接口检查，设置页可打开官方隐私保护指引。
- 已生成微信上架操作手册、提审文案、隐私用途模板、配置脚本、发布预检和开发者工具 CLI 包装脚本。
- 最近一次质量门禁：12 个测试文件、45 项测试通过；完整及生产依赖 `npm audit` 均为 0 漏洞。
- 最新源码提交基线：`24e58dc feat: add WeChat launch tooling and runbook`。以 GitHub 实际最新提交为准。

## 2. 当前未完成且必须由运营者/新机继续的事项

1. 提供真实小程序 AppID。
2. 确认主体类型、主体全称和小程序备案状态。
3. 提供已完成 ICP 备案的生产 HTTPS 域名，并部署线上 API。
4. 填写隐私联系邮箱、数据保存期限和服务器所在国家/地区。
5. 安装微信开发者工具并由管理员扫码登录。
6. 在公众平台配置服务类目、服务器域名和用户隐私保护指引。
7. 完成 iOS/Android 真机验收、上传、体验版、提交审核和管理员手动发布。

不要通过 GitHub、聊天或 handoff 传递：AppSecret、代码上传密钥、身份证照片、营业执照原图、短信验证码、服务器私钥或数据库文件。

## 3. 新机准备

安装：

- Git。
- Node.js 24.x 与 npm 11.x。
- 微信开发者工具稳定版：[官方下载](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)。
- Docker Desktop（仅在新机需要本地验证 Compose 时安装）。

若使用 SSH Deploy Key 克隆，新机必须安全取得与 GitHub 仓库 Deploy Key 对应的私钥。仓库中只有公钥授权，私钥不会随 Git 克隆。

建议在 `~/.ssh/config` 配置专用 Host，避免覆盖个人 GitHub 密钥：

```sshconfig
Host github-wx2b
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_wx2b
  IdentitiesOnly yes
```

然后克隆：

```powershell
git clone git@github-wx2b:conhoankhong98175-lab/wx2B.git
Set-Location wx2B
npm run handoff:check
```

也可以使用拥有仓库权限的个人 GitHub SSH Key；不要复制当前机器的其他私人密钥。

## 4. 一键接手检查

```powershell
npm run handoff:check
```

脚本会执行：

- Node 24 版本检查。
- `npm ci` 锁文件安装。
- Prettier、TypeScript、ESLint、45 项自动测试和生产构建。
- 完整及生产依赖安全审计。
- 微信发布预检。

在仍使用 `touristappid` 和 `api.example.com` 时，微信预检应准确报告两个阻断，而不是通过。

## 5. 配置真实 AppID 与生产域名

AppID 可以写进本机私有配置，不是 AppSecret：

```powershell
npm run wechat:configure -- `
  --appid wx1234567890123456 `
  --api-base-url https://quote.example.com

npm run wechat:preflight -- --strict-online
```

配置结果：

- AppID 写入 Git 已忽略的 `miniprogram/project.private.config.json`。
- API 域名写入 `miniprogram/config.js`；域名本身不属于密钥，可提交一次正式配置提交。
- 在线报告写入 Git 已忽略的 `out/wechat-preflight.json`。

生产 API 环境变量参考 `.env.example` 和 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。特别注意：

- `WECHAT_APP_SECRET` 只进入服务器 Secret。
- `APP_SECRET` 至少 32 字节，丢失后无法解密已有业务数据。
- `BACKUP_SECRET` 与 `APP_SECRET` 分开保存。
- `DIANGAO_MODE=server`、`NODE_ENV=production`、`PUBLIC_BASE_URL=https://...`。

## 6. 微信公众平台人工配置

完整流程见 [docs/WECHAT_RELEASE.md](docs/WECHAT_RELEASE.md)，可复制材料见 [docs/WECHAT_SUBMISSION_COPY.md](docs/WECHAT_SUBMISSION_COPY.md)。关键选择：

- 主类目：`工具 → 报价/比价`。
- request 合法域名：生产 API HTTPS Origin。
- downloadFile 合法域名：同一 Origin。
- 隐私接口：必须声明“使用你的相册（仅写入）权限”。
- 审核账号：无需用户名密码，审核微信通过 `wx.login` 创建隔离测试商家空间。

备案要完成平台初审、12381 短信核验和通管局审核；管理员扫码、人脸和短信核验不能由代码代理。

## 7. 开发者工具登录、预览与上传

安装后，在开发者工具“设置 → 安全设置”开启服务端口。若不是默认安装路径：

```powershell
$env:WECHAT_DEVTOOLS_CLI='C:\实际安装目录\cli.bat'
```

运行：

```powershell
npm run wechat:login
npm run wechat:preview
npm run wechat:upload -- --version 1.0.0 --desc '首次提审 报价版本客户确认'
```

扫码必须由小程序管理员或项目成员完成。输出文件位于 Git 已忽略的 `out/`。CLI 说明见[微信官方文档](https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html)。

上传后登录 [微信公众平台](https://mp.weixin.qq.com/)：“管理 → 版本管理 → 开发版本 → 提交审核”。审核通过后仍需管理员手动点击“发布”。

## 8. 真机验收底线

iOS、Android 各执行一次：

1. 首次微信登录。
2. 修改店铺和价格库。
3. 创建、预览、发布 V1。
4. 客户页查看、提问、申请修改和接受。
5. 创建 V2，检查旧链接状态。
6. PDF 中文与金额正确。
7. 长图多页保存、拒绝相册权限及恢复授权。
8. 隐私说明可打开。
9. 分享卡不含客户电话、金额等敏感信息。
10. 导出数据和永久删除店铺。

## 9. Git 与制品边界

GitHub 仓库包含全部源代码、字体许可、测试、部署配置、PRD、上架文档和生成脚本。

以下内容按设计不提交：

- `node_modules/`、`dist/`、`out/`。
- Windows ZIP 和本地构建目录 `release/`。
- `.env*` 真实配置、SQLite、备份、日志。
- 小程序私有配置、登录二维码、预检报告、上传结果。
- AppSecret、Deploy Key 私钥和代码上传密钥。

Windows 包可在新机运行 `npm run build:windows` 重建。单个 ZIP 超过 GitHub 普通 Git 100 MB 限制，不应直接提交；如需分发，应创建 GitHub Release 并上传为 Release Asset。

## 10. 故障定位

- `Only URLs with a scheme... Received protocol 'c:'`：已修复，Electron 动态导入使用 `pathToFileURL`。
- 微信预检报告 AppID 阻断：先运行 `wechat:configure`，不要改公共 `touristappid` 作为临时绕过。
- API 健康检查不是 `mode=server`：检查生产环境变量，不要把桌面模式部署到公网。
- 真机提示域名不合法：确认 ICP、公众平台合法域名、HTTPS 证书链和 `config.js` 完全一致。
- 隐私接口错误 112：提审版隐私指引未声明对应信息，更新后等待平台生效。
- 开发者工具 CLI 未登录：先执行 `npm run wechat:login` 并扫码。

## 11. 接手完成定义

只有以下证据全部存在，微信上架 Goal 才可标记完成：

- 真实 AppID 与备案号。
- 严格在线预检 0 blocker。
- iOS/Android 真机验收记录。
- 公众平台开发版本上传成功记录。
- 审核通过记录。
- 正式发布后普通微信搜索/扫码冒烟通过。
- 生产备份与恢复演练通过。
