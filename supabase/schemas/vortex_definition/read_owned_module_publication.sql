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
      and release.release_revision = root.current_release_revision
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

  with records as materialized (
    select root.key as module_key, record.value as record, record.ordinality
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = root.current_release_revision
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
    'recordTypes', coalesce((select pg_catalog.jsonb_agg(
      module_key || ':' || (record ->> 'key') order by module_key collate "C", ordinality
    ) from records), '[]'::jsonb),
    'fields', coalesce((select pg_catalog.jsonb_agg(
      module_key || ':' || record_key || '.' || (value ->> 'key')
      order by module_key collate "C", record_ordinality, ordinality
    ) from fields), '[]'::jsonb)
  ), exists (
    select 1 from fields
    where pg_catalog.jsonb_typeof(value -> 'key') is distinct from 'string'
      or pg_catalog.length(value ->> 'key') not between 1 and 40
      or (value ->> 'key') !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
  ) into publication, invalid_field_key;
  if invalid_field_key then
    raise exception using errcode = '23514', message = 'Owned Module publication field is inconsistent';
  end if;
  return publication;
end
$function$;

revoke all on function vortex_definition.read_owned_module_publication(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_owned_module_publication(uuid) to vortex_request;
alter function vortex_definition.read_owned_module_publication(uuid) owner to vortex_owner;
