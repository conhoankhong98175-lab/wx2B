import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';

import type { AppConfig } from './config.ts';
import type { AppDatabase } from './database.ts';
import { AppError } from './errors.ts';
import { id, nowIso, seedDemoCatalog } from './helpers.ts';
import { createAccessToken, verifyAccessToken } from './security.ts';
import type { AppBindings, AuthContext } from './types.ts';
import { localLoginSchema, wechatLoginSchema } from './validation.ts';
import { authRateLimiter } from './rate-limit.ts';

function clientKey(context: { req: { header: (name: string) => string | undefined } }): string {
  return (context.req.header('x-forwarded-for') ?? 'direct').split(',')[0]!.trim().slice(0, 64);
}

function ensureAccount(
  db: AppDatabase,
  config: AppConfig,
  input: { wechatOpenId: string | null; displayName: string },
): AuthContext {
  const existingUser = input.wechatOpenId
    ? db.prepare('SELECT id, status FROM users WHERE wechat_openid = ?').get(input.wechatOpenId)
    : db
        .prepare(
          'SELECT id, status FROM users WHERE wechat_openid IS NULL ORDER BY created_at LIMIT 1',
        )
        .get();

  return db.transaction(() => {
    const timestamp = nowIso();
    if (existingUser && String(existingUser.status) !== 'ACTIVE') {
      throw new AppError(403, 'ACCOUNT_DISABLED', '账号已停用');
    }
    const userId = existingUser ? String(existingUser.id) : id();
    if (!existingUser) {
      db.prepare(
        'INSERT INTO users(id, wechat_openid, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(userId, input.wechatOpenId, 'ACTIVE', timestamp, timestamp);
    }

    const existingMembership = db
      .prepare(
        `SELECT m.merchant_id, m.role, m.can_view_cost, m.status
         FROM memberships m
         JOIN merchants merchant ON merchant.id = m.merchant_id
         WHERE m.user_id = ?
         ORDER BY m.created_at LIMIT 1`,
      )
      .get(userId);

    if (existingMembership && String(existingMembership.status ?? 'ACTIVE') !== 'ACTIVE') {
      throw new AppError(403, 'MEMBERSHIP_DISABLED', '成员权限已停用');
    }
    if (existingMembership) {
      return {
        userId,
        merchantId: String(existingMembership.merchant_id),
        role: String(existingMembership.role) as AuthContext['role'],
        canViewCost: Number(existingMembership.can_view_cost) === 1,
      };
    }

    const merchantId = id();
    db.prepare(
      `INSERT INTO merchants(
        id, name, contact_phone_encrypted, contact_wechat_encrypted, created_at, updated_at
      ) VALUES (?, ?, '', '', ?, ?)`,
    ).run(merchantId, input.displayName, timestamp, timestamp);
    db.prepare(
      `INSERT INTO memberships(
        user_id, merchant_id, role, can_view_cost, status, created_at, updated_at
      ) VALUES (?, ?, 'OWNER', 1, 'ACTIVE', ?, ?)`,
    ).run(userId, merchantId, timestamp, timestamp);
    seedDemoCatalog(db, merchantId, config.appSecret);
    return { userId, merchantId, role: 'OWNER', canViewCost: true };
  });
}

export function authMiddleware(config: AppConfig, db: AppDatabase): MiddlewareHandler<AppBindings> {
  return async (context, next) => {
    const header = context.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyAccessToken(token, config.appSecret);
    if (!payload) throw new AppError(401, 'UNAUTHORIZED', '登录已过期，请重新登录');
    const membership = db
      .prepare(
        `SELECT m.role, m.can_view_cost
         FROM users u JOIN memberships m ON m.user_id = u.id
         WHERE u.id = ? AND u.status = 'ACTIVE' AND m.merchant_id = ? AND m.status = 'ACTIVE'`,
      )
      .get(payload.sub, payload.merchantId);
    if (!membership) throw new AppError(401, 'ACCOUNT_DISABLED', '账号或成员权限已停用');
    context.set('auth', {
      userId: payload.sub,
      merchantId: payload.merchantId,
      role: String(membership.role) as AuthContext['role'],
      canViewCost: Number(membership.can_view_cost) === 1,
    });
    await next();
  };
}

export function createAuthRoutes(db: AppDatabase, config: AppConfig): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post('/local', async (context) => {
    if (config.mode === 'server' || !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
      throw new AppError(404, 'NOT_FOUND', '本地登录不可用');
    }
    const parsed = localLoginSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new AppError(400, 'VALIDATION_ERROR', '登录信息无效', parsed.error.flatten());
    }
    const auth = ensureAccount(db, config, {
      wechatOpenId: null,
      displayName: parsed.data.displayName,
    });
    const token = createAccessToken(
      {
        sub: auth.userId,
        merchantId: auth.merchantId,
        role: auth.role,
        canViewCost: auth.canViewCost,
      },
      config.appSecret,
      30 * 24 * 60 * 60,
    );
    return context.json({ token, auth });
  });

  app.post('/wechat', async (context) => {
    authRateLimiter.check('wechat:global', 300, 60_000);
    authRateLimiter.check(`wechat:${clientKey(context)}`, 20, 60_000);
    if (!config.wechatAppId || !config.wechatAppSecret) {
      throw new AppError(503, 'WECHAT_NOT_CONFIGURED', '服务器尚未配置微信小程序登录');
    }
    const parsed = wechatLoginSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new AppError(400, 'VALIDATION_ERROR', '微信登录参数无效', parsed.error.flatten());
    }
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.searchParams.set('appid', config.wechatAppId);
    url.searchParams.set('secret', config.wechatAppSecret);
    url.searchParams.set('js_code', parsed.data.code);
    url.searchParams.set('grant_type', 'authorization_code');
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const result = (await response.json()) as {
      openid?: string;
      errcode?: number;
      errmsg?: string;
    };
    if (!response.ok || !result.openid) {
      throw new AppError(401, 'WECHAT_LOGIN_FAILED', '微信登录失败，请稍后重试', {
        errcode: result.errcode,
      });
    }
    const auth = ensureAccount(db, config, {
      wechatOpenId: result.openid,
      displayName: '我的店铺',
    });
    const token = createAccessToken(
      {
        sub: auth.userId,
        merchantId: auth.merchantId,
        role: auth.role,
        canViewCost: auth.canViewCost,
      },
      config.appSecret,
    );
    return context.json({ token, auth });
  });

  return app;
}
