# CLAUDE.md

Rules for Claude Code (and people) working in this repo. The spec is `spec/MEM-1.md`; its rules are the acceptance criteria.

## Commands

- `npm run typecheck` and `npm test` must pass before any commit. Tests need no API key.
- `npm run smoke` calls the real API (needs `ANTHROPIC_API_KEY` in `.env`).
- `npm run agent -- <command>` runs the CLI against `./.data/pg`.

## Invariants (do not break these)

1. Every read or write takes a `Scope`, and every SQL statement filters by `workspace_id` from it. Never add a workspace or user field to a tool schema.
2. Outward tools (`autonomy: "outward"`) never run in `executeTool`. They create a pending action; only `decideAction` applies one.
3. Memories are never deleted or updated in place, except setting `superseded_by`.
4. Extracted items without a verbatim quote are dropped.
5. Keep `AGENT_SYSTEM`, `EXTRACTION_SYSTEM` and the tool list free of dates, IDs or anything per-request. They are the cached prompt prefix; per-request context goes in the user turn.
6. The agent loop appends the full `response.content`, never only the text.

## How to change things

- New behaviour starts as a rule in the spec, then a failing test, then code.
- New tool: add it to `TOOLS` in `src/agent/tools.ts` with an explicit `autonomy`, a zod input, and a test that covers its autonomy.
- Model access goes through `ModelGateway` (`src/llm.ts`); tests use `FakeGateway`.
- Structured logs only (`src/logger.ts`, JSON on stderr). No secrets or transcript text in logs.
