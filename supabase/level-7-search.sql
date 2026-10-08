-- ============================================================================
-- LEVEL 7 — SEARCH: everything run in the Supabase SQL Editor this level
-- ============================================================================
-- A record, so this repo holds the complete recipe for the database. Every
-- statement is safe to run again, in this order.
-- ============================================================================


-- ── Step 1: chunks + keyword search columns ─────────────────────────────────
-- Long thoughts (> 2,000 chars) are split into ~300-word overlapping pieces,
-- each with its own embedding. The thought keeps its own whole-document
-- embedding too — chunks are added, never a replacement.

create table if not exists thought_chunks (
  id          uuid primary key default gen_random_uuid(),
  thought_id  uuid not null references thoughts(id) on delete cascade,
  origin      text not null default 'summary',
  chunk_index int  not null,
  content     text not null,
  char_start  int  not null,
  char_end    int  not null,
  embedding   vector(1536),
  created_at  timestamptz not null default now(),
  constraint thought_chunks_unique_index unique (thought_id, origin, chunk_index),
  constraint thought_chunks_range_valid check (char_end > char_start)
);

create index if not exists idx_chunks_thought on thought_chunks(thought_id);
create index if not exists idx_chunks_embedding on thought_chunks using hnsw (embedding vector_cosine_ops);

-- 'english' matches word forms (grant/grants); 'simple' keeps every word as
-- typed, which is what makes Spanish words findable by keyword at all.
alter table thought_chunks
  add column if not exists content_tsv tsvector
  generated always as (
    to_tsvector('english', coalesce(content, '')) || to_tsvector('simple', coalesce(content, ''))
  ) stored;

create index if not exists idx_chunks_content_tsv on thought_chunks using gin (content_tsv);

-- RLS on, no policies: only edge functions (service role) touch chunks.
alter table thought_chunks enable row level security;

alter table thoughts
  add column if not exists content_tsv tsvector
  generated always as (
    to_tsvector('english', coalesce(content, '')) || to_tsvector('simple', coalesce(content, ''))
  ) stored;

create index if not exists idx_thoughts_content_tsv on thoughts using gin (content_tsv);

-- Backfill bookkeeping: long thoughts that have no chunks yet.
-- security_invoker: the view obeys the RLS of whoever reads it. Without it, a
-- view runs as its owner (postgres) and would list every user's thoughts to
-- anyone holding the publishable key.
create or replace view public.thoughts_needing_chunks
  with (security_invoker = true) as
  select t.id, length(t.content) as chars, t.created_at
  from thoughts t
  where length(t.content) > 2000
    and not exists (
      select 1 from thought_chunks c where c.thought_id = t.id and c.origin = 'summary'
    )
  order by length(t.content) desc;


-- ── Step 4: hybrid search (meaning + keywords, fused with RRF) ──────────────
-- Functions are identified by name AND parameter list. The new version has a
-- different parameter list (and returns more columns), so CREATE OR REPLACE
-- would add a second search_thoughts beside the old one, and every call would
-- then fail with "function search_thoughts is not unique". Drop every existing
-- version by its exact signature first, then create the new one.
-- p_user_id: callers use the service role key, which skips row-level
-- security, so the owner filter is passed by hand — required, no default.

do $drop$
declare sig text;
begin
  for sig in
    select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'search_thoughts' and n.nspname = 'public'
  loop
    execute 'drop function ' || sig;
  end loop;
end
$drop$;

create function search_thoughts(
  query_text                text,
  p_user_id                 uuid,
  query_embedding            vector(1536) default null,
  match_threshold            float default 0.3,
  match_count                int   default 10,
  max_per_document           int   default 2
)
returns table (
  id            uuid,
  content       text,
  created_at    timestamptz,
  metadata      jsonb,
  similarity    float,
  matched_chunk text,
  chunk_origin  text,
  match_source  text,
  fusion_score  float
)
language sql stable as $$
  with
  visible as (
    select t.id, t.content, t.created_at, t.metadata, t.embedding, t.content_tsv,
           coalesce(t.metadata->>'url', t.metadata->>'video_id') as source_document
    from thoughts t
    where t.user_id = p_user_id
  ),
  document_hits as (
    select v.id as thought_id, 1 - (v.embedding <=> query_embedding) as sim,
           null::text as chunk_text, null::text as chunk_origin
    from visible v
    where query_embedding is not null and v.embedding is not null
      and 1 - (v.embedding <=> query_embedding) > match_threshold
  ),
  chunk_hits as (
    select c.thought_id, 1 - (c.embedding <=> query_embedding) as sim,
           c.content as chunk_text, c.origin as chunk_origin
    from thought_chunks c join visible v on v.id = c.thought_id
    where query_embedding is not null and c.embedding is not null
      and 1 - (c.embedding <=> query_embedding) > match_threshold
  ),
  vec_best as (
    select distinct on (u.thought_id) u.thought_id, u.sim, u.chunk_text, u.chunk_origin
    from (select * from document_hits union all select * from chunk_hits) u
    order by u.thought_id, u.sim desc
  ),
  vec_ranked as (
    select vb.*, row_number() over (order by vb.sim desc)::int as vrank from vec_best vb
  ),
  kq as (
    select case when query_text is null or btrim(query_text) = '' then null::tsquery
           else websearch_to_tsquery('english', query_text) || websearch_to_tsquery('simple', query_text)
           end as q
  ),
  kw_doc as (
    select v.id as thought_id, ts_rank(v.content_tsv, kq.q) as krank,
           null::text as chunk_text, null::text as chunk_origin
    from visible v cross join kq where kq.q is not null and v.content_tsv @@ kq.q
  ),
  kw_chunk as (
    select c.thought_id, ts_rank(c.content_tsv, kq.q) as krank,
           c.content as chunk_text, c.origin as chunk_origin
    from thought_chunks c join visible v on v.id = c.thought_id cross join kq
    where kq.q is not null and c.content_tsv @@ kq.q
  ),
  kw_best as (
    select distinct on (u.thought_id) u.thought_id, u.krank, u.chunk_text, u.chunk_origin
    from (select * from kw_doc union all select * from kw_chunk) u
    order by u.thought_id, u.krank desc
  ),
  kw_ranked as (
    select kb.*, row_number() over (order by kb.krank desc)::int as krank_pos
    from (select * from kw_best order by krank desc limit 200) kb
  ),
  fused as (
    select
      coalesce(vr.thought_id, kr.thought_id) as thought_id,
      vr.sim,
      case when vr.thought_id is null then kr.chunk_text
           when kr.thought_id is null then vr.chunk_text
           when kr.krank_pos < vr.vrank then kr.chunk_text
           else vr.chunk_text end as chunk_text,
      case when vr.thought_id is null then kr.chunk_origin
           when kr.thought_id is null then vr.chunk_origin
           when kr.krank_pos < vr.vrank then kr.chunk_origin
           else vr.chunk_origin end as chunk_origin,
      coalesce(1.0 / (60 + vr.vrank), 0) + coalesce(1.0 / (60 + kr.krank_pos), 0) as fusion
    from vec_ranked vr
    full outer join kw_ranked kr on kr.thought_id = vr.thought_id
  ),
  capped as (
    select f.*, v.source_document,
           case when v.source_document is null then 1
                else row_number() over (partition by v.source_document order by f.fusion desc)
           end as doc_rank
    from fused f join visible v on v.id = f.thought_id
  )
  select
    v.id, v.content, v.created_at, v.metadata,
    coalesce(c.sim, 0)::float as similarity,
    c.chunk_text as matched_chunk,
    c.chunk_origin,
    case when c.chunk_text is null then 'thought' else 'chunk' end as match_source,
    c.fusion::float as fusion_score
  from capped c join visible v on v.id = c.thought_id
  where c.doc_rank <= greatest(max_per_document, 1)
  order by c.fusion desc, coalesce(c.sim, 0) desc
  limit match_count;
$$;
