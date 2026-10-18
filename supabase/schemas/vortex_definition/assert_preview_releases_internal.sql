create or replace function vortex_definition.assert_preview_releases_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_releases jsonb
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  rehearsed_type record;
  current_release_revision_value bigint;
  application_release_revision_value bigint;
  releases_value jsonb := p_releases -> 'releases';
  checked_context jsonb;
  locked_access_version bigint;
begin
  if pg_catalog.jsonb_typeof(p_releases) is distinct from 'object'
    or pg_catalog.jsonb_typeof(releases_value) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_releases -> 'ownedRoots') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_releases -> 'usedRoots') is distinct from 'array'
    or p_releases #>> '{application,rootId}' is distinct from p_application_root_id::text then
    raise exception using errcode = '22023', message = 'Preview release plan is invalid';
  end if;

  -- Authority precedes root/draft locks. Compilation runs outside this short apply phase.
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id
  for share;
  if locked_access_version is distinct from (p_releases ->> 'accessVersion')::bigint
    or locked_access_version is distinct from (checked_context ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001', message = 'Preview plan access context changed';
  end if;
  perform 1 from vortex_definition.roots as root
  where root.organization_id = p_organization_id
    and (root.root_id = p_application_root_id
      or root.owner_application_root_id = p_application_root_id
      or root.root_id in (select (item.value ->> 'rootId')::uuid
        from pg_catalog.jsonb_array_elements(p_releases -> 'usedRoots') as item(value)))
  order by root.root_id for share;
  perform 1 from vortex_definition.drafts as draft
  join vortex_definition.roots as root on root.root_id = draft.root_id
  where root.organization_id = p_organization_id
    and (root.root_id = p_application_root_id or root.owner_application_root_id = p_application_root_id)
  order by draft.root_id for share of draft;

  select root.current_release_revision into current_release_revision_value
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = p_application_root_id and root.organization_id = p_organization_id
    and root.kind = 'application'
    and draft.draft_revision = (p_releases #>> '{application,draftRevision}')::bigint
    and draft.source_fingerprint = p_releases #>> '{application,sourceFingerprint}'
    and root.current_release_revision is not distinct from
      (p_releases #>> '{application,currentReleaseRevision}')::bigint;
  if not found or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_releases -> 'ownedRoots') as item(value)
    where not exists (
      select 1 from vortex_definition.roots as root
      join vortex_definition.drafts as draft on draft.root_id = root.root_id
      where root.root_id = (item.value ->> 'rootId')::uuid
        and root.organization_id = p_organization_id and root.kind = 'module'
        and root.owner_application_root_id = p_application_root_id
        and root.key = item.value ->> 'key'
        and draft.draft_revision = (item.value ->> 'draftRevision')::bigint
        and draft.source_fingerprint = item.value ->> 'sourceFingerprint'
        and root.current_release_revision is not distinct from (item.value ->> 'currentReleaseRevision')::bigint
    )
  ) or (select pg_catalog.count(*) from vortex_definition.roots as root
    where root.organization_id = p_organization_id and root.owner_application_root_id = p_application_root_id)
      <> pg_catalog.jsonb_array_length(p_releases -> 'ownedRoots')
  or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_releases -> 'usedRoots') as item(value)
    where not exists (
      select 1 from vortex_definition.roots as root
      where root.root_id = (item.value ->> 'rootId')::uuid and root.organization_id = p_organization_id
        and root.kind = 'module'
        and root.current_release_revision = (item.value ->> 'currentReleaseRevision')::bigint
    )
  ) then
    raise exception using errcode = '40001', message = 'Preview plan definition inputs changed';
  end if;

  -- Every compiled row is bound to its exact permanent owned root and staged source. Repeated
  -- planning of a released draft is valid too: only the preview shadows that immutable row.
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(releases_value) as item(value)
    where pg_catalog.jsonb_typeof(item.value -> 'release') is distinct from 'object'
      or pg_catalog.jsonb_typeof(item.value -> 'dependencies') is distinct from 'array'
      or not exists (
        select 1 from vortex_definition.roots as root
        join vortex_definition.drafts as draft on draft.root_id = root.root_id
        where root.root_id = (item.value #>> '{release,root_id}')::uuid
          and root.organization_id = p_organization_id
          and (root.root_id = p_application_root_id
            or (root.kind = 'module' and root.owner_application_root_id = p_application_root_id))
          and draft.draft_revision = (item.value #>> '{release,release_revision}')::bigint
          and draft.source_fingerprint = item.value #>> '{release,authored_source_fingerprint}'
          and draft.draft_source = item.value #> '{release,authored_source}'
          and item.value #>> '{release,compilation_output,kind}' = root.kind
          and not exists (
            select 1 from pg_catalog.jsonb_array_elements(item.value -> 'dependencies') as dependency(value)
            where dependency.value ->> 'root_id' is distinct from root.root_id::text
              or dependency.value ->> 'release_revision' is distinct from draft.draft_revision::text
          )
      )
  ) or (select pg_catalog.count(*) <> pg_catalog.count(distinct item.value #>> '{release,root_id}')
    from pg_catalog.jsonb_array_elements(releases_value) as item(value)) then
    raise exception using errcode = '40001', message = 'Preview release plan source changed';
  end if;

  -- Exact dependency rows are either part of this plan or immutable releases of this organisation.
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(releases_value) as item(value)
    cross join lateral pg_catalog.jsonb_array_elements(item.value -> 'dependencies') as dependency(value)
    where dependency.value ->> 'dependency_kind' = 'module'
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(releases_value) as target(value)
        where target.value #>> '{release,root_id}' = dependency.value ->> 'target_root_id'
          and target.value #>> '{release,release_revision}' = dependency.value ->> 'target_release_revision'
          and target.value #>> '{release,release_version}' = dependency.value ->> 'dependency_version'
          and target.value #>> '{release,content_fingerprint}' = dependency.value ->> 'dependency_content_fingerprint'
      ) and not exists (
        select 1 from vortex_definition.releases as release
        join vortex_definition.roots as root on root.root_id = release.root_id
        where root.organization_id = p_organization_id and root.kind = 'module'
          and release.root_id = (dependency.value ->> 'target_root_id')::uuid
          and release.release_revision = (dependency.value ->> 'target_release_revision')::bigint
          and release.release_version = dependency.value ->> 'dependency_version'
          and release.content_fingerprint = dependency.value ->> 'dependency_content_fingerprint'
      )
  ) then
    raise exception using errcode = '40001', message = 'Preview plan dependencies changed';
  end if;
  -- A compiled plan may describe a new type, but cannot nominate another live or preview
  -- table for a type already installed in this Application. Check before replacing a preview.
  for rehearsed_type in
    select (item.value #>> '{release,root_id}')::uuid as module_root_id, record_type.value
    from pg_catalog.jsonb_array_elements(releases_value) as item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      item.value #> '{release,compilation_output,canonical,content,recordTypes}'
    ) as record_type(value)
    where item.value #>> '{release,compilation_output,kind}' = 'module'
      and not record_type.value ? 'systemProjection'
  loop
    perform vortex_record.resolve_preview_seed_source_internal(
      p_organization_id, p_application_root_id, rehearsed_type.module_root_id,
      (rehearsed_type.value ->> 'recordTypeId')::uuid,
      (rehearsed_type.value ->> 'storageContractId')::uuid
    );
  end loop;
  application_release_revision_value := coalesce((
    select (item.value #>> '{release,release_revision}')::bigint
    from pg_catalog.jsonb_array_elements(releases_value) as item(value)
    where (item.value #>> '{release,root_id}')::uuid = p_application_root_id
  ), current_release_revision_value);
  if application_release_revision_value is null then
    raise exception using errcode = 'P0002', message = 'Application has no release to preview';
  end if;
  return application_release_revision_value;
end
$function$;

alter function vortex_definition.assert_preview_releases_internal(uuid, uuid, jsonb) owner to vortex_owner;

revoke all on function vortex_definition.assert_preview_releases_internal(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.assert_preview_releases_internal(uuid, uuid, jsonb)
  to vortex_owner;
comment on function vortex_definition.assert_preview_releases_internal(uuid, uuid, jsonb) is
  'Binds a server-compiled preview plan to the exact draft source, permanent owned roots, dependency anchors and access version under short shared locks; retains storage and seed-source ownership checks.';
