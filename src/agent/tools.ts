import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "../db/db.js";
import { listOpenTasks } from "../actions.js";
import { searchMemories, writeMemory } from "../memory/store.js";
import { audit, type Scope } from "../scope.js";

/**
 * Autonomy is part of each tool's contract, not a prompt instruction:
 *  - "read": runs immediately, changes nothing.
 *  - "own_space": runs immediately, changes only the caller's private data.
 *  - "outward": never runs here; it becomes a pending action a human approves.
 */
export type Autonomy = "read" | "own_space" | "outward";

type ToolSpec<Input extends z.ZodType> = {
  name: string;
  description: string;
  autonomy: Autonomy;
  input: Input;
  run: (db: Db, scope: Scope, input: z.infer<Input>) => Promise<Record<string, unknown>>;
};

const PRIVATE_NOTE_IMPORTANCE = 0.7;
const PRIVATE_NOTE_CONFIDENCE = 1;

const searchMemory: ToolSpec<z.ZodObject<{ query: z.ZodString }>> = {
  name: "search_memory",
  description:
    "Search the team's memory (decisions, action items, facts, meeting summaries) and the current user's private notes. Use short keyword queries. Returns each memory with the meeting quote it came from.",
  autonomy: "read",
  input: z.object({ query: z.string().describe("Keywords, e.g. 'pricing page launch date'.") }),
  run: async (db, scope, { query }) => {
    const memories = await searchMemories(db, scope, query);
    return {
      results: memories.map((m) => ({
        id: m.id,
        kind: m.kind,
        visibility: m.visibility,
        subject: m.subject,
        content: m.content,
        source_quote: m.source_quote,
        recorded_at: m.created_at,
      })),
    };
  },
};

const listTasks: ToolSpec<z.ZodObject<Record<string, never>>> = {
  name: "list_tasks",
  description: "List tasks that have already been approved and created for this workspace.",
  autonomy: "read",
  input: z.object({}),
  run: async (db, scope) => ({ tasks: await listOpenTasks(db, scope) }),
};

const remember: ToolSpec<z.ZodObject<{ subject: z.ZodString; note: z.ZodString }>> = {
  name: "remember",
  description:
    "Save a private note or preference for the current user only (other teammates never see it). Use when the user asks you to remember something about themselves.",
  autonomy: "own_space",
  input: z.object({
    subject: z.string().describe("Stable lowercase-hyphenated key, e.g. 'preferred-meeting-time'."),
    note: z.string().describe("The note, as one sentence."),
  }),
  run: async (db, scope, { subject, note }) => {
    const outcome = await writeMemory(db, scope, {
      kind: "semantic",
      subject,
      content: note,
      visibility: "private",
      confidence: PRIVATE_NOTE_CONFIDENCE,
      importance: PRIVATE_NOTE_IMPORTANCE,
    });
    return { saved: true, ...outcome };
  },
};

const createTask: ToolSpec<z.ZodObject<{ title: z.ZodString; owner: z.ZodString; due_date: z.ZodNullable<z.ZodString> }>> = {
  name: "create_task",
  description:
    "Propose a task for the team tracker. This does not create it: a person must approve it first. Tell the user it is waiting for approval.",
  autonomy: "outward",
  input: z.object({
    title: z.string(),
    owner: z.string().describe("Name of the person responsible."),
    due_date: z.string().nullable().describe("ISO date (YYYY-MM-DD) if one was agreed, otherwise null."),
  }),
  run: async () => {
    throw new Error("outward tools are never run directly");
  },
};

const draftFollowup: ToolSpec<z.ZodObject<{ recipient: z.ZodString; subject: z.ZodString; body: z.ZodString }>> = {
  name: "draft_followup",
  description:
    "Draft a follow-up message to a person. Nothing is sent: a person must approve it first. Tell the user it is waiting for approval.",
  autonomy: "outward",
  input: z.object({
    recipient: z.string().describe("Name of the person the message is for."),
    subject: z.string(),
    body: z.string(),
  }),
  run: async () => {
    throw new Error("outward tools are never run directly");
  },
};

// Order matters: the tool list is part of the cached prompt prefix, so keep it stable.
const TOOLS = [searchMemory, listTasks, remember, createTask, draftFollowup] as const;
type AnyTool = (typeof TOOLS)[number];

export function toolDefinitions(): Anthropic.Beta.BetaTool[] {
  return TOOLS.map((tool) => {
    // zod emits additionalProperties: false and lists every field as required, which strict mode needs.
    const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input, { target: "draft-7" });
    return {
      name: tool.name,
      description: tool.description,
      strict: true,
      input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
    };
  });
}

export type ToolOutcome = { content: Record<string, unknown>; isError: boolean; autonomy?: Autonomy };

/**
 * Runs one tool call. Input is validated here (a manual loop gets no SDK validation),
 * scope comes from the caller, and outward tools only ever create a pending action.
 */
export async function executeTool(db: Db, scope: Scope, name: string, rawInput: unknown): Promise<ToolOutcome> {
  const tool = TOOLS.find((t) => t.name === name) as AnyTool | undefined;
  if (!tool) {
    return { content: { error: `Unknown tool "${name}".` }, isError: true };
  }
  const parsed = tool.input.strict().safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return { content: { error: "Invalid input.", issues }, isError: true, autonomy: tool.autonomy };
  }

  if (tool.autonomy === "outward") {
    const pendingActionId = randomUUID();
    await db.query(
      `insert into pending_actions (id, workspace_id, requested_by, tool_name, payload) values ($1, $2, $3, $4, $5)`,
      [pendingActionId, scope.workspaceId, scope.userId, tool.name, JSON.stringify(parsed.data)],
    );
    await audit(db, scope, "action.proposed", { pendingActionId, tool: tool.name });
    return {
      content: { status: "pending_approval", pending_action_id: pendingActionId, note: "Not done yet. A person must approve it." },
      isError: false,
      autonomy: tool.autonomy,
    };
  }

  const run = tool.run as (db: Db, scope: Scope, input: unknown) => Promise<Record<string, unknown>>;
  return { content: await run(db, scope, parsed.data), isError: false, autonomy: tool.autonomy };
}
