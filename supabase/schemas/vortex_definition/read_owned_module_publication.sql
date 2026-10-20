create or replace function vortex_definition.read_owned_module_publication(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  publication jsonb;
  invalid_field_key boolean;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
  if p_application_root_id is null or not exists (
    select 1 from vortex_definition.roots as root
    where root.root_id = p_application_root_id and root.kind = 'application'
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
  ) then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  -- A broken current-release pointer is a storage defect, never an empty publication.
  if exists (
    select 1 from vortex_definition.roots as root
    left join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = root.current_release_revision
    where root.owner_application_root_id = p_application_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'module' and root.current_release_revision is not null
      and (release.root_id is null
        or pg_catalog.jsonb_typeof(release.compilation_output #> '{canonical,content,recordTypes}') is distinct from 'array')
  ) then
    raise exception using errcode = '23514', message = 'Owned Module publication is inconsistent';
  end if;

  if exists (
    select 1 from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,recordTypes}'
    ) as record(value)
    where root.owner_application_root_id = p_application_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'module'
      and (pg_catalog.jsonb_typeof(record.value -> 'key') is distinct from 'string'
        or pg_catalog.length(record.value ->> 'key') not between 1 and 40
        or (record.value ->> 'key') !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
        or pg_catalog.jsonb_typeof(record.value -> 'fields') is distinct from 'array')
  ) then
    raise exception using errcode = '23514', message = 'Owned Module publication record is inconsistent';
  end if;

  -- Storage remains published even when a later release removes it. Preview plans
  -- live on preview_installations, so only real publications contribute here.
  with records as materialized (
    select root.key as module_key, record.value as record, record.ordinality
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,recordTypes}'
    ) with ordinality as record(value, ordinality)
    where root.owner_application_root_id = p_application_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'module'
  ), fields as materialized (
    select module_key, record ->> 'key' as record_key,
      records.ordinality as record_ordinality, field.value, field.ordinality
    from records cross join lateral pg_catalog.jsonb_array_elements(record -> 'fields')
      with ordinality as field(value, ordinality)
  )
  select pg_catalog.jsonb_build_object(
    'recordTypes', coalesce((select pg_catalog.jsonb_agg(qualified_key order by qualified_key collate "C")
      from (select distinct module_key || ':' || (record ->> 'key') as qualified_key from records) as names
    ), '[]'::jsonb),
    'fields', coalesce((select pg_catalog.jsonb_agg(qualified_key order by qualified_key collate "C")
      from (select distinct module_key || ':' || record_key || '.' || (value ->> 'key') as qualified_key from fields) as names
    ), '[]'::jsonb)
  ), exists (
    select 1 from fields
    where pg_catalog.jsonb_typeof(value -> 'key') is distinct from 'string'
      or pg_catalog.length(value ->> 'key') not between 1 and 40
      or (value ->> 'key') !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
  ) into publication, invalid_field_key;
  if invalid_field_key then
    raise exception using errcode = '23514', message = 'Owned Module publication field is inconsistent';
  end if;

  -- Only actual contribution targets count. A dependency on the owner alone is not a use.
  -- Include current published contributors and older releases still bound to an installation.
  with owned_points as (
    select distinct root.root_id, root.key as module_key,
      point.value ->> 'extensionPointId' as point_id, point.value ->> 'key' as point_key
    from vortex_definition.roots as root
    join vortex_definition.releases as release on release.root_id = root.root_id
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,extensionPoints}'
    ) as point(value)
    where root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.owner_application_root_id = p_application_root_id and root.kind = 'module'
  ), contributor_releases as (
    select root.root_id, root.current_release_revision as release_revision
    from vortex_definition.roots as root
    where root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'module' and root.current_release_revision is not null
    union
    select binding.module_root_id, binding.module_release_revision
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = (checked_context ->> 'organizationId')::uuid
      and binding.state in ('provisioned', 'active', 'draining')
  ), uses as (
    select distinct point.module_key, point.point_key,
      contribution.value ->> 'kind' as kind,
      release.compilation_output #>> '{canonical,content,name}' as contributor_name
    from contributor_releases as contributor
    join vortex_definition.releases as release
      on release.root_id = contributor.root_id and release.release_revision = contributor.release_revision
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,contributions}'
    ) as contribution(value)
    join owned_points as point
      on point.root_id::text = contribution.value #>> '{targetModule,moduleRootId}'
      and point.point_id = contribution.value ->> 'targetExtensionPointId'
  )
  select publication || pg_catalog.jsonb_build_object('extensionPointUses', coalesce(
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleKey', module_key, 'extensionPointKey', point_key,
      'kind', kind, 'contributorName', contributor_name
    ) order by module_key collate "C", point_key collate "C", contributor_name collate "C", kind collate "C"),
    '[]'::jsonb
  )) into publication from uses;
  return publication;
end
$function$;

revoke all on function vortex_definition.read_owned_module_publication(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_owned_module_publication(uuid) to vortex_request;
alter function vortex_definition.read_owned_module_publication(uuid) owner to vortex_owner;
