import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { createAuthRoutes, authMiddleware } from './auth.ts';
import { createCatalogRoutes } from './catalog.ts';
import type { AppConfig } from './config.ts';
import type { AppDatabase } from './database.ts';
import { createProtectedDocumentRoutes, createPublicDocumentRoutes } from './documents.ts';
import { AppError } from './errors.ts';
import { createMerchantRoutes } from './merchant.ts';
import { createPublicQuoteRoutes } from './public-quotes.ts';
import { createQuoteRoutes } from './quotes.ts';
import type { AppBindings } from './types.ts';

function mime(path: string): string {
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.ico')) return 'image/x-icon';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

export function createApp(db: AppDatabase, config: AppConfig): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use(
    '*',
    bodyLimit({
      maxSize: 512 * 1024,
      onError: () => {
        throw new AppError(413, 'PAYLOAD_TOO_LARGE', '请求内容不能超过 512 KB');
      },
    }),
  );

  app.use('*', async (context, next) => {
    const requestId = context.req.header('x-request-id')?.slice(0, 100) || crypto.randomUUID();
    context.set('requestId', requestId);
    context.header('X-Request-Id', requestId);
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('X-Frame-Options', 'DENY');
    context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    context.header('Referrer-Policy', 'same-origin');
    if (context.req.path.startsWith('/api/') && context.req.path !== '/api/health') {
      context.header('Cache-Control', 'no-store, private');
    }

    const origin = context.req.header('origin');
    if (origin && config.corsOrigins.includes(origin)) {
      context.header('Access-Control-Allow-Origin', origin);
      context.header('Vary', 'Origin');
      context.header(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Idempotency-Key, If-Match',
      );
      context.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    if (context.req.method === 'OPTIONS') return context.body(null, 204);
    await next();
  });

  app.get('/api/health', (context) =>
    context.json({
      ok: true,
      service: 'diangao',
      mode: config.mode,
      ready: true,
      time: new Date().toISOString(),
    }),
  );
  app.route('/api/auth', createAuthRoutes(db, config));

  app.route('/api/public/quotes', createPublicQuoteRoutes(db, config));
  app.route('/api/public/documents', createPublicDocumentRoutes(db, config));

  const mountProtected = (path: string, router: Hono<AppBindings>): void => {
    const group = new Hono<AppBindings>();
    group.use('*', authMiddleware(config, db));
    group.route('/', router);
    app.route(path, group);
  };
  mountProtected('/api/merchant', createMerchantRoutes(db, config));
  mountProtected('/api/catalog', createCatalogRoutes(db, config));
  mountProtected('/api/quotes', createQuoteRoutes(db, config));
  mountProtected('/api/documents', createProtectedDocumentRoutes(db, config));

  app.get('/assets/*', (context) => {
    const relative = context.req.path.replace(/^\/assets\//, '');
    if (relative.includes('..') || relative.includes('\\'))
      throw new AppError(400, 'INVALID_PATH', '资源路径无效');
    const path = join(config.webRoot, 'assets', relative);
    if (!existsSync(path)) return context.notFound();
    return new Response(readFileSync(path), { headers: { 'Content-Type': mime(path) } });
  });

  app.get('*', (context) => {
    if (context.req.path.startsWith('/api/')) return context.notFound();
    const indexPath = join(config.webRoot, 'index.html');
    if (!existsSync(indexPath)) {
      return context.json({
        message: '店告 API 正在运行。前端尚未构建，请执行 npm run build:web。',
      });
    }
    context.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (context.req.path.startsWith('/q/')) context.header('Referrer-Policy', 'no-referrer');
    context.header('Cache-Control', 'no-cache');
    return context.html(readFileSync(indexPath, 'utf8'));
  });

  app.onError((error, context) => {
    const requestId = context.get('requestId') || crypto.randomUUID();
    if (error instanceof AppError) {
      return context.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
            requestId,
          },
        },
        error.status as 400,
      );
    }
    console.error(`[${requestId}]`, error instanceof Error ? error.stack : error);
    return context.json(
      { error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试', requestId } },
      500,
    );
  });

  app.notFound((context) =>
    context.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: '未找到请求的内容',
          requestId: context.get('requestId') || crypto.randomUUID(),
        },
      },
      404,
    ),
  );

  return app;
}
