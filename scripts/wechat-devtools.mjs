import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWechatPreflight, validateAppId } from './wechat-preflight.mjs';
import {
  validateCliTimeout,
  validateDevToolsPort,
  resolveDevToolsInvocation,
  withDevToolsPort,
} from './wechat-devtools-options.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectPath = resolve(root, 'miniprogram');
const outputDirectory = resolve(root, 'out');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? '';
  return process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';
}

function flag(name) {
  return process.argv.includes(`--${name}`);
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

function runCli(cliPath, args, timeout, enableServicePort = false) {
  const invocation = resolveDevToolsInvocation(cliPath);
  if (!existsSync(invocation.command) || invocation.prefixArgs.some((path) => !existsSync(path))) {
    throw new Error('微信开发者工具 CLI 组件不完整，请修复或重新安装官方稳定版');
  }
  const options = {
    cwd: root,
    stdio: [enableServicePort ? 'pipe' : 'ignore', 'inherit', 'inherit'],
    timeout,
    ...(enableServicePort ? { input: 'y\n' } : {}),
  };
  const result = spawnSync(invocation.command, [...invocation.prefixArgs, ...args], options);
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(
      '连接微信开发者工具超时。请在“设置 → 安全设置”开启服务端口，并确认工具与当前终端使用相同权限级别。',
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`微信开发者工具 CLI 失败，退出码 ${result.status}`);
}

const action = process.argv[2];
if (!['status', 'login', 'preview', 'upload'].includes(action)) {
  console.error('用法：node scripts/wechat-devtools.mjs <status|login|preview|upload>');
  process.exit(2);
}

const port = argument('port') || process.env.WECHAT_DEVTOOLS_PORT || '';
const portError = validateDevToolsPort(port);
if (portError) throw new Error(portError);
const defaultTimeout = action === 'status' ? '30000' : action === 'login' ? '180000' : '600000';
const timeoutValue = process.env.WECHAT_DEVTOOLS_TIMEOUT_MS || defaultTimeout;
const timeoutError = validateCliTimeout(timeoutValue);
if (timeoutError) throw new Error(timeoutError);
const timeout = Number(timeoutValue);
const enableServicePort =
  flag('enable-service-port') || process.env.WECHAT_ENABLE_SERVICE_PORT === '1';

const cliPath = findDevToolsCli();
if (!cliPath) {
  throw new Error(
    '未找到微信开发者工具 CLI。请安装官方稳定版，或用 WECHAT_DEVTOOLS_CLI 指向 cli.bat',
  );
}
mkdirSync(outputDirectory, { recursive: true });

if (action === 'status') {
  runCli(cliPath, withDevToolsPort(['islogin', '--lang', 'zh'], port), timeout, enableServicePort);
  process.exit(0);
}

if (action === 'login') {
  runCli(
    cliPath,
    withDevToolsPort(
      [
        'login',
        '--qr-format',
        'image',
        '--qr-output',
        resolve(outputDirectory, 'wechat-login.png'),
        '--result-output',
        resolve(outputDirectory, 'wechat-login-result.json'),
      ],
      port,
    ),
    timeout,
    enableServicePort,
  );
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
  runCli(
    cliPath,
    withDevToolsPort(
      [
        'preview',
        '--project',
        projectPath,
        '--qr-format',
        'image',
        '--qr-output',
        resolve(outputDirectory, 'wechat-preview.png'),
        '--info-output',
        resolve(outputDirectory, 'wechat-preview-info.json'),
      ],
      port,
    ),
    timeout,
    enableServicePort,
  );
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
  runCli(
    cliPath,
    withDevToolsPort(
      [
        'upload',
        '--project',
        projectPath,
        '--version',
        version,
        '--desc',
        description,
        '--info-output',
        resolve(outputDirectory, 'wechat-upload-info.json'),
      ],
      port,
    ),
    timeout,
    enableServicePort,
  );
  console.log(`代码上传完成：${appId} ${version}`);
  console.log('下一步由管理员登录 mp.weixin.qq.com，在“版本管理”提交审核。');
}
