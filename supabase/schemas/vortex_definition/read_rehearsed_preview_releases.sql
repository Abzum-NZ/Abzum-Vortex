create or replace function vortex_definition.read_rehearsed_preview_releases(
  p_application_root_id uuid,
  p_pins jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  pin_count bigint;
  releases_value jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or pg_catalog.jsonb_typeof(p_pins) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_pins) > 201
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_pins) as pin(value)
      where pg_catalog.jsonb_typeof(pin.value) is distinct from 'object'
        or not coalesce(pg_catalog.pg_input_is_valid(pin.value ->> 'rootId', 'uuid'), false)
        or pg_catalog.jsonb_typeof(pin.value -> 'releaseRevision') is distinct from 'number'
    ) then
    raise exception using errcode = '22023',
      message = 'Rehearsed preview release selection is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  pin_count := pg_catalog.jsonb_array_length(p_pins);

  -- Only the Application and the Modules it owns, exactly as the rehearsal stored them.
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'release', pg_catalog.to_jsonb(release.*),
      'dependencies', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(dependency.*)
          order by dependency.dependency_kind collate "C",
            dependency.dependency_reference collate "C",
            dependency.dependency_version collate "C")
        from vortex_definition.release_dependencies as dependency
        where dependency.root_id = release.root_id
          and dependency.release_revision = release.release_revision
      ), '[]'::jsonb)
    ) order by release.root_id
  ), '[]'::jsonb)
  into releases_value
  from (
    select distinct (pin.value ->> 'rootId')::uuid as root_id,
      (pin.value ->> 'releaseRevision')::bigint as release_revision
    from pg_catalog.jsonb_array_elements(p_pins) as pin(value)
  ) as pin
  join vortex_definition.releases as release
    on release.root_id = pin.root_id
    and release.release_revision = pin.release_revision
  join vortex_definition.roots as root on root.root_id = release.root_id
  where root.organization_id = (checked_context ->> 'organizationId')::uuid
    and (root.root_id = p_application_root_id
      or (root.kind = 'module' and root.owner_application_root_id = p_application_root_id));

  if pg_catalog.jsonb_array_length(releases_value) <> pin_count then
    raise exception using errcode = '23514',
      message = 'Rehearsed preview releases do not match the Application draft';
  end if;
  return releases_value;
end
$function$;

alter function vortex_definition.read_rehearsed_preview_releases(uuid, jsonb) owner to vortex_owner;

revoke all on function vortex_definition.read_rehearsed_preview_releases(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_rehearsed_preview_releases(uuid, jsonb)
  to vortex_request;
comment on function vortex_definition.read_rehearsed_preview_releases(uuid, jsonb) is
  'Reads, inside a rehearsed publication of the Application draft, the stored release rows and dependency rows it wrote for the Application and its owned Modules, so a preview can run them after the rehearsal is undone.';
