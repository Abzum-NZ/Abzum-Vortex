create or replace function vortex_module.read_installation_runtime_bundle_parts(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_bundle_format_version integer,
  p_sections jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  allowed_sections constant text[] := array[
    'pages', 'navigation', 'flows', 'trigger_index', 'theme', 'component_registry',
    'access_plan', 'tool_bundle'
  ];
  checked_context jsonb;
  selected_organization_id uuid;
  requested_sections text[];
  parts_value jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_bundle_format_version is null or p_bundle_format_version < 1
    or p_sections is null or pg_catalog.jsonb_typeof(p_sections) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle read command is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_sections) not between 1 and
    pg_catalog.cardinality(allowed_sections) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle read command is invalid';
  end if;
  if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_sections) as requested(value)
      where pg_catalog.jsonb_typeof(requested.value) is distinct from 'string'
        or not ((requested.value #>> '{}') = any (allowed_sections))
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_sections) as requested(value)
      group by requested.value
      having pg_catalog.count(*) > 1
    ) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle read command is invalid';
  end if;
  select pg_catalog.array_agg(requested.value #>> '{}' order by requested.ordinality)
  into requested_sections
  from pg_catalog.jsonb_array_elements(p_sections) with ordinality as requested(value, ordinality);

  checked_context := vortex_access.validated_human_request_context();
  selected_organization_id := (checked_context ->> 'organizationId')::uuid;
  if selected_organization_id is null then
    raise exception using errcode = '42501',
      message = 'Installation runtime bundle organisation is unavailable';
  end if;

  if not exists (
    select 1 from vortex_module.installation_runtime_bundles as stored
    where stored.organization_id = selected_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.application_release_revision = p_application_release_revision
      and stored.bundle_format_version = p_bundle_format_version
  ) then
    raise exception using errcode = 'P0002',
      message = 'Installation runtime bundle is unavailable';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'section', part.section,
      'ordinal', part.ordinal,
      'byteSize', pg_catalog.octet_length(part.content_bytes),
      'sha256', 'sha256:' || pg_catalog.encode(
        extensions.digest(part.content_bytes, 'sha256'), 'hex'
      ),
      'content', pg_catalog.convert_from(part.content_bytes, 'UTF8')
    ) order by pg_catalog.array_position(requested_sections, part.section), part.ordinal
  ), '[]'::jsonb)
  into parts_value
  from vortex_module.installation_runtime_bundle_parts as part
  where part.organization_id = selected_organization_id
    and part.application_root_id = p_application_root_id
    and part.application_release_revision = p_application_release_revision
    and part.bundle_format_version = p_bundle_format_version
    and part.section = any (requested_sections);

  return parts_value;
end
$function$;

alter function vortex_module.read_installation_runtime_bundle_parts(uuid,bigint,integer,jsonb) owner to vortex_module_owner;

revoke all on function vortex_module.read_installation_runtime_bundle_parts(
  uuid, bigint, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.read_installation_runtime_bundle_parts(
  uuid, bigint, integer, jsonb
) to vortex_request;
comment on function vortex_module.read_installation_runtime_bundle_parts(
  uuid, bigint, integer, jsonb
) is
  'Reads selected immutable runtime bundle parts by exact key inside the verified organisation context.';
