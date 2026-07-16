import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const miniprogramRoot = resolve(root, 'miniprogram');
const outputPath = resolve(root, 'out', 'wechat-preflight.json');

async function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}

export function validateAppId(value) {
  if (!value || value === 'touristappid') return '尚未配置真实 AppID';
  if (!/^wx[A-Za-z0-9]{16}$/.test(value)) return 'AppID 应为 wx 开头的 18 位标识';
  return '';
}

export function validateApiBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'API 地址不是有效 URL';
  }
  if (url.protocol !== 'https:') return 'API 地址必须使用 HTTPS';
  if (url.username || url.password) return 'API 地址不能包含用户名或密码';
  if (url.search || url.hash) return 'API 地址不能包含查询参数或片段';
  if (
    isIP(url.hostname) ||
    ['localhost', 'api.example.com', 'example.com'].includes(url.hostname) ||
    url.hostname.endsWith('.local')
  ) {
    return 'API 地址必须使用真实、已备案的公网域名，不能使用示例域名、IP 或 localhost';
  }
  return '';
}

function extractApiBaseUrl(source) {
  return source.match(/apiBaseUrl\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? '';
}

function addResult(target, level, code, message, detail = '') {
  target[level].push({ code, message, ...(detail ? { detail } : {}) });
}

export async function runWechatPreflight(options = {}) {
  const projectConfig = await readJson(resolve(miniprogramRoot, 'project.config.json'), {});
  const privateConfig = await readJson(resolve(miniprogramRoot, 'project.private.config.json'), {});
  const appConfig = await readJson(resolve(miniprogramRoot, 'app.json'), {});
  const configSource = await readFile(resolve(miniprogramRoot, 'config.js'), 'utf8');
  const sourceFiles = await Promise.all(
    [
      'utils/api.js',
      'pages/settings/index.js',
      'pages/public-quote/index.js',
      'pages/editor/index.js',
    ].map((path) => readFile(resolve(miniprogramRoot, path), 'utf8')),
  );
  const source = sourceFiles.join('\n');
  const appId =
    options.appId ||
    process.env.WECHAT_APP_ID ||
    privateConfig?.appid ||
    projectConfig?.appid ||
    '';
  const apiBaseUrl =
    options.apiBaseUrl || process.env.WECHAT_API_BASE_URL || extractApiBaseUrl(configSource);
  const report = {
    generatedAt: new Date().toISOString(),
    appId,
    apiBaseUrl,
    passed: [],
    blockers: [],
    warnings: [],
    manualChecks: [
      '公众平台已完成主体注册/认证要求，管理员微信和联系电话有效',
      '小程序备案已通过，并取得小程序备案号',
      '服务类目选择“工具 → 报价/比价”，页面可从首页两次点击内到达',
      'API 域名已完成 ICP 备案，并配置为 request、downloadFile 合法域名',
      '公众平台用户隐私保护指引已声明“使用你的相册（仅写入）权限”及实际业务数据',
      'iOS、Android 真机完成登录、报价、分享、PDF、长图与删除账号验收',
    ],
    detectedApis: [
      ...new Set([...source.matchAll(/\bwx\.([A-Za-z0-9_]+)/g)].map((item) => item[1])),
    ]
      .sort()
      .map((name) => `wx.${name}`),
  };

  const appIdError = validateAppId(appId);
  if (appIdError) addResult(report, 'blockers', 'APP_ID', appIdError);
  else addResult(report, 'passed', 'APP_ID', '已配置格式正确的真实 AppID');

  const apiError = validateApiBaseUrl(apiBaseUrl);
  if (apiError) addResult(report, 'blockers', 'API_BASE_URL', apiError);
  else addResult(report, 'passed', 'API_BASE_URL', 'API 地址使用真实 HTTPS 域名');

  if (projectConfig?.setting?.urlCheck !== true) {
    addResult(report, 'blockers', 'URL_CHECK', '提审配置必须启用域名校验 urlCheck');
  } else {
    addResult(report, 'passed', 'URL_CHECK', '已启用开发者工具域名校验');
  }
  if (projectConfig?.setting?.uploadWithSourceMap === true) {
    addResult(report, 'warnings', 'SOURCE_MAP', '当前配置会上传 source map，请确认是否必要');
  } else {
    addResult(report, 'passed', 'SOURCE_MAP', '发行配置不会上传 source map');
  }
  if (appConfig.__usePrivacyCheck__ !== true) {
    addResult(
      report,
      'warnings',
      'PRIVACY_CHECK',
      '建议显式配置 __usePrivacyCheck__: true 以便开发期尽早发现隐私声明缺失',
    );
  } else {
    addResult(report, 'passed', 'PRIVACY_CHECK', '已显式启用隐私接口检查');
  }
  if (!source.includes('wx.saveImageToPhotosAlbum')) {
    addResult(report, 'warnings', 'ALBUM_API', '未检测到长图保存接口');
  } else {
    addResult(
      report,
      'passed',
      'ALBUM_API',
      '检测到 wx.saveImageToPhotosAlbum；后台必须声明“使用你的相册（仅写入）权限”',
    );
  }
  if (!source.includes('wx.openPrivacyContract')) {
    addResult(report, 'warnings', 'PRIVACY_ENTRY', '建议在设置页提供 wx.openPrivacyContract 入口');
  } else {
    addResult(report, 'passed', 'PRIVACY_ENTRY', '设置页提供官方隐私保护指引入口');
  }

  if (!apiError && options.strictOnline) {
    const healthUrl = `${apiBaseUrl.replace(/\/$/, '')}/api/health`;
    try {
      const response = await globalThis.fetch(healthUrl, {
        signal: globalThis.AbortSignal.timeout(10_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true || body?.mode !== 'server') {
        addResult(
          report,
          'blockers',
          'API_HEALTH',
          '生产 API 健康检查未返回 server 模式 ready 状态',
          `${response.status} ${healthUrl}`,
        );
      } else {
        addResult(report, 'passed', 'API_HEALTH', '生产 API 健康检查通过', healthUrl);
      }
    } catch (error) {
      addResult(
        report,
        'blockers',
        'API_HEALTH',
        '无法连接生产 API',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (!options.noReport) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return report;
}

function printReport(report) {
  for (const item of report.passed) console.log(`PASS  ${item.message}`);
  for (const item of report.warnings)
    console.warn(`WARN  ${item.message}${item.detail ? `：${item.detail}` : ''}`);
  for (const item of report.blockers)
    console.error(`BLOCK ${item.message}${item.detail ? `：${item.detail}` : ''}`);
  console.log(`\n检测到的微信 API：${report.detectedApis.join(', ')}`);
  console.log(`报告：${outputPath}`);
  console.log(
    `结论：${report.blockers.length === 0 ? '代码预检通过，继续完成人工后台检查' : `存在 ${report.blockers.length} 个发布阻断`}`,
  );
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const report = await runWechatPreflight({
    strictOnline: process.argv.includes('--strict-online'),
    noReport: process.argv.includes('--no-report'),
  });
  printReport(report);
  if (report.blockers.length > 0) process.exitCode = 1;
}
