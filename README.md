# 店告 · 微信报价成交助手

一个面向广告制作、招牌、喷绘写真和图文快印门店的完整报价工具。商家可维护自己的价格库，在移动端或 Windows 工作台创建带版本的报价，客户免登录查看、接受、提问或申请修改。

PDF、长图和客户页只展示商家自己的资料与中性报价信息。

## 已交付组成

- `web/`：Windows 本地工作台界面和客户 H5 报价页。
- `miniprogram/`：原生微信小程序，可直接导入微信开发者工具。
- `server/`：Hono + Node.js + SQLite 后端，服务端权威重算。
- `shared/`：Decimal 十进制定价引擎和跨端数据契约。
- `electron/`：Windows 安全薄壳，打包后目标电脑无需安装 Node.js。
- `tests/`：定价、端到端闭环、权限、租户隔离和版本不可变测试。
- `deploy/`、`docs/`：服务器、HTTPS、微信发布、备份恢复和隐私说明。

## 本地开发

要求 Node.js 24.x 和 npm 11.x。

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

打开 `http://127.0.0.1:5173`。本地开发模式使用单机身份，不调用微信登录。

## 质量检查

```powershell
npm run check
npm run test:coverage
```

## Windows 便携版

```powershell
npm run build:windows
```

产物位于 `release/`，ZIP 解压后双击 `店告报价助手.exe`。便携版是本地工作台，数据保存在 Windows 当前用户的应用数据目录，不写安装目录；它适合本机建价、报价与 PDF，不生成误导性的公网客户链接，也不与线上小程序数据库混用。线上商家操作使用微信小程序，客户链接与客户动作使用公网客户 H5；当前版本不提供在线浏览器商家登录，也不承诺本地库与线上库互通。

## 微信小程序

1. 编辑 `miniprogram/config.js`，把 `apiBaseUrl` 改成已备案的 HTTPS API 域名。
2. 把 `miniprogram/project.config.json` 中的 `appid` 换成真实 AppID，或在开发者工具私有配置中覆盖。
3. 用微信开发者工具导入 `miniprogram/`。
4. 在微信后台把 API 域名同时配置到 request 与 downloadFile 合法域名。

正式上传还需要微信小程序 AppID、服务类目、隐私保护指引和已备案 HTTPS 域名。AppSecret 只放服务器环境变量，绝不能写入小程序或仓库。详见 [微信发布说明](docs/WECHAT_RELEASE.md)。

## 服务器部署

```powershell
npm ci
npm run build
$env:NODE_ENV='production'
$env:DIANGAO_MODE='server'
$env:APP_SECRET='<至少32字节随机值>'
$env:WECHAT_APP_ID='<AppID>'
$env:WECHAT_APP_SECRET='<只保存在服务器>'
$env:DB_PATH='./data/diangao.db'
node dist/server/index.mjs
```

生产部署、Caddy HTTPS、Docker 和备份恢复见 [部署文档](docs/DEPLOYMENT.md)。

## 关键安全约束

- 小程序只把 `wx.login` 的临时代码发给服务器，AppSecret 永不下发。
- 金额由服务端用 Decimal 字符串重算；客户端预估不能决定正式报价。
- 正式版本保存加密快照并禁止更新/普通删除；价格库变化不覆盖历史。
- 客户凭证使用带 HMAC 签名的高熵随机值；撤回或删除数据后立即失效。
- 客户输出采用白名单模型，成本、毛利、内部联系方式和内部备注不会先下发再隐藏。
- 联系方式、留言、草稿、正式快照和成本价在 SQLite 中加密保存。

产品范围和验收口径见 [完整 PRD](店告-微信报价成交助手-产品需求文档.md)。
