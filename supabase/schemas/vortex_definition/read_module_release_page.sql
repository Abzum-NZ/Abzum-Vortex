create or replace function vortex_definition.read_module_release_page(
  p_key text,
  p_anchor_release_revision bigint,
  p_after_release_revision bigint,
  p_page_size integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  root_row vortex_definition.roots%rowtype;
  anchor_revision bigint;
  history_latest_release_revision bigint;
  entries jsonb;
  next_after bigint;
begin
  checked_context := vortex_definition.validated_system_context();
  if p_key is null
    or pg_catalog.char_length(p_key) not between 3 and 120
    or p_key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    or p_key ~ '(^|\.)[^.]{41,}(\.|$)'
    or p_page_size is null or p_page_size not between 1 and 100
    or (p_anchor_release_revision is null and p_after_release_revision is not null)
    or (p_anchor_release_revision is not null and
      (p_anchor_release_revision not between 1 and 9007199254740991
        or p_after_release_revision is null
        or p_after_release_revision not between 1 and p_anchor_release_revision - 1)) then
    raise exception using errcode = '22023',
      message = 'Definition module release page selector is invalid';
  end if;

  select root.* into root_row
  from vortex_definition.roots as root
  where root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'module'
    and root.key = p_key;

  if not found or root_row.current_release_revision is null then
    return pg_catalog.jsonb_build_object(
      'rootId', null, 'anchorReleaseRevision', null,
      'entries', '[]'::jsonb, 'nextAfterReleaseRevision', null
    );
  end if;

  if p_anchor_release_revision is null then
    anchor_revision := root_row.current_release_revision;
    select release.release_revision into history_latest_release_revision
    from vortex_definition.releases as release
    where release.root_id = root_row.root_id
    order by release.release_revision desc
    limit 1;
    if history_latest_release_revision is distinct from anchor_revision then
      raise exception using errcode = '23514',
        message = 'Definition root current release pointer does not match immutable release history';
    end if;
  else
    anchor_revision := p_anchor_release_revision;
    if root_row.current_release_revision < anchor_revision
      or not exists (
        select 1 from vortex_definition.releases as release
        where release.root_id = root_row.root_id
          and release.release_revision = anchor_revision
      ) then
      raise exception using errcode = '40001',
        message = 'Definition module release page anchor is unavailable';
    end if;
  end if;

  with page as (
    select release.*
    from vortex_definition.releases as release
    where release.root_id = root_row.root_id
      and release.release_revision <= anchor_revision
      and (p_after_release_revision is null or release.release_revision > p_after_release_revision)
    order by release.release_revision asc
    limit p_page_size
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'previousReleaseRevision', (
      select previous.release_revision
      from vortex_definition.releases as previous
      where previous.root_id = release.root_id
        and previous.release_revision < release.release_revision
      order by previous.release_revision desc
      limit 1
    ),
    'release', pg_catalog.jsonb_build_object(
      'organizationId', root_row.organization_id,
      'key', root_row.key,
      'rootId', release.root_id,
      'releaseRevision', release.release_revision,
      'releaseVersion', release.release_version,
      'contentFingerprint', release.content_fingerprint,
      'resolutionFingerprint', release.resolution_fingerprint,
      'compilationOutput', release.compilation_output,
      'resolutionSnapshot', release.resolution_snapshot,
      'identities', coalesce(release.resolution_snapshot -> 'identities', '[]'::jsonb),
      'published', pg_catalog.jsonb_build_object(
        'publication', pg_catalog.jsonb_build_object(
          'kind', 'module', 'rootId', release.root_id,
          'revision', release.release_revision, 'releaseVersion', release.release_version,
          'contentFingerprint', release.content_fingerprint,
          'publishedAt', release.published_at, 'publishedBy', release.published_by,
          'validationContractVersion', release.validation_contract_version
        ),
        'content', release.compilation_output -> 'canonical' -> 'content',
        'dependencyManifest', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'kind', 'module', 'rootId', target.root_id,
            'revision', target.release_revision, 'releaseVersion', target.release_version,
            'contentFingerprint', target.content_fingerprint,
            'publishedAt', target.published_at, 'publishedBy', target.published_by,
            'validationContractVersion', target.validation_contract_version
          ) order by target.root_id, target.release_revision)
          from vortex_definition.release_dependencies as dependency
          join vortex_definition.releases as target
            on target.root_id = dependency.target_root_id
            and target.release_revision = dependency.target_release_revision
          where dependency.root_id = release.root_id
            and dependency.release_revision = release.release_revision
            and dependency.dependency_kind = 'module'
        ), '[]'::jsonb),
        'releaseNote', release.release_note
      )
    )
  ) order by release.release_revision asc), '[]'::jsonb), max(release.release_revision)
  into entries, next_after
  from page as release;

  return pg_catalog.jsonb_build_object(
    'rootId', root_row.root_id,
    'anchorReleaseRevision', anchor_revision,
    'entries', entries,
    'nextAfterReleaseRevision', case when next_after = anchor_revision then null else next_after end
  );
end
$function$;

revoke all on function vortex_definition.read_module_release_page(text, bigint, bigint, integer) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.read_module_release_page(text, bigint, bigint, integer) to vortex_request;

comment on function vortex_definition.read_module_release_page(text, bigint, bigint, integer) is
  'Returns one anchored bounded oldest-first page of same-organisation immutable Module release evidence.';
