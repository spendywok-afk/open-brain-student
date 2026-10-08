-- ============================================================================
-- LEVEL 6 — CONNECT: everything run in the Supabase SQL Editor this level
-- ============================================================================
-- A record, so this repo holds the complete recipe for the database. Every
-- statement is safe to run again (if not exists / create or replace / drop
-- policy if exists), in this order.
-- ============================================================================


-- ── Step 0: refuse duplicate thoughts ───────────────────────────────────────
-- dedup_key is set to md5(content) by the trigger on every save. The unique
-- index makes the database itself refuse a second copy; the code saves with
-- .upsert(..., { onConflict: 'dedup_key,user_id' }) so a repeat updates the
-- existing row instead of failing.

alter table thoughts
  add column if not exists content_hash text generated always as (md5(content)) stored;

alter table thoughts add column if not exists dedup_key text;

create or replace function thoughts_set_dedup_key()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' then
    if new.dedup_key is null then
      new.dedup_key := md5(new.content);
    end if;
  elsif TG_OP = 'UPDATE' and new.content is distinct from old.content then
    if old.dedup_key = md5(old.content) then
      new.dedup_key := md5(new.content);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_thoughts_set_dedup_key on thoughts;
create trigger trg_thoughts_set_dedup_key
  before insert or update of content on thoughts
  for each row execute function thoughts_set_dedup_key();

update thoughts set dedup_key = md5(content) where dedup_key is null;

create unique index if not exists idx_thoughts_dedup_key
  on thoughts (dedup_key, user_id) nulls not distinct;


-- ── Step 1: pgvector ────────────────────────────────────────────────────────

create extension if not exists vector;


-- ── Step 2: the embedding column + nearest-neighbour index ──────────────────
-- 1,536 numbers per thought (openai/text-embedding-3-small). Changing to a
-- model with a different size needs a new migration.

alter table thoughts
  add column if not exists embedding vector(1536);

create index if not exists idx_thoughts_embedding
  on thoughts using hnsw (embedding vector_cosine_ops);


-- ── Step 6: search by meaning ───────────────────────────────────────────────
-- p_user_id: the MCP server calls this with the service role key, which skips
-- row-level security, so the owner filter is passed by hand.

create or replace function search_thoughts(
  query_embedding vector(1536),
  p_user_id uuid,
  match_threshold float default 0.3,
  match_count int default 10
)
returns table (
  id uuid,
  content text,
  created_at timestamptz,
  metadata jsonb,
  similarity float
)
language plpgsql
as $$
begin
  return query
    select
      t.id,
      t.content,
      t.created_at,
      t.metadata,
      (1 - (t.embedding <=> query_embedding))::float as similarity
    from thoughts t
    where t.embedding is not null
      and t.user_id = p_user_id
      and (1 - (t.embedding <=> query_embedding)) > match_threshold
    order by t.embedding <=> query_embedding
    limit match_count;
end;
$$;


-- ── Step 8: the thought graph ───────────────────────────────────────────────

create table if not exists thought_links (
  id uuid default gen_random_uuid() primary key,
  source_thought_id uuid not null references thoughts(id) on delete cascade,
  target_thought_id uuid not null references thoughts(id) on delete cascade,
  similarity_score float not null,
  link_type text not null default 'semantic',
  created_at timestamptz default now()
);

alter table thought_links add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- No exact duplicates (A→B twice)
create unique index if not exists idx_thought_links_pair
  on thought_links(source_thought_id, target_thought_id);

-- No reverse duplicates (B→A when A→B exists)
create unique index if not exists idx_thought_links_canonical
  on thought_links (
    least(source_thought_id::text, target_thought_id::text),
    greatest(source_thought_id::text, target_thought_id::text)
  );

create index if not exists idx_thought_links_source
  on thought_links(source_thought_id);
create index if not exists idx_thought_links_target
  on thought_links(target_thought_id);
create index if not exists idx_thought_links_user
  on thought_links(user_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'no_self_links'
  ) then
    alter table thought_links
      add constraint no_self_links
      check (source_thought_id != target_thought_id);
  end if;
end $$;

alter table thought_links enable row level security;

drop policy if exists "own_links_select" on thought_links;
create policy "own_links_select" on thought_links
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "own_links_insert" on thought_links;
create policy "own_links_insert" on thought_links
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "own_links_delete" on thought_links;
create policy "own_links_delete" on thought_links
  for delete to authenticated
  using (auth.uid() = user_id);


-- ── Step 9: find a thought's nearest neighbours ─────────────────────────────
-- volatile: always reads live data, so it sees the thought saved a moment ago.
-- p_user_id: called with the service role key — the owner filter is by hand.

create or replace function find_links_for_thought(
  source_id uuid,
  source_embedding vector(1536),
  p_user_id uuid,
  match_threshold float default 0.5,
  match_count int default 5
)
returns table (
  target_id uuid,
  similarity float
)
language plpgsql
volatile
as $$
begin
  return query
    select
      t.id as target_id,
      (1 - (t.embedding <=> source_embedding))::float as similarity
    from thoughts t
    where t.id != source_id
      and t.user_id = p_user_id
      and t.embedding is not null
      and (1 - (t.embedding <=> source_embedding)) > match_threshold
    order by t.embedding <=> source_embedding
    limit match_count;
end;
$$;
