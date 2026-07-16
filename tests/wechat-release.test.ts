import { describe, expect, it } from 'vitest';

// @ts-expect-error The release helper is intentionally executable ESM without a declaration file.
import { validateApiBaseUrl, validateAppId } from '../scripts/wechat-preflight.mjs';

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
