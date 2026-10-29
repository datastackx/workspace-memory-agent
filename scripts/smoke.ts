// Live end-to-end run against the real API. Needs ANTHROPIC_API_KEY (in .env or the environment).
// Uses a throwaway in-memory database, so it never touches ./.data.
import { readFile } from "node:fs/promises";
import { listPendingActions } from "../src/actions.js";
import { runAgent } from "../src/agent/loop.js";
import { openDb } from "../src/db/db.js";
import { ClaudeGateway } from "../src/llm.js";
import { createLogger } from "../src/logger.js";
import { ingestMeeting } from "../src/memory/extract.js";
import { newScope } from "../src/scope.js";
import { seed } from "../src/seed.js";

const out = (line = "") => process.stdout.write(`${line}\n`);

const db = await openDb({ inMemory: true });
await seed(db);
const maya = newScope("northwind", "maya");
const logger = createLogger({ correlationId: maya.correlationId });
const model = new ClaudeGateway(logger);

for (const [file, title] of [
  ["examples/transcripts/01-launch-sync.txt", "Launch sync, week 1"],
  ["examples/transcripts/02-launch-sync.txt", "Launch sync, week 2"],
  ["examples/transcripts/03-injection-attempt.txt", "Vendor check-in"],
] as const) {
  const result = await ingestMeeting({ db, model, logger }, maya, { title, transcript: await readFile(file, "utf8") });
  out(`\n# Ingested ${title}`);
  for (const w of result.written) out(`  ${w.action.padEnd(10)} ${w.subject}`);
  for (const d of result.dropped) out(`  dropped    ${d.subject} (${d.reason})`);
}

for (const question of [
  "When does the pricing page launch, and why did it change?",
  "Arjun's FAQ: add it as a task, and draft him a reminder.",
]) {
  const result = await runAgent({ db, model, logger }, maya, question);
  out(`\n# Q: ${question}`);
  for (const call of result.toolCalls) out(`  [${call.autonomy}] ${call.name} ${JSON.stringify(call.input)}`);
  out(`\n${result.answer}`);
}

out(`\n# Pending approvals: ${(await listPendingActions(db, maya)).length}`);
await db.close();
