import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.js";
import { listMemories, searchMemories, writeMemory, type NewMemory } from "../src/memory/store.js";
import { scopes, testDb } from "./helpers.js";

const fact = (overrides: Partial<NewMemory> = {}): NewMemory => ({
  kind: "semantic",
  subject: "pricing-page-launch-date",
  content: "The pricing page launches on 14 November.",
  visibility: "workspace",
  confidence: 0.9,
  importance: 0.9,
  ...overrides,
});

describe("memory store", () => {
  let db: Db;
  beforeEach(async () => {
    db = await testDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("supersedes a memory when the same subject gets new content, and keeps only the new one active", async () => {
    const first = await writeMemory(db, scopes.maya(), fact());
    const second = await writeMemory(db, scopes.maya(), fact({ content: "The pricing page launch moved to 21 November." }));

    expect(first.action).toBe("created");
    expect(second.action).toBe("superseded");
    const results = await searchMemories(db, scopes.arjun(), "pricing page launch");
    expect(results.map((m) => m.content)).toEqual(["The pricing page launch moved to 21 November."]);

    const [old] = await db.query<{ superseded_by: string }>(`select superseded_by from memories where id = $1`, [first.id]);
    expect(old?.superseded_by).toBe(second.id);
  });

  it("treats identical content as unchanged instead of writing a duplicate", async () => {
    await writeMemory(db, scopes.maya(), fact());
    const again = await writeMemory(db, scopes.maya(), fact({ content: "  the pricing page launches on 14 november. " }));
    expect(again.action).toBe("unchanged");
    expect(await listMemories(db, scopes.maya())).toHaveLength(1);
  });

  it("stops returning a memory once it has expired", async () => {
    const { id } = await writeMemory(db, scopes.maya(), fact({ kind: "episodic", ttlDays: 180 }));
    expect(await searchMemories(db, scopes.maya(), "pricing")).toHaveLength(1);

    await db.query(`update memories set expires_at = now() - interval '1 day' where id = $1`, [id]);
    expect(await searchMemories(db, scopes.maya(), "pricing")).toHaveLength(0);
  });

  it("keeps private memories private to their owner", async () => {
    await writeMemory(db, scopes.maya(), fact({ subject: "preferred-meeting-time", content: "Maya prefers meetings before noon.", visibility: "private" }));
    expect(await searchMemories(db, scopes.maya(), "meetings noon")).toHaveLength(1);
    expect(await searchMemories(db, scopes.arjun(), "meetings noon")).toHaveLength(0);
  });

  it("never returns another workspace's memories", async () => {
    await writeMemory(db, scopes.maya(), fact());
    expect(await searchMemories(db, scopes.lee(), "pricing page launch")).toHaveLength(0);
    expect(await listMemories(db, scopes.lee())).toHaveLength(0);
  });

  it("strips tsquery operators from search text", async () => {
    await writeMemory(db, scopes.maya(), fact());
    await expect(searchMemories(db, scopes.maya(), "pricing & | ! :* ( launch")).resolves.toHaveLength(1);
  });
});
