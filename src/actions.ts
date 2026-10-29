import { randomUUID } from "node:crypto";
import type { Db } from "./db/db.js";
import { audit, type Scope } from "./scope.js";

export type PendingAction = {
  id: string;
  tool_name: string;
  payload: Record<string, unknown>;
  requested_by: string;
  created_at: string;
};

export class ActionNotFoundError extends Error {
  constructor(id: string) {
    super(`No pending action ${id} in this workspace.`);
  }
}

export async function listPendingActions(db: Db, scope: Scope): Promise<PendingAction[]> {
  return db.query<PendingAction>(
    `select id, tool_name, payload, requested_by, created_at from pending_actions
      where workspace_id = $1 and status = 'pending' order by created_at`,
    [scope.workspaceId],
  );
}

export async function listOpenTasks(db: Db, scope: Scope) {
  return db.query<{ id: string; title: string; owner: string; due_date: string | null }>(
    `select id, title, owner, due_date from tasks where workspace_id = $1 order by created_at`,
    [scope.workspaceId],
  );
}

/** The only path by which an outward action takes effect: a human decision, recorded with who and when. */
export async function decideAction(db: Db, scope: Scope, id: string, decision: "approved" | "rejected"): Promise<PendingAction> {
  const action = await db.transaction(async (tx) => {
    const [row] = await tx.query<PendingAction>(
      `update pending_actions set status = $3, decided_by = $4, decided_at = now()
        where id = $1 and workspace_id = $2 and status = 'pending'
        returning id, tool_name, payload, requested_by, created_at`,
      [id, scope.workspaceId, decision, scope.userId],
    );
    if (!row) throw new ActionNotFoundError(id);
    if (decision === "approved") await applyAction(tx, scope, row);
    return row;
  });
  await audit(db, scope, `action.${decision}`, { pendingActionId: id, tool: action.tool_name });
  return action;
}

async function applyAction(db: Db, scope: Scope, action: PendingAction): Promise<void> {
  const p = action.payload;
  if (action.tool_name === "create_task") {
    await db.query(
      `insert into tasks (id, workspace_id, title, owner, due_date, pending_action_id, created_by) values ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), scope.workspaceId, p.title, p.owner, p.due_date ?? null, action.id, scope.userId],
    );
    return;
  }
  if (action.tool_name === "draft_followup") {
    await db.query(
      `insert into outbox_messages (id, workspace_id, recipient, subject, body, pending_action_id, created_by) values ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), scope.workspaceId, p.recipient, p.subject, p.body, action.id, scope.userId],
    );
    return;
  }
  throw new Error(`No handler for approved action ${action.tool_name}.`);
}
