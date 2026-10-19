import type { FastifyInstance, FastifyRequest } from 'fastify';

import { workspaceGuard } from '../../plugins/auth.js';
import { ok } from '../../plugins/error-handler.js';
import { AppError } from '../../lib/errors.js';
import * as svc from './service.js';

type WsParams = { Params: { id: string } };

function ws(req: FastifyRequest) {
  return req.workspaceCtx!.workspace.id;
}

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 增量拉取：`GET /workspaces/:id/sync/changes?since=<seq>&limit=200`
   *
   * `since` 缺省时返回当前游标（客户端首次拿基线用，不返回历史变更）。
   */
  app.get<WsParams>('/workspaces/:id/sync/changes', { preHandler: workspaceGuard('MEMBER') }, async (req) => {
    const query = req.query as { since?: string; limit?: string };

    if (query.since === undefined) {
      return ok(req.id, { changes: [], cursor: await svc.latestSeq(ws(req)), hasMore: false });
    }

    let since: bigint;
    try {
      since = BigInt(query.since);
    } catch {
      throw AppError.validation([{ path: 'since', message: 'since 必须是一个整数游标' }]);
    }

    const limit = Math.min(Math.max(Number(query.limit ?? 200) || 200, 1), 500);
    return ok(req.id, await svc.listChanges(ws(req), since, limit));
  });
}
