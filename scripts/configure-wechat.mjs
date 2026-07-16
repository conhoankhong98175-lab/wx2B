import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateApiBaseUrl, validateAppId } from './wechat-preflight.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? '';
  return process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';
}

const appId = argument('appid') || process.env.WECHAT_APP_ID || '';
const apiBaseUrl = argument('api-base-url') || process.env.WECHAT_API_BASE_URL || '';
const appIdError = validateAppId(appId);
const apiError = validateApiBaseUrl(apiBaseUrl);
if (appIdError || apiError) {
  if (appIdError) console.error(`AppID：${appIdError}`);
  if (apiError) console.error(`API：${apiError}`);
  console.error(
    '用法：npm run wechat:configure -- --appid wx1234567890123456 --api-base-url https://quote.example.com',
  );
  process.exit(2);
}

const privateConfigPath = resolve(root, 'miniprogram', 'project.private.config.json');
const privateConfig = existsSync(privateConfigPath)
  ? JSON.parse((await readFile(privateConfigPath, 'utf8')).replace(/^\uFEFF/, ''))
  : {};
privateConfig.appid = appId;
privateConfig.projectname = '店告报价助手';
await writeFile(privateConfigPath, `${JSON.stringify(privateConfig, null, 2)}\n`, 'utf8');

const configPath = resolve(root, 'miniprogram', 'config.js');
await writeFile(
  configPath,
  `module.exports = {\n  // 必须与微信后台 request/downloadFile 合法域名一致。\n  apiBaseUrl: '${apiBaseUrl.replace(/\/$/, '')}',\n};\n`,
  'utf8',
);

console.log(`已写入私有 AppID 配置：${privateConfigPath}`);
console.log(`已写入生产 API 地址：${configPath}`);
console.log('下一步：npm run wechat:preflight -- --strict-online');
