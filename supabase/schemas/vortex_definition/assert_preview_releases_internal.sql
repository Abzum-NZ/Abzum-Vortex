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
begin
  if pg_catalog.jsonb_typeof(p_releases) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_releases) > 201
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_releases) as item(value)
      where pg_catalog.jsonb_typeof(item.value -> 'release') is distinct from 'object'
        or pg_catalog.jsonb_typeof(item.value -> 'dependencies') is distinct from 'array'
        or not coalesce(pg_catalog.pg_input_is_valid(item.value #>> '{release,root_id}', 'uuid'), false)
        or not coalesce(pg_catalog.pg_input_is_valid(
          item.value #>> '{release,release_revision}', 'bigint'
        ), false)
    ) then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  select root.current_release_revision into current_release_revision_value
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
    and root.organization_id = p_organization_id
    and root.kind = 'application';

  -- Each rehearsed release is the release a publication of this draft writes: the Application
  -- at its draft revision, or an owned Module at its staged draft revision, newer than the
  -- current release of its root and of that root's kind; at most one per root.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_releases) as item(value)
    where not exists (
      select 1
      from vortex_definition.roots as root
      join vortex_definition.drafts as draft on draft.root_id = root.root_id
      where root.root_id = (item.value #>> '{release,root_id}')::uuid
        and root.organization_id = p_organization_id
        and (root.root_id = p_application_root_id
          or (root.kind = 'module' and root.owner_application_root_id = p_application_root_id))
        and draft.draft_revision = (item.value #>> '{release,release_revision}')::bigint
        and draft.draft_revision > coalesce(root.current_release_revision, 0)
        and item.value #>> '{release,compilation_output,kind}' = root.kind
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(item.value -> 'dependencies') as dependency(value)
          where dependency.value ->> 'root_id' is distinct from root.root_id::text
            or dependency.value ->> 'release_revision' is distinct from draft.draft_revision::text
        )
    )
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value #>> '{release,root_id}')
    from pg_catalog.jsonb_array_elements(p_releases) as item(value)
  ) then
    raise exception using errcode = '23514',
      message = 'Rehearsed preview releases are not this Application draft';
  end if;
  -- A rehearsal may describe a new type, but cannot nominate another live or preview
  -- table for a type already installed in this Application. Check before replacing a preview.
  for rehearsed_type in
    select (item.value #>> '{release,root_id}')::uuid as module_root_id, record_type.value
    from pg_catalog.jsonb_array_elements(p_releases) as item(value)
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
    from pg_catalog.jsonb_array_elements(p_releases) as item(value)
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
  'Checks that rehearsed releases are exactly what a publication of the Application draft writes, and returns the Application release revision the preview runs: the rehearsed one, or the current release when the draft changes no Application content.';
