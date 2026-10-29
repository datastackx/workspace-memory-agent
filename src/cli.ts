import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { decideAction, listPendingActions } from "./actions.js";
import { runAgent } from "./agent/loop.js";
import { openDb, type Db } from "./db/db.js";
import { ClaudeGateway } from "./llm.js";
import { createLogger } from "./logger.js";
import { ingestMeeting } from "./memory/extract.js";
import { listMemories } from "./memory/store.js";
import { newScope, type Scope } from "./scope.js";
import { seed } from "./seed.js";

const USAGE = `Usage: npm run agent -- <command> [--as <user>]

  seed                          create the demo workspaces and users
  ingest <file> [--title t]     store a meeting transcript and extract memory from it
  ask "<question>"              ask the agent (it can search memory and propose actions)
  memories                      list the memories this user can see
  pending                       list actions waiting for approval
  approve <id> | reject <id>    decide a pending action

Users: maya, arjun (workspace "northwind"), lee (workspace "globex"). Default: maya.`;

const out = (line = "") => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { as: { type: "string", default: "maya" }, title: { type: "string" } },
  });
  const [command, arg] = positionals;
  if (!command) {
    out(USAGE);
    return;
  }

  const db = await openDb({ databaseUrl: process.env.DATABASE_URL });
  try {
    if (command === "seed") {
      await seed(db);
      out("Seeded workspaces northwind (maya, arjun) and globex (lee).");
      return;
    }

    const scope = await resolveScope(db, values.as);
    const logger = createLogger({ correlationId: scope.correlationId, userId: scope.userId });

    switch (command) {
      case "ingest": {
        if (!arg) throw new Error("ingest needs a transcript file path.");
        const transcript = await readFile(arg, "utf8");
        const result = await ingestMeeting({ db, model: new ClaudeGateway(logger), logger }, scope, {
          title: values.title ?? basename(arg),
          transcript,
        });
        out(`Meeting ${result.meetingId}`);
        for (const w of result.written) out(`  ${w.action.padEnd(10)} ${w.subject}`);
        for (const d of result.dropped) out(`  dropped    ${d.subject} (${d.reason})`);
        return;
      }
      case "ask": {
        if (!arg) throw new Error('ask needs a question in quotes.');
        const result = await runAgent({ db, model: new ClaudeGateway(logger), logger }, scope, arg);
        for (const call of result.toolCalls) {
          out(`  [${call.autonomy ?? "?"}] ${call.name} ${JSON.stringify(call.input)}${call.isError ? "  (error)" : ""}`);
        }
        out();
        out(result.answer);
        return;
      }
      case "memories": {
        for (const m of await listMemories(db, scope)) {
          out(`- [${m.visibility}/${m.kind}] ${m.subject}: ${m.content}`);
          if (m.source_quote) out(`    "${m.source_quote}"`);
        }
        return;
      }
      case "pending": {
        const actions = await listPendingActions(db, scope);
        if (actions.length === 0) out("Nothing waiting for approval.");
        for (const a of actions) out(`${a.id}  ${a.tool_name}  ${JSON.stringify(a.payload)}  (requested by ${a.requested_by})`);
        return;
      }
      case "approve":
      case "reject": {
        if (!arg) throw new Error(`${command} needs a pending action id.`);
        const action = await decideAction(db, scope, arg, command === "approve" ? "approved" : "rejected");
        out(`${command === "approve" ? "Approved" : "Rejected"} ${action.tool_name} ${action.id}.`);
        return;
      }
      default:
        out(USAGE);
    }
  } finally {
    await db.close();
  }
}

/** The workspace comes from the user's membership row, never from user or model input. */
async function resolveScope(db: Db, userId: string): Promise<Scope> {
  const [row] = await db.query<{ workspace_id: string }>(`select workspace_id from users where id = $1`, [userId]);
  if (!row) throw new Error(`Unknown user "${userId}". Run "npm run agent -- seed" first.`);
  return newScope(row.workspace_id, userId);
}

main().catch((err: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: "error", event: "cli.failed", message: err instanceof Error ? err.message : String(err) })}\n`);
  process.exitCode = 1;
});
