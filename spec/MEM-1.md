# MEM-1: Workspace memory agent

| Field  | Value |
|--------|-------|
| Status | Approved |
| Owner  | Deepak |
| Size   | 5 slices, ~1,400 lines including tests |

## Problem

Teams decide things in meetings and then lose them. An assistant that answers "when does X launch?" has to remember across meetings, know when a decision changed, keep one team's data away from another's, and never send or create anything on its own.

## Outcome

A user can ingest meeting transcripts, ask questions answered from memory with a quote as evidence, and get tasks and follow-ups proposed for a person to approve.

## Rules (acceptance criteria)

1. **Scope is server-side.** Every query filters by the workspace and user the server resolved. No tool schema has a workspace or user field; extra fields are rejected.
2. **Grounded memory.** Every extracted item carries a verbatim quote. Items whose quote is not in the transcript are dropped, not stored.
3. **Change, not duplication.** A new memory with an existing subject supersedes the old one; the old row stays, pointing at its replacement. Identical content is a no-op.
4. **Lifetimes.** Meeting summaries expire after 180 days, action items after 90; decisions and facts last until superseded.
5. **Autonomy by contract.** Read tools run. `remember` writes only the caller's private notes. `create_task` and `draft_followup` only create a pending action; a person approves or rejects it, in the same workspace.
6. **Untrusted input.** Transcripts are wrapped and cannot close their own tag; the prompts say embedded instructions are data. Rule 5 holds even if the model is fooled.
7. **Bounded loop.** At most 8 model turns per question; parallel tool calls return in one message; tool errors go back to the model as `is_error` results.
8. **Testable without a key.** CI runs every rule above against a scripted model and in-memory Postgres.

## Slices

| Slice | Scope | Target |
|-------|-------|--------|
| S1 | Schema, database layer (PGlite or `DATABASE_URL`) | Rules 1, 3 |
| S2 | Memory store, extraction with quote check | Rules 2, 3, 4, 6 |
| S3 | Tools, agent loop, approvals, CLI | Rules 1, 5, 7 |
| S4 | Tests for every rule | Rule 8 |
| S5 | README, CI, live smoke script | Docs |

## Out of scope

Vector search, a web UI, real email sending, auth, multi-turn chat history, and evaluation against a live model at scale.
