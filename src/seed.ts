import type { Db } from "./db/db.js";

// Two fictional workspaces, so tenant isolation can be shown with real queries.
const WORKSPACES = [
  { id: "northwind", name: "Northwind Studio" },
  { id: "globex", name: "Globex Labs" },
];
const USERS = [
  { id: "maya", workspaceId: "northwind", name: "Maya" },
  { id: "arjun", workspaceId: "northwind", name: "Arjun" },
  { id: "lee", workspaceId: "globex", name: "Lee" },
];

export async function seed(db: Db): Promise<void> {
  for (const w of WORKSPACES) {
    await db.query(`insert into workspaces (id, name) values ($1, $2) on conflict (id) do nothing`, [w.id, w.name]);
  }
  for (const u of USERS) {
    await db.query(`insert into users (id, workspace_id, name) values ($1, $2, $3) on conflict (id) do nothing`, [
      u.id,
      u.workspaceId,
      u.name,
    ]);
  }
}
