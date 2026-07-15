import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type AppMode = 'desktop' | 'server' | 'test';

function loadEnvironmentFile(): void {
  if (typeof process.loadEnvFile !== 'function') return;
  for (const candidate of ['.env.local', '.env']) {
    const path = resolve(candidate);
    if (existsSync(path)) {
      process.loadEnvFile(path);
      return;
    }
  }
}

loadEnvironmentFile();

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mode(value: string | undefined): AppMode {
  if (value === 'server' || value === 'test' || value === 'desktop') return value;
  return process.env.NODE_ENV === 'production' ? 'server' : 'desktop';
}

const appMode = mode(process.env.DIANGAO_MODE);
const isProduction = process.env.NODE_ENV === 'production';
const configuredSecret = process.env.APP_SECRET?.trim();

if (isProduction && (!configuredSecret || configuredSecret.length < 32)) {
  throw new Error('生产环境必须配置至少 32 字节的 APP_SECRET');
}

const configuredPublicBaseUrl =
  process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${integer(process.env.PORT, 3100)}`;
if (isProduction && appMode === 'server') {
  let publicUrl: URL;
  try {
    publicUrl = new URL(configuredPublicBaseUrl);
  } catch {
    throw new Error('生产服务必须配置有效的 PUBLIC_BASE_URL');
  }
  if (publicUrl.protocol !== 'https:') {
    throw new Error('生产服务的 PUBLIC_BASE_URL 必须使用 HTTPS');
  }
  if (!process.env.WECHAT_APP_ID?.trim() || !process.env.WECHAT_APP_SECRET?.trim()) {
    throw new Error('生产服务必须配置 WECHAT_APP_ID 和 WECHAT_APP_SECRET');
  }
}

export interface AppConfig {
  mode: AppMode;
  isProduction: boolean;
  host: string;
  port: number;
  publicBaseUrl: string;
  dbPath: string;
  appSecret: string;
  wechatAppId: string;
  wechatAppSecret: string;
  pdfFontPath: string;
  corsOrigins: string[];
  webRoot: string;
}

export const config: AppConfig = {
  mode: appMode,
  isProduction,
  host: process.env.HOST ?? '127.0.0.1',
  port: integer(process.env.PORT, 3100),
  publicBaseUrl: configuredPublicBaseUrl,
  dbPath: resolve(process.env.DB_PATH ?? './data/diangao.db'),
  appSecret: configuredSecret ?? 'diangao-local-development-secret-change-before-production',
  wechatAppId: process.env.WECHAT_APP_ID ?? '',
  wechatAppSecret: process.env.WECHAT_APP_SECRET ?? '',
  pdfFontPath: process.env.PDF_FONT_PATH ?? '',
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  webRoot: resolve(process.env.WEB_ROOT ?? './dist/web'),
};
