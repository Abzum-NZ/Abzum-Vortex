create or replace function vortex_access.list_landing_zone_applications_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
begin
  -- Row visibility matches the installed-application projection: the viewer's
  -- validated human request context selects the organisation and identity; only
  -- active application registrations whose published release still matches both
  -- fingerprints and whose installation binding is active are considered; and
  -- each application must pass the same human application-scope resolution. A
  -- refused, uninstalled or withdrawn application therefore has no row, exactly
  -- like a missing record. The record identity is the application root and its
  -- revision is the registration revision. Only the application key, name and
  -- icon are projected; compilation output, pages, roles, fingerprints, release
  -- evidence and installation evidence are never returned. Page access is not
  -- evaluated here.
  begin
    context_value := vortex_access.validated_human_request_context();
  exception
    when insufficient_privilege then
      return;
  end;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_platform.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform 1
    from vortex_access.resolve_human_organization_scope(
      actor_identity_id, visible_organization_id
    ) as scope;
  exception
    when sqlstate '42501' or sqlstate 'P0002' then
      return;
  end;
  return query
    select
      visible_organization_id,
      root.root_id,
      registration.revision,
      pg_catalog.jsonb_build_object(
        'key', root.key,
        'name', release.compilation_output #>> '{canonical,content,name}',
        'icon', release.compilation_output #>> '{canonical,content,icon}'
      )
    from vortex_access.permission_registrations as registration
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = registration.organization_id
      and root.kind = 'application'
      and root.key = registration.source_definition_key
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
      and release.release_version = registration.source_version
      and release.validation_contract_version = registration.validation_contract_version
    where registration.organization_id = visible_organization_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and (p_record_id is null or p_record_id = root.root_id)
      and release.compilation_output ->> 'kind' = 'application'
      and exists (
        select 1
        from vortex_definition.installation_bindings as binding
        where binding.organization_id = visible_organization_id
          and binding.application_root_id = root.root_id
          and binding.application_release_revision = registration.source_revision
          and binding.state = 'active'
      )
    order by root.key collate "C", root.root_id;
end
$function$;

revoke all on function vortex_access.list_landing_zone_applications_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.list_landing_zone_applications_projection(
  uuid, integer
) to vortex_owner, vortex_record_adapter;

comment on function vortex_access.list_landing_zone_applications_projection(uuid, integer) is
  'Registered Landing Zone application projection: returns each installed application the current viewer may reach in the viewer''s organisation, with the application identity, registration revision and only its key, name and icon, or no row when the application scope refuses the viewer. Pages, roles, compilation output, fingerprints and installation evidence are never projected.';

alter function vortex_access.list_landing_zone_applications_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;

grant execute on function vortex_access.list_landing_zone_applications_projection(p_record_id uuid, p_page_size integer) to postgres;
