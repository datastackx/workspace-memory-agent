# workspace-memory-agent

A small TypeScript agent built on the Claude API. It remembers what a team decided in its meetings, answers questions from that memory with a quote as evidence, and proposes tasks and follow-ups that a person approves before anything happens.

It is a reference implementation of four patterns: **tool calling with a manual loop**, **persistent memory scoped per workspace and per user in Postgres**, **approval as part of the tool contract**, and **treating meeting text as untrusted input**.

```
transcript ──► extract (structured output + zod) ──► quote check ──► memory (Postgres)
                                                    drop anything     workspace + user scope
                                                    not in the text   semantic | episodic, expiry, supersede

question ──► agent loop (Claude, manual tool use, max 8 turns)
               search_memory, list_tasks   read        runs now
               remember                    own space   runs now, private to the caller
               create_task, draft_followup outward     becomes a pending action ──► person approves
```

## Run it

Node 22.9 or later. No Docker: the default database is [PGlite](https://pglite.dev), real Postgres embedded in Node.

```bash
npm install
npm test                       # 18 tests, no API key needed

cp .env.example .env           # add ANTHROPIC_API_KEY
npm run agent -- seed
npm run agent -- ingest examples/transcripts/01-launch-sync.txt --title "Launch sync, week 1"
npm run agent -- ingest examples/transcripts/02-launch-sync.txt --title "Launch sync, week 2"
npm run agent -- ask "When does the pricing page launch, and why did it change?"
npm run agent -- ask "Add Arjun's FAQ as a task and draft him a reminder."
npm run agent -- pending
npm run agent -- approve <id> --as arjun
npm run agent -- memories --as lee   # another workspace: sees nothing
```

`npm run smoke` runs the whole flow, including the prompt-injection transcript, against a throwaway in-memory database. Set `DATABASE_URL` to use a Postgres server instead of PGlite.

## How it works

### Scope comes from the server, not the model
`src/scope.ts`, `src/cli.ts` (`resolveScope`)

The workspace is resolved from the user's membership row and passed to every query and tool. Tool schemas have no workspace or user field, and inputs are parsed with `strict()`, so a tool call that names another workspace is rejected. Every memory query goes through one filter: same workspace, and either shared or owned by the caller.

### Memory: grounded, versioned, expiring
`src/memory/extract.ts`, `src/memory/store.ts`

- **Extraction** uses structured outputs (`messages.parse` with a zod schema). Each item has a kind, a stable `subject` key, one sentence of content and a **verbatim quote**. Code checks the quote is really in the transcript and drops the item if not. That catches made-up facts before they are stored.
- **Two kinds of memory.** Semantic memory (decisions, facts, action items, preferences) and episodic memory (one summary per meeting). Summaries expire after 180 days, action items after 90.
- **Supersede, never overwrite.** A new memory with an existing subject replaces the old one. The old row stays and points at its replacement, so history is auditable and search returns only the current version. Identical content is a no-op.
- **Retrieval** is Postgres full-text search ranked by relevance (60%), importance (25%) and recency (15%). Query text is reduced to plain terms, so it cannot inject tsquery operators. Vector search would slot in at `searchMemories`; full-text keeps the demo free of an embeddings dependency.
- **Private notes.** `remember` writes memory visible only to the caller.

### Autonomy is part of each tool's contract
`src/agent/tools.ts`, `src/actions.ts`

Each tool declares `read`, `own_space` or `outward`. Outward tools never run inside the loop: they insert a `pending_actions` row and tell the model it is waiting for approval. `decideAction` is the only way one takes effect, in the same workspace, recording who decided and when. Approved follow-ups land in an outbox table; nothing is ever sent from here. The guarantee does not depend on the model behaving.

### The loop
`src/agent/loop.ts`

A manual tool-use loop rather than the SDK's tool runner, so every step is visible:
- appends the full `response.content` each turn (text, thinking, tool_use), not just the text;
- runs all tool calls from one turn concurrently and returns every result in **one** user message;
- validates tool input itself and returns bad input or unknown tools as `is_error` results;
- handles `refusal`, `pause_turn` and `max_tokens`, and stops after 8 turns.

### Untrusted input
`EXTRACTION_SYSTEM`, `buildExtractionPrompt`

Transcripts are wrapped in `<transcript>` tags and a transcript cannot close its own tag. Both prompts say embedded instructions are data. `examples/transcripts/03-injection-attempt.txt` contains a fake "SYSTEM OVERRIDE". If a model were fooled anyway, the worst it could do is create a pending action that a person rejects.

### Model access
`src/llm.ts`

One `ModelGateway` interface with two methods, `runTurn` and `extract`. `ClaudeGateway` uses `@anthropic-ai/sdk` directly with:
- `claude-opus-5-5` by default (`AGENT_MODEL` to change), with effort set explicitly;
- **server-side fallback** (`fallbacks: "default"`): if the model declines a request for policy reasons, the API retries on a recommended substitute inside the same call;
- a **cache breakpoint on the system prompt**, so the tools and system prompt form a stable prefix. Nothing per-request goes in it; who is asking and today's date go in the user turn. In the smoke run, repeat calls read 788–1,231 tokens from cache (`cacheReadTokens` in the logs).

Token usage, cache hits and stop reasons are logged as JSON lines on stderr with a correlation ID. Every write also goes to an `audit_log` table.

## Tests

`npm test` runs 18 tests against in-memory Postgres and a scripted `FakeGateway`, with no network. They cover:
- workspace isolation, private notes, and approvals across workspaces;
- supersede, no-op and expiry behaviour;
- quote checks and the transcript tag escape;
- parallel tool results in a single message, bad input, unknown tools, the turn limit and refusals;
- a stable cache prefix and strict tool schemas.

These tests prove the rules hold whatever the model does. They do not measure answer quality; that would need an eval set run against a live model, which is out of scope here.

## Layout

```
spec/MEM-1.md          the spec: rules (acceptance criteria) and slices
CLAUDE.md              invariants for Claude Code and contributors
src/db/                schema and the Db interface (PGlite or node-postgres)
src/memory/            extraction and the memory store
src/agent/             tools and the loop
src/actions.ts         pending actions: list, approve, reject
src/llm.ts             ModelGateway and the Claude implementation
test/                  vitest suites and the scripted FakeGateway
examples/transcripts/  fictional meetings, including an injection attempt
```

## Not in scope

Vector search, a web UI, auth, sending email, multi-turn chat history, and live-model evals. All names and data are fictional.

Built by Deepak at [DataStackX](https://datastackx.com) with Claude Code. MIT licence.
