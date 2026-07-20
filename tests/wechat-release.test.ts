import { describe, expect, it } from 'vitest';

// @ts-expect-error The release helper is intentionally executable ESM without a declaration file.
import { validateApiBaseUrl, validateAppId } from '../scripts/wechat-preflight.mjs';
// @ts-expect-error The CLI options helper is executable ESM without a declaration file.
// prettier-ignore
import { resolveDevToolsInvocation, validateCliTimeout, validateDevToolsPort, withDevToolsPort } from '../scripts/wechat-devtools-options.mjs';

describe('微信发布配置校验', () => {
  it('只接受真实格式的 AppID', () => {
    expect(validateAppId('touristappid')).toContain('真实 AppID');
    expect(validateAppId('wx1234567890123456')).toBe('');
    expect(validateAppId('wx-short')).toContain('18 位');
  });

  it('拒绝示例、IP、本机和非 HTTPS API 地址', () => {
    expect(validateApiBaseUrl('https://api.example.com')).toContain('真实');
    expect(validateApiBaseUrl('http://quote.example.cn')).toContain('HTTPS');
    expect(validateApiBaseUrl('https://127.0.0.1')).toContain('真实');
    expect(validateApiBaseUrl('https://localhost')).toContain('真实');
    expect(validateApiBaseUrl('https://quote.example.cn')).toBe('');
  });
});

describe('微信开发者工具 CLI 参数', () => {
  it('校验服务端口并安全地附加到命令', () => {
    expect(validateDevToolsPort('')).toBe('');
    expect(validateDevToolsPort('9420')).toBe('');
    expect(validateDevToolsPort('abc')).toContain('整数');
    expect(validateDevToolsPort('80')).toContain('1024');
    expect(validateDevToolsPort('65536')).toContain('65535');
    expect(withDevToolsPort(['islogin'], '9420')).toEqual(['islogin', '--port', '9420']);
    expect(withDevToolsPort(['islogin'], '')).toEqual(['islogin']);
  });

  it('限制 CLI 超时范围', () => {
    expect(validateCliTimeout('30000')).toBe('');
    expect(validateCliTimeout('nope')).toContain('整数');
    expect(validateCliTimeout('999')).toContain('1000');
    expect(validateCliTimeout('1800001')).toContain('1800000');
  });

  it('在 Windows 上绕过 bat 路径转义并直接调用官方 Node 入口', () => {
    expect(
      resolveDevToolsInvocation(
        'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
        'win32',
      ),
    ).toEqual({
      command: 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\node.exe',
      prefixArgs: ['C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.js'],
    });
    expect(resolveDevToolsInvocation('/Applications/wechatwebdevtools/cli', 'darwin')).toEqual({
      command: '/Applications/wechatwebdevtools/cli',
      prefixArgs: [],
    });
  });
});
