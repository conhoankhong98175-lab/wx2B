import { Hono } from 'hono';

import type { PublicActionType, QuoteState } from '../shared/contracts.ts';
import type { AppConfig } from './config.ts';
import type { AppDatabase } from './database.ts';
import { AppError, conflict, notFound } from './errors.ts';
import { id, nowIso } from './helpers.ts';
import {
  decryptSnapshot,
  getVersionById,
  refreshExpiry,
  toPublicDocument,
  type VersionRow,
} from './quote-service.ts';
import { encryptText, hashText, verifyQuoteToken } from './security.ts';
import type { AppBindings } from './types.ts';
import { publicActionSchema } from './validation.ts';

import { publicRateLimiter } from './rate-limit.ts';

function resolveToken(db: AppDatabase, config: AppConfig, token: string): VersionRow {
  const payload = verifyQuoteToken(token, config.appSecret);
  if (!payload) throw notFound('报价链接无效');
  const row = getVersionById(db, payload.versionId);
  if (row.token_nonce !== payload.nonce) throw notFound('报价链接已失效');
  return refreshExpiry(db, row);
}

function assertActionAllowed(state: QuoteState, type: PublicActionType): void {
  if (type === 'VIEW') {
    if (state === 'WITHDRAWN') throw conflict('QUOTE_WITHDRAWN', '报价已撤回');
    return;
  }
  if (type === 'QUESTION') {
    if (state === 'WITHDRAWN') throw conflict('QUOTE_WITHDRAWN', '报价已撤回');
    return;
  }
  if (state === 'EXPIRED') throw conflict('QUOTE_EXPIRED', '报价已过期，请联系商家');
  if (state === 'SUPERSEDED') throw conflict('QUOTE_SUPERSEDED', '报价已有新版本，请联系商家');
  if (state === 'WITHDRAWN') throw conflict('QUOTE_WITHDRAWN', '报价已撤回');
  if (state === 'ACCEPTED') throw conflict('QUOTE_ALREADY_ACCEPTED', '报价已经接受');
  if (type === 'ACCEPT' && state !== 'ACTIVE') {
    throw conflict('QUOTE_NOT_ACCEPTABLE', '当前报价状态不能接受');
  }
  if (type === 'CHANGE_REQUEST' && state !== 'ACTIVE') {
    throw conflict('QUOTE_NOT_CHANGEABLE', '当前报价状态不能申请修改');
  }
}

export function createPublicQuoteRoutes(db: AppDatabase, config: AppConfig): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store, private');
    context.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    context.header('Referrer-Policy', 'no-referrer');
    await next();
  });

  app.get('/:token', (context) => {
    const token = context.req.param('token');
    const row = resolveToken(db, config, token);
    publicRateLimiter.check(`get:${row.id}`, 120, 60_000);
    const snapshot = decryptSnapshot(row, config);
    if (row.state === 'WITHDRAWN') {
      return context.json({
        available: false,
        state: row.state,
        quoteNumber: snapshot.quoteNumber,
        version: snapshot.version,
        merchant: snapshot.merchant,
        message: '此报价已由商家撤回，请联系商家获取最新报价。',
      });
    }
    return context.json({ available: true, quote: toPublicDocument(row, snapshot) });
  });

  app.post('/:token/actions', async (context) => {
    const token = context.req.param('token');
    const initial = resolveToken(db, config, token);
    publicRateLimiter.check(`action:${initial.id}`, 30, 60_000);
    const parsed = publicActionSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new AppError(400, 'VALIDATION_ERROR', '操作内容无效', parsed.error.flatten());
    }
    const action = parsed.data;
    if (
      (action.type === 'QUESTION' || action.type === 'CHANGE_REQUEST') &&
      action.message.length < 1
    ) {
      throw new AppError(400, 'MESSAGE_REQUIRED', '请填写问题或需要修改的内容');
    }

    const result = db.transaction(() => {
      let row = getVersionById(db, initial.id);
      if (row.token_nonce !== initial.token_nonce) throw notFound('报价链接已失效');
      row = refreshExpiry(db, row);
      const requestHash = hashText(
        JSON.stringify({
          type: action.type,
          anonymousId: action.anonymousId,
          message: action.message,
        }),
        config.appSecret,
      );
      const duplicate = db
        .prepare(
          'SELECT action_type, request_hash FROM quote_actions WHERE version_id = ? AND request_id = ?',
        )
        .get(row.id, action.requestId);
      if (duplicate) {
        if (
          String(duplicate.action_type) !== action.type ||
          (String(duplicate.request_hash) !== '' && String(duplicate.request_hash) !== requestHash)
        ) {
          throw conflict('IDEMPOTENCY_KEY_REUSED', '同一请求标识不能用于不同操作');
        }
        return { duplicate: true, state: row.state };
      }

      assertActionAllowed(row.state, action.type);
      const timestamp = nowIso();
      const anonymousHash = action.anonymousId
        ? hashText(action.anonymousId, config.appSecret)
        : '';
      db.prepare(
        `INSERT INTO quote_actions(
          id, version_id, action_type, request_id, anonymous_id_hash,
          request_hash, message_encrypted, user_agent_summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id(),
        row.id,
        action.type,
        action.requestId,
        anonymousHash,
        requestHash,
        encryptText(action.message, config.appSecret),
        (context.req.header('user-agent') ?? '').slice(0, 120),
        timestamp,
      );

      let nextState = row.state;
      let shouldNotify = action.type !== 'VIEW';
      if (action.type === 'VIEW') {
        const firstView = row.first_viewed_at === null;
        db.prepare(
          `UPDATE quote_versions SET
            first_viewed_at = COALESCE(first_viewed_at, ?), last_viewed_at = ?,
            view_count = view_count + 1, updated_at = ? WHERE id = ?`,
        ).run(timestamp, timestamp, timestamp, row.id);
        shouldNotify = firstView;
      } else if (action.type === 'ACCEPT') {
        nextState = 'ACCEPTED';
        db.prepare(
          `UPDATE quote_versions SET state = 'ACCEPTED', accepted_at = ?, updated_at = ?
           WHERE id = ? AND state = 'ACTIVE'`,
        ).run(timestamp, timestamp, row.id);
      } else if (action.type === 'CHANGE_REQUEST') {
        nextState = 'CHANGE_REQUESTED';
        db.prepare(
          `UPDATE quote_versions SET state = 'CHANGE_REQUESTED', updated_at = ?
           WHERE id = ? AND state = 'ACTIVE'`,
        ).run(timestamp, row.id);
      }

      if (shouldNotify) {
        const quote = db
          .prepare(
            `SELECT q.id, q.merchant_id, q.quote_number, q.customer_name, v.version_number
             FROM quotes q JOIN quote_versions v ON v.quote_id = q.id WHERE v.id = ?`,
          )
          .get(row.id);
        if (!quote) throw notFound('报价不存在');
        const label: Record<PublicActionType, string> = {
          VIEW: '客户首次查看',
          ACCEPT: '客户接受报价',
          QUESTION: '客户有问题',
          CHANGE_REQUEST: '客户申请修改',
        };
        db.prepare(
          `INSERT INTO notifications(
            id, merchant_id, quote_id, version_id, type, title, body, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id(),
          String(quote.merchant_id),
          String(quote.id),
          row.id,
          action.type,
          label[action.type],
          `${String(quote.quote_number)} V${String(quote.version_number)} · ${String(quote.customer_name)}`,
          timestamp,
        );
      }
      return { duplicate: false, state: nextState };
    });

    return context.json({ ok: true, ...result });
  });

  return app;
}
