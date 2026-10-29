import { randomUUID } from "node:crypto";
import type { Db } from "./db/db.js";

/**
 * Who is acting, resolved by the server from the session. It is passed to every
 * query and tool. Tool schemas never contain a workspace or user field, so the
 * model has no way to name another tenant.
 */
export type Scope = {
  workspaceId: string;
  userId: string;
  correlationId: string;
};

export function newScope(workspaceId: string, userId: string): Scope {
  return { workspaceId, userId, correlationId: randomUUID() };
}

export async function audit(db: Db, scope: Scope, event: string, detail: Record<string, unknown> = {}): Promise<void> {
  await db.query(
    `insert into audit_log (workspace_id, user_id, correlation_id, event, detail) values ($1, $2, $3, $4, $5)`,
    [scope.workspaceId, scope.userId, scope.correlationId, event, JSON.stringify(detail)],
  );
}
