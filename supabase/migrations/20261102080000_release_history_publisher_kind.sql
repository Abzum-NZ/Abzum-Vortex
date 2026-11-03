set role vortex_owner;

-- STUDIO-POLISH-1: the release history says per version whether the platform published it, so a
-- publisher the viewer cannot see in the directory is named only when it is not a person. No
-- earlier migration after 20261102040000 rewrites this function; the body below is the whole
-- definition and equals the canonical file in supabase/schemas.

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
    -- A version published under the system context carries the platform's actor, which is no
    -- organisation account; a person's version carries their organisation account.
    'publishedByPlatform', not exists (
      select 1 from vortex_identity.organization_accounts as account
      where account.organization_account_id = release.published_by
    ),
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
  'Returns one anchored, bounded newest-first keyset page of an application''s published versions for Studio: metadata (with whether the platform published each version) and authored source only (never the compilation output), the release just older than the page, and whether newer and older pages exist.';

reset role;
