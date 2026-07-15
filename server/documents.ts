import { Hono } from 'hono';

import type { AppConfig } from './config.ts';
import type { AppDatabase } from './database.ts';
import { AppError, notFound } from './errors.ts';
import { createQuotePdf } from './pdf.ts';
import { publicRateLimiter } from './rate-limit.ts';
import {
  decryptSnapshot,
  getMerchantVersion,
  getVersionById,
  refreshExpiry,
  toPublicDocument,
} from './quote-service.ts';
import { verifyQuoteToken } from './security.ts';
import type { AppBindings } from './types.ts';

function pdfResponse(body: Uint8Array, filename: string): Response {
  return new Response(body as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store, private',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  });
}

export function createProtectedDocumentRoutes(
  db: AppDatabase,
  config: AppConfig,
): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get('/:quoteId/versions/:version/pdf', async (context) => {
    const auth = context.get('auth');
    const version = Number(context.req.param('version'));
    if (!Number.isInteger(version) || version < 1) {
      throw new AppError(400, 'INVALID_VERSION', '版本号无效');
    }
    const row = refreshExpiry(
      db,
      getMerchantVersion(db, auth.merchantId, context.req.param('quoteId'), version),
    );
    if (row.state === 'WITHDRAWN') throw new AppError(410, 'QUOTE_WITHDRAWN', '报价已撤回');
    const document = toPublicDocument(row, decryptSnapshot(row, config));
    const pdf = await createQuotePdf(document, config);
    return pdfResponse(pdf, `${document.quoteNumber}-V${document.version}.pdf`);
  });
  return app;
}

export function createPublicDocumentRoutes(db: AppDatabase, config: AppConfig): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get('/:token/pdf', async (context) => {
    const token = verifyQuoteToken(context.req.param('token'), config.appSecret);
    if (!token) throw notFound('报价链接无效');
    const row = refreshExpiry(db, getVersionById(db, token.versionId));
    if (row.token_nonce !== token.nonce) throw notFound('报价链接已失效');
    if (row.state === 'WITHDRAWN') throw new AppError(410, 'QUOTE_WITHDRAWN', '报价已撤回');
    publicRateLimiter.check(`pdf:${row.id}`, 10, 60_000);
    const document = toPublicDocument(row, decryptSnapshot(row, config));
    const pdf = await createQuotePdf(document, config);
    return pdfResponse(pdf, `${document.quoteNumber}-V${document.version}.pdf`);
  });
  return app;
}
