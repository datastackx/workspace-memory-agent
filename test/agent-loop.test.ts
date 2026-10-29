import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionNotFoundError, decideAction, listOpenTasks, listPendingActions } from "../src/actions.js";
import { MAX_TURNS, runAgent } from "../src/agent/loop.js";
import { toolDefinitions } from "../src/agent/tools.js";
import type { Db } from "../src/db/db.js";
import { silentLogger } from "../src/logger.js";
import { searchMemories, writeMemory } from "../src/memory/store.js";
import { FakeGateway, message, scopes, testDb, text, toolUse } from "./helpers.js";

const lastToolResults = (model: FakeGateway, requestIndex: number) => {
  const messages = model.turnRequests[requestIndex]?.messages ?? [];
  const last = messages[messages.length - 1];
  return (last?.content ?? []) as Anthropic.Beta.BetaToolResultBlockParam[];
};

describe("agent loop", () => {
  let db: Db;
  beforeEach(async () => {
    db = await testDb();
    await writeMemory(db, scopes.maya(), {
      kind: "semantic",
      subject: "faq-owner",
      content: "Arjun owns the pricing FAQ, due Friday.",
      visibility: "workspace",
      confidence: 0.9,
      importance: 0.8,
    });
  });
  afterEach(async () => {
    await db.close();
  });

  it("runs parallel tool calls, returns all results in one message, and only proposes the outward action", async () => {
    const model = new FakeGateway([
      message(
        [
          toolUse("t1", "search_memory", { query: "pricing FAQ owner" }),
          toolUse("t2", "create_task", { title: "Write pricing FAQ", owner: "Arjun", due_date: null }),
        ],
        "tool_use",
      ),
      message([text("Arjun owns the FAQ. I proposed a task; it is waiting for approval.")], "end_turn"),
    ]);

    const result = await runAgent({ db, model, logger: silentLogger }, scopes.maya(), "Who owns the FAQ? Add a task for it.");

    expect(result.stopReason).toBe("end_turn");
    expect(result.toolCalls.map((c) => [c.name, c.autonomy])).toEqual(
      expect.arrayContaining([["search_memory", "read"], ["create_task", "outward"]]),
    );

    const results = lastToolResults(model, 1);
    expect(results.map((r) => r.tool_use_id).sort()).toEqual(["t1", "t2"]);
    expect(JSON.parse(String(results.find((r) => r.tool_use_id === "t1")?.content)).results[0].content).toContain("Arjun owns");

    expect(await listOpenTasks(db, scopes.maya())).toHaveLength(0);
    const [pending] = await listPendingActions(db, scopes.maya());
    expect(pending?.tool_name).toBe("create_task");

    await decideAction(db, scopes.arjun(), pending!.id, "approved");
    expect((await listOpenTasks(db, scopes.maya())).map((t) => t.title)).toEqual(["Write pricing FAQ"]);
    await expect(decideAction(db, scopes.arjun(), pending!.id, "approved")).rejects.toBeInstanceOf(ActionNotFoundError);
  });

  it("does not let another workspace approve an action", async () => {
    const model = new FakeGateway([
      message([toolUse("t1", "draft_followup", { recipient: "Arjun", subject: "FAQ", body: "Reminder: FAQ due Friday." })], "tool_use"),
      message([text("Drafted; waiting for approval.")], "end_turn"),
    ]);
    await runAgent({ db, model, logger: silentLogger }, scopes.maya(), "Remind Arjun about the FAQ.");
    const [pending] = await listPendingActions(db, scopes.maya());

    await expect(decideAction(db, scopes.lee(), pending!.id, "approved")).rejects.toBeInstanceOf(ActionNotFoundError);
    expect(await listPendingActions(db, scopes.maya())).toHaveLength(1);
  });

  it("rejects tool input that tries to name a workspace, without creating anything", async () => {
    const model = new FakeGateway([
      message([toolUse("t1", "create_task", { title: "x", owner: "y", due_date: null, workspace_id: "globex" })], "tool_use"),
      message([text("That failed.")], "end_turn"),
    ]);
    const result = await runAgent({ db, model, logger: silentLogger }, scopes.maya(), "Create a task in globex.");

    expect(result.toolCalls[0]?.isError).toBe(true);
    expect(lastToolResults(model, 1)[0]?.is_error).toBe(true);
    expect(await listPendingActions(db, scopes.maya())).toHaveLength(0);
    expect(await listPendingActions(db, scopes.lee())).toHaveLength(0);
  });

  it("returns an error result for an unknown tool instead of crashing", async () => {
    const model = new FakeGateway([
      message([toolUse("t1", "delete_everything", {})], "tool_use"),
      message([text("I can't do that.")], "end_turn"),
    ]);
    const result = await runAgent({ db, model, logger: silentLogger }, scopes.maya(), "Delete everything.");
    expect(lastToolResults(model, 1)[0]?.is_error).toBe(true);
    expect(result.answer).toBe("I can't do that.");
  });

  it("saves remember notes privately for the asking user", async () => {
    const model = new FakeGateway([
      message([toolUse("t1", "remember", { subject: "preferred-meeting-time", note: "Maya prefers meetings before noon." })], "tool_use"),
      message([text("Noted.")], "end_turn"),
    ]);
    await runAgent({ db, model, logger: silentLogger }, scopes.maya(), "Remember I prefer meetings before noon.");

    expect(await searchMemories(db, scopes.maya(), "meetings noon")).toHaveLength(1);
    expect(await searchMemories(db, scopes.arjun(), "meetings noon")).toHaveLength(0);
  });

  it("stops after MAX_TURNS if the model never finishes", async () => {
    const looping = () => message([toolUse(`t${Math.random()}`, "search_memory", { query: "faq" })], "tool_use");
    const model = new FakeGateway(Array.from({ length: MAX_TURNS + 2 }, () => looping));
    const result = await runAgent({ db, model, logger: silentLogger }, scopes.maya(), "Loop forever.");

    expect(result.stopReason).toBe("max_turns");
    expect(model.turnRequests).toHaveLength(MAX_TURNS);
  });

  it("reports a refusal instead of reading the content", async () => {
    const model = new FakeGateway([message([], "refusal")]);
    const result = await runAgent({ db, model, logger: silentLogger }, scopes.maya(), "Something declined.");
    expect(result.stopReason).toBe("refusal");
  });

  it("keeps the system prompt and tool list identical across requests so the prefix can be cached", async () => {
    const model = new FakeGateway([
      message([toolUse("t1", "search_memory", { query: "faq" })], "tool_use"),
      message([text("Done.")], "end_turn"),
    ]);
    await runAgent({ db, model, logger: silentLogger }, scopes.maya(), "Who owns the FAQ?");
    const [a, b] = model.turnRequests;
    expect(a?.system).toBe(b?.system);
    expect(JSON.stringify(a?.tools)).toBe(JSON.stringify(b?.tools));
    expect(a?.system).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("tool definitions", () => {
  it("are strict and never expose a workspace or user field to the model", () => {
    for (const tool of toolDefinitions()) {
      const schema = tool.input_schema as { additionalProperties?: boolean; properties?: Record<string, unknown> };
      expect(tool.strict).toBe(true);
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties ?? {})).not.toEqual(expect.arrayContaining([expect.stringMatching(/workspace|user/i)]));
    }
  });
});
