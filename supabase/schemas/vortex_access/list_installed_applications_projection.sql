create or replace function vortex_access.list_installed_applications_projection(
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
  default_application_root_id uuid;
begin
  -- The projection keeps today's row visibility inside itself and neither the
  -- organisation nor the application is ever an input. An installed application is
  -- exactly the row the permitted-applications feed derives: an active application
  -- registration of the organisation whose published release still matches every
  -- fingerprint and whose installation binding is itself active, so a provisioned
  -- or draining installation is not an installed application. Each derived row is
  -- then authorised individually through the same application scope resolution the
  -- feed uses, so a viewer the scope refuses sees no row for that application,
  -- exactly as a missing or foreign record, and the record adapters return their
  -- identical refusal and a list page is empty rather than failing. The record
  -- identity is the application root and the revision is the registration's own
  -- revision, which every installation change advances. Compilation output,
  -- fingerprints, release evidence, binding evidence and the whole module set are
  -- never projected.
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
  select settings.default_application_root_id into default_application_root_id
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = visible_organization_id;
  return query
    select
      visible_organization_id,
      root.root_id,
      registration.revision,
      pg_catalog.jsonb_build_object(
        'key', root.key,
        'name', release.compilation_output #>> '{canonical,content,name}',
        'icon', release.compilation_output #>> '{canonical,content,icon}',
        'release_revision', registration.source_revision,
        'is_default', root.root_id is not distinct from default_application_root_id
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

revoke all on function vortex_access.list_installed_applications_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.list_installed_applications_projection(
  uuid, integer
) to vortex_owner, vortex_record_adapter;

comment on function vortex_access.list_installed_applications_projection(uuid, integer) is
  'Registered installed-application projection: returns every application the current viewer may reach that is installed in the viewer''s organisation, being an active application registration whose published release revision and metadata still match and whose installation binding is active, with the organisation, the application identity, the registration revision and safe projected key, name, icon, release revision and default status, or no row when the application scope refuses the viewer. Compilation output, release evidence and binding evidence are never projected.';

alter function vortex_access.list_installed_applications_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;

grant execute on function vortex_access.list_installed_applications_projection(p_record_id uuid, p_page_size integer) to postgres;
