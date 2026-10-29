// One schema, applied idempotently at startup. Rows are never hard-deleted:
// memories are superseded or expire, actions are approved or rejected.
export const SCHEMA_SQL = `
create table if not exists workspaces (
  id          text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists users (
  id            text primary key,
  workspace_id  text not null references workspaces(id),
  name          text not null,
  created_at    timestamptz not null default now()
);

create table if not exists meetings (
  id            text primary key,
  workspace_id  text not null references workspaces(id),
  title         text not null,
  transcript    text not null,
  created_by    text not null references users(id),
  created_at    timestamptz not null default now()
);

-- user_id null = visible to the whole workspace; set = private to that user.
create table if not exists memories (
  id                 text primary key,
  workspace_id       text not null references workspaces(id),
  user_id            text references users(id),
  kind               text not null check (kind in ('semantic', 'episodic')),
  subject            text not null,
  content            text not null,
  source_meeting_id  text references meetings(id),
  source_quote       text,
  confidence         real not null check (confidence >= 0 and confidence <= 1),
  importance         real not null check (importance >= 0 and importance <= 1),
  expires_at         timestamptz,
  superseded_by      text references memories(id),
  created_by         text not null references users(id),
  created_at         timestamptz not null default now(),
  search             tsvector generated always as (to_tsvector('english', subject || ' ' || content)) stored
);
create index if not exists memories_search_idx on memories using gin (search);
create index if not exists memories_active_subject_idx
  on memories (workspace_id, subject) where superseded_by is null;

create table if not exists pending_actions (
  id            text primary key,
  workspace_id  text not null references workspaces(id),
  requested_by  text not null references users(id),
  tool_name     text not null,
  payload       jsonb not null,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by    text references users(id),
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists tasks (
  id                 text primary key,
  workspace_id       text not null references workspaces(id),
  title              text not null,
  owner              text not null,
  due_date           text,
  pending_action_id  text not null references pending_actions(id),
  created_by         text not null references users(id),
  created_at         timestamptz not null default now()
);

-- Approved follow-ups land here for a sender to pick up; this repo never sends email.
create table if not exists outbox_messages (
  id                 text primary key,
  workspace_id       text not null references workspaces(id),
  recipient          text not null,
  subject            text not null,
  body               text not null,
  pending_action_id  text not null references pending_actions(id),
  created_by         text not null references users(id),
  created_at         timestamptz not null default now()
);

create table if not exists audit_log (
  id              bigserial primary key,
  workspace_id    text not null,
  user_id         text not null,
  correlation_id  text not null,
  event           text not null,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
`;
