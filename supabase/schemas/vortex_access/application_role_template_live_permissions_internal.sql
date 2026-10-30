create or replace function vortex_access.application_role_template_live_permissions_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_registration_revision bigint,
  p_source_role_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  registration vortex_access.permission_registrations%rowtype;
  selected_template jsonb;
  wildcard boolean;
  resolved_count bigint;
  live_permissions jsonb;
begin
  select stored.* into registration
  from vortex_access.permission_registrations as stored
  where stored.organization_id = p_organization_id
    and stored.registration_kind = 'application'
    and stored.registration_owner_id = p_application_root_id
    and stored.revision = p_registration_revision;
  if not found then
    return null;
  end if;

  -- The source role exactly as the registered Application release declares it.
  select template.value into selected_template
  from vortex_definition.roots as root
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = registration.source_revision
    and release.release_version = registration.source_version
    and release.validation_contract_version = registration.validation_contract_version
  cross join lateral pg_catalog.jsonb_array_elements(
    release.compilation_output #> '{canonical,content,roles}'
  ) as template(value)
  where root.root_id = p_application_root_id
    and root.organization_id = p_organization_id
    and root.kind = 'application'
    and root.key = registration.source_definition_key
    and (template.value ->> 'roleId')::uuid = p_source_role_id;
  if selected_template is null
    or pg_catalog.jsonb_typeof(selected_template -> 'permissionKeys') is distinct from 'array' then
    return null;
  end if;
  wildcard := selected_template #>> '{permissionSelection,kind}' = 'application_wildcard';

  -- Each template key resolves to exactly one entry of that registration revision, in the
  -- template's own key order: an exact template among every registered entry, a wildcard template
  -- only among the Application's own non-administrative permissions. The live projection of a
  -- wildcard template also leaves out export permissions.
  with resolved as (
    select key.ordinal, entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry.administrative, entry.action_kind
    from pg_catalog.jsonb_array_elements_text(selected_template -> 'permissionKeys')
      with ordinality as key(permission_key, ordinal)
    join vortex_access.permission_catalogue_entries as entry
      on entry.organization_id = p_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = p_application_root_id
      and entry.registration_revision = p_registration_revision
      and entry.permission_key = key.permission_key
      and (
        not wildcard
        or (
          entry.owner_kind = 'application'
          and entry.application_root_id = p_application_root_id
          and entry.owner_id = p_application_root_id
          and not entry.administrative
        )
      )
  )
  select pg_catalog.count(*),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', resolved.application_root_id,
        'ownerKind', resolved.owner_kind,
        'ownerId', resolved.owner_id,
        'permissionId', resolved.permission_id
      )) order by resolved.ordinal) filter (
        where not wildcard or resolved.action_kind <> 'export'
      ), '[]'::jsonb)
  into resolved_count, live_permissions
  from resolved;
  if resolved_count <> pg_catalog.jsonb_array_length(selected_template -> 'permissionKeys') then
    return null;
  end if;

  return live_permissions;
end
$function$;

alter function vortex_access.application_role_template_live_permissions_internal(uuid, uuid, bigint, uuid) owner to vortex_owner;

revoke all on function vortex_access.application_role_template_live_permissions_internal(uuid, uuid, bigint, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.application_role_template_live_permissions_internal(uuid, uuid, bigint, uuid)
  to vortex_owner;

comment on function vortex_access.application_role_template_live_permissions_internal(uuid, uuid, bigint, uuid) is
  'Private Access projection: the live permission references of one Application source role at one exact registration revision, in template key order, or null when a template key does not resolve to exactly one registered entry. Role-change preparation and the role-change writer both read it, so the prepared evidence names the registration instead of carrying its entries.';
