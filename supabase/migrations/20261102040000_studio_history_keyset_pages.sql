set role vortex_owner;

-- STUDIO-RELEASES-UX: Studio reads its histories one keyset page at a time.
-- The back-end run history becomes a keyset page (newest first, 40 by default, 200 at most); the
-- first reader took only a limit, so it is dropped and replaced by one reader. No earlier
-- migration rewrites either function in place (the regprocedure was searched): the bodies below
-- are the whole definitions and equal the canonical files in supabase/schemas.
drop function vortex_platform.read_backend_run_history(uuid, integer);

create or replace function vortex_platform.read_backend_run_history(
  p_application_root_id uuid,
  p_page_size integer,
  p_cursor_created_at timestamptz,
  p_cursor_run_id uuid,
  p_direction text
)
returns table (
  backend_run_id uuid,
  flow_id uuid,
  origin_kind text,
  source_key text,
  state text,
  failure_code text,
  created_at timestamptz,
  finished_at timestamptz,
  created_at_cursor text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
begin
  -- The caller must be a human whose organisation grants definition-draft management, the
  -- authority Studio uses to open an application; the organisation comes from that context.
  checked_context := vortex_definition.validated_builder_read_context_internal();
  if checked_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501', message = 'Back-end run history is unavailable';
  end if;
  if p_application_root_id is null
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_page_size is null or p_page_size not between 1 and 200
    or p_direction is null or p_direction not in ('older', 'newer')
    or (p_cursor_created_at is null) is distinct from (p_cursor_run_id is null)
    or (p_direction = 'newer' and p_cursor_created_at is null) then
    raise exception using errcode = '22023', message = 'Back-end run history request is invalid';
  end if;
  -- Newest first, keyset on (created_at, backend_run_id). One row more than the page is read so
  -- the caller knows whether a further page exists; the caller drops it. Outputs can hold record
  -- values, so the history never returns them. The cursor text keeps the microseconds a client
  -- timestamp would lose.
  if p_direction = 'newer' then
    return query
    select page.backend_run_id, page.flow_id, page.origin_kind, page.source_key, page.state,
      page.failure_code, page.created_at, page.finished_at, page.created_at::text
    from (
      select run.backend_run_id, run.flow_id, run.origin_kind, run.source_key, run.state,
        run.failure_code, run.created_at, run.finished_at
      from vortex_platform.backend_runs as run
      where run.organization_id = (checked_context ->> 'organizationId')::uuid
        and run.application_root_id = p_application_root_id
        and (run.created_at, run.backend_run_id) > (p_cursor_created_at, p_cursor_run_id)
      order by run.created_at asc, run.backend_run_id asc
      limit p_page_size + 1
    ) as page
    order by page.created_at desc, page.backend_run_id desc;
  else
    return query
    select run.backend_run_id, run.flow_id, run.origin_kind, run.source_key, run.state,
      run.failure_code, run.created_at, run.finished_at, run.created_at::text
    from vortex_platform.backend_runs as run
    where run.organization_id = (checked_context ->> 'organizationId')::uuid
      and run.application_root_id = p_application_root_id
      and (run.created_at, run.backend_run_id) < (
        coalesce(p_cursor_created_at, 'infinity'::timestamptz),
        coalesce(p_cursor_run_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
    order by run.created_at desc, run.backend_run_id desc
    limit p_page_size + 1;
  end if;
end
$function$;
alter function vortex_platform.read_backend_run_history(uuid, integer, timestamptz, uuid, text) owner to vortex_owner;

revoke all on function vortex_platform.read_backend_run_history(uuid, integer, timestamptz, uuid, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.read_backend_run_history(uuid, integer, timestamptz, uuid, text)
  to vortex_request;

comment on function vortex_platform.read_backend_run_history(uuid, integer, timestamptz, uuid, text) is
  'Lists one keyset page, newest first, of the back-end runs of one application (flow, origin, source, state, failure code, times) without their outputs, with one row more than the page size so the caller sees whether a further page exists; it requires definition-draft management in the own request context of the caller.';

create or replace function vortex_definition.read_application_release_history_page(
  p_root_id uuid,
  p_anchor_release_revision bigint,
  p_cursor_release_revision bigint,
  p_direction text,
  p_page_size integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  root_row vortex_definition.roots%rowtype;
  picked bigint[];
  kept bigint[];
  has_older boolean;
  has_newer boolean;
  entries jsonb;
  predecessor jsonb;
begin
  checked_context := vortex_definition.validated_builder_read_context_internal();
  if p_root_id is null or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_anchor_release_revision is null or p_anchor_release_revision not between 1 and 9007199254740991
    or (p_cursor_release_revision is not null
      and p_cursor_release_revision not between 1 and p_anchor_release_revision + 1)
    or p_direction is null or p_direction not in ('older', 'newer')
    or (p_direction = 'newer' and p_cursor_release_revision is null)
    or p_page_size is null or p_page_size not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Application release history page selector is invalid';
  end if;
  select root.* into root_row from vortex_definition.roots as root where root.root_id = p_root_id;
  if not found then return null; end if;
  if root_row.organization_id <> (checked_context ->> 'organizationId')::uuid then
    raise exception using errcode = '42501', message = 'Definition root does not belong to the context organization';
  end if;
  if root_row.current_release_revision is distinct from p_anchor_release_revision then
    raise exception using errcode = '40001', message = 'Definition publication history anchor changed';
  end if;
  -- Newest first. One release more than the page is read to learn whether a further page exists.
  -- Two static queries, each with its bound inside the index scan whatever plan is chosen.
  if p_direction = 'newer' then
    select pg_catalog.array_agg(page.release_revision order by page.release_revision desc)
    into picked
    from (
      select release.release_revision
      from vortex_definition.releases as release
      where release.root_id = p_root_id
        and release.release_revision <= p_anchor_release_revision
        and release.release_revision > p_cursor_release_revision
      order by release.release_revision asc
      limit p_page_size + 1
    ) as page;
  else
    select pg_catalog.array_agg(page.release_revision order by page.release_revision desc)
    into picked
    from (
      select release.release_revision
      from vortex_definition.releases as release
      where release.root_id = p_root_id
        and release.release_revision <= p_anchor_release_revision
        and release.release_revision < coalesce(p_cursor_release_revision, p_anchor_release_revision + 1)
      order by release.release_revision desc
      limit p_page_size + 1
    ) as page;
  end if;
  picked := coalesce(picked, '{}'::bigint[]);
  if p_direction = 'newer' then
    has_newer := pg_catalog.cardinality(picked) > p_page_size;
    has_older := true;
    kept := case when has_newer then picked[2:pg_catalog.cardinality(picked)] else picked end;
  else
    has_older := pg_catalog.cardinality(picked) > p_page_size;
    has_newer := p_cursor_release_revision is not null;
    kept := case when has_older then picked[1:p_page_size] else picked end;
  end if;
  -- Metadata and the authored source only: the compilation output is never read, so one page
  -- costs the source documents the change summary compares and nothing else.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'releaseRevision', release.release_revision,
    'releaseVersion', release.release_version,
    'publishedAt', release.published_at,
    'publishedBy', release.published_by,
    'releaseNote', release.release_note,
    'authoredSourceFingerprint', release.authored_source_fingerprint,
    'authoredSource', release.authored_source,
    'previousReleaseRevision', (
      select previous.release_revision
      from vortex_definition.releases as previous
      where previous.root_id = release.root_id
        and previous.release_revision < release.release_revision
      order by previous.release_revision desc
      limit 1
    )
  ) order by release.release_revision desc), '[]'::jsonb)
  into entries
  from vortex_definition.releases as release
  where release.root_id = p_root_id and release.release_revision = any (kept);
  -- The release just older than the page, so its oldest entry can be compared with it.
  select pg_catalog.jsonb_build_object(
    'releaseRevision', previous.release_revision, 'authoredSource', previous.authored_source)
  into predecessor
  from vortex_definition.releases as previous
  where previous.root_id = p_root_id
    and previous.release_revision < (select pg_catalog.min(item) from pg_catalog.unnest(kept) as item)
  order by previous.release_revision desc
  limit 1;
  return pg_catalog.jsonb_build_object(
    'anchorReleaseRevision', p_anchor_release_revision,
    'entries', entries,
    'predecessor', predecessor,
    'hasOlder', has_older and pg_catalog.cardinality(kept) > 0,
    'hasNewer', has_newer);
end
$function$;
alter function vortex_definition.read_application_release_history_page(uuid, bigint, bigint, text, integer) owner to vortex_owner;

revoke all on function vortex_definition.read_application_release_history_page(uuid, bigint, bigint, text, integer)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_application_release_history_page(uuid, bigint, bigint, text, integer)
  to vortex_request;

comment on function vortex_definition.read_application_release_history_page(uuid, bigint, bigint, text, integer) is
  'Returns one anchored, bounded newest-first keyset page of an application''s published versions for Studio: metadata and authored source only (never the compilation output), the release just older than the page, and whether newer and older pages exist.';

-- The keyset tiebreak (backend_run_id) is served by the index.
drop index vortex_platform.backend_runs_history;
create index backend_runs_history
  on vortex_platform.backend_runs (organization_id, application_root_id, created_at desc, backend_run_id desc);

reset role;
