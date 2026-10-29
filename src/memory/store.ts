import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";
import { audit, type Scope } from "../scope.js";

export type MemoryKind = "semantic" | "episodic";
export type Visibility = "workspace" | "private";

export type NewMemory = {
  kind: MemoryKind;
  subject: string;
  content: string;
  visibility: Visibility;
  confidence: number;
  importance: number;
  ttlDays?: number;
  sourceMeetingId?: string;
  sourceQuote?: string;
};

export type Memory = {
  id: string;
  kind: MemoryKind;
  subject: string;
  content: string;
  visibility: Visibility;
  confidence: number;
  source_meeting_id: string | null;
  source_quote: string | null;
  created_at: string;
  score?: number;
};

export type WriteOutcome = { id: string; action: "created" | "superseded" | "unchanged" };

// Ranking weights for search: text relevance first, then importance, then recency.
const RELEVANCE_WEIGHT = 0.6;
const IMPORTANCE_WEIGHT = 0.25;
const RECENCY_WEIGHT = 0.15;
const RECENCY_HALF_LIFE_DAYS = 30;
const MIN_QUERY_TERM_LENGTH = 3;
export const DEFAULT_SEARCH_LIMIT = 5;

// A memory is "active" when nothing has replaced it and it has not expired.
const ACTIVE = `superseded_by is null and (expires_at is null or expires_at > now())`;
// The scope filter every read goes through: same workspace, and either shared or owned by this user.
const VISIBLE_TO_SCOPE = `workspace_id = $1 and (user_id is null or user_id = $2)`;

const SELECT_COLUMNS = `id, kind, subject, content,
  case when user_id is null then 'workspace' else 'private' end as visibility,
  confidence, source_meeting_id, source_quote, created_at`;

/**
 * Writes a memory. A newer memory with the same subject replaces the old one
 * (the old row is kept and points at its replacement); identical content is a no-op.
 */
export async function writeMemory(db: Db, scope: Scope, input: NewMemory): Promise<WriteOutcome> {
  const ownerId = input.visibility === "private" ? scope.userId : null;
  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx.query<{ id: string; content: string }>(
      `select id, content from memories
        where workspace_id = $1 and user_id is not distinct from $2 and subject = $3 and ${ACTIVE}
        order by created_at desc limit 1`,
      [scope.workspaceId, ownerId, input.subject],
    );
    if (current && normalise(current.content) === normalise(input.content)) {
      return { id: current.id, action: "unchanged" } as const;
    }

    const id = randomUUID();
    await tx.query(
      `insert into memories (id, workspace_id, user_id, kind, subject, content, source_meeting_id, source_quote,
                             confidence, importance, expires_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               case when $11::int is null then null else now() + make_interval(days => $11::int) end, $12)`,
      [
        id,
        scope.workspaceId,
        ownerId,
        input.kind,
        input.subject,
        input.content,
        input.sourceMeetingId ?? null,
        input.sourceQuote ?? null,
        input.confidence,
        input.importance,
        input.ttlDays ?? null,
        scope.userId,
      ],
    );
    if (current) {
      await tx.query(`update memories set superseded_by = $1 where id = $2`, [id, current.id]);
      return { id, action: "superseded" } as const;
    }
    return { id, action: "created" } as const;
  });
  await audit(db, scope, "memory.write", { memoryId: outcome.id, action: outcome.action, subject: input.subject });
  return outcome;
}

/** Full-text search over active memories this user can see, ranked by relevance, importance and recency. */
export async function searchMemories(db: Db, scope: Scope, query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<Memory[]> {
  const tsQuery = toOrQuery(query);
  if (!tsQuery) return listMemories(db, scope, limit);

  return db.query<Memory>(
    `select ${SELECT_COLUMNS},
            ( ts_rank(search, to_tsquery('english', $3)) * ${RELEVANCE_WEIGHT}
            + importance * ${IMPORTANCE_WEIGHT}
            + (1.0 / (1 + extract(epoch from now() - created_at) / 86400 / ${RECENCY_HALF_LIFE_DAYS})) * ${RECENCY_WEIGHT}
            ) as score
       from memories
      where ${VISIBLE_TO_SCOPE} and ${ACTIVE} and search @@ to_tsquery('english', $3)
      order by score desc
      limit $4`,
    [scope.workspaceId, scope.userId, tsQuery, limit],
  );
}

export async function listMemories(db: Db, scope: Scope, limit = 50): Promise<Memory[]> {
  return db.query<Memory>(
    `select ${SELECT_COLUMNS} from memories
      where ${VISIBLE_TO_SCOPE} and ${ACTIVE}
      order by importance desc, created_at desc
      limit $3`,
    [scope.workspaceId, scope.userId, limit],
  );
}

/**
 * Turns free text into an OR tsquery. Only [a-z0-9] terms survive, so user or
 * model text can never inject tsquery operators.
 */
function toOrQuery(text: string): string | null {
  const terms = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= MIN_QUERY_TERM_LENGTH);
  return terms.length > 0 ? [...new Set(terms)].join(" | ") : null;
}

function normalise(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
