import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWechatPreflight, validateAppId } from './wechat-preflight.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectPath = resolve(root, 'miniprogram');
const outputDirectory = resolve(root, 'out');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? '';
  return process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';
}

function loadAppId() {
  if (process.env.WECHAT_APP_ID) return process.env.WECHAT_APP_ID;
  const path = resolve(projectPath, 'project.private.config.json');
  if (!existsSync(path)) return '';
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')).appid ?? '';
}

function findDevToolsCli() {
  const candidates = [
    process.env.WECHAT_DEVTOOLS_CLI,
    process.env['ProgramFiles(x86)']
      ? resolve(process.env['ProgramFiles(x86)'], 'Tencent', '微信web开发者工具', 'cli.bat')
      : '',
    process.env.ProgramFiles
      ? resolve(process.env.ProgramFiles, 'Tencent', '微信开发者工具', 'cli.bat')
      : '',
    process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, '微信开发者工具', 'cli.bat') : '',
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? '';
}

function runCli(cliPath, args) {
  let result;
  if (process.platform === 'win32') {
    const command =
      '$tool=$args[0]; $toolArgs=@($args | Select-Object -Skip 1); & $tool @toolArgs; exit $LASTEXITCODE';
    result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command, cliPath, ...args],
      { cwd: root, stdio: 'inherit' },
    );
  } else {
    result = spawnSync(cliPath, args, { cwd: root, stdio: 'inherit' });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`微信开发者工具 CLI 失败，退出码 ${result.status}`);
}

const action = process.argv[2];
if (!['login', 'preview', 'upload'].includes(action)) {
  console.error('用法：node scripts/wechat-devtools.mjs <login|preview|upload>');
  process.exit(2);
}

const cliPath = findDevToolsCli();
if (!cliPath) {
  throw new Error(
    '未找到微信开发者工具 CLI。请安装官方稳定版，或用 WECHAT_DEVTOOLS_CLI 指向 cli.bat',
  );
}
mkdirSync(outputDirectory, { recursive: true });

if (action === 'login') {
  runCli(cliPath, [
    'login',
    '--qr-format',
    'image',
    '--qr-output',
    resolve(outputDirectory, 'wechat-login.png'),
    '--result-output',
    resolve(outputDirectory, 'wechat-login-result.json'),
  ]);
  console.log(`登录二维码：${resolve(outputDirectory, 'wechat-login.png')}`);
  process.exit(0);
}

const appId = loadAppId();
const appIdError = validateAppId(appId);
if (appIdError) throw new Error(appIdError);
const report = await runWechatPreflight({ appId, strictOnline: true });
if (report.blockers.length > 0) {
  throw new Error(
    `微信发布预检存在 ${report.blockers.length} 个阻断，请先运行 npm run wechat:preflight`,
  );
}

if (action === 'preview') {
  runCli(cliPath, [
    'preview',
    '--project',
    projectPath,
    '--qr-format',
    'image',
    '--qr-output',
    resolve(outputDirectory, 'wechat-preview.png'),
    '--info-output',
    resolve(outputDirectory, 'wechat-preview-info.json'),
  ]);
  console.log(`预览二维码：${resolve(outputDirectory, 'wechat-preview.png')}`);
} else {
  const packageVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const version = argument('version') || process.env.WECHAT_VERSION || packageVersion;
  const description = argument('desc') || process.env.WECHAT_DESC || '店告报价助手发布候选版本';
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`上传版本号格式无效：${version}`);
  }
  if (!/^[\p{L}\p{N}\s,.，。:：_()（）-]{1,100}$/u.test(description)) {
    throw new Error('上传备注只能包含文字、数字、空格和常用标点，长度不超过 100');
  }
  runCli(cliPath, [
    'upload',
    '--project',
    projectPath,
    '--version',
    version,
    '--desc',
    description,
    '--info-output',
    resolve(outputDirectory, 'wechat-upload-info.json'),
  ]);
  console.log(`代码上传完成：${appId} ${version}`);
  console.log('下一步由管理员登录 mp.weixin.qq.com，在“版本管理”提交审核。');
}
