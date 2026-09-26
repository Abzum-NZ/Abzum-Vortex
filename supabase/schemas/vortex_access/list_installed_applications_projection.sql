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
  application_row record;
  authorised boolean;
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
  if not vortex_context.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_context.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  select settings.default_application_root_id into default_application_root_id
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = visible_organization_id;
  for application_row in
    select
      root.root_id,
      root.key as application_key,
      registration.revision as registration_revision,
      registration.source_revision as release_revision
    from vortex_access.permission_registrations as registration
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = registration.organization_id
      and root.kind = 'application'
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
    where registration.organization_id = visible_organization_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and (p_record_id is null or p_record_id = root.root_id)
      and release.compilation_output ->> 'kind' = 'application'
      and registration.source_content_fingerprint = release.content_fingerprint
      and registration.source_resolution_fingerprint = release.resolution_fingerprint
      and exists (
        select 1
        from vortex_module.installation_bindings as binding
        where binding.organization_id = visible_organization_id
          and binding.application_root_id = root.root_id
          and binding.application_release_revision = registration.source_revision
          and binding.state = 'active'
      )
    order by root.key collate "C", root.root_id
  loop
    authorised := false;
    begin
      perform 1
      from vortex_access.resolve_human_application_scope(
        actor_identity_id, visible_organization_id, application_row.root_id
      ) as scope;
      authorised := true;
    exception
      when sqlstate '42501' or sqlstate 'P0002' then
        authorised := false;
    end;
    if authorised then
      return query select
        visible_organization_id,
        application_row.root_id,
        application_row.registration_revision,
        pg_catalog.jsonb_build_object(
          'key', application_row.application_key,
          'release_revision', application_row.release_revision,
          'is_default', application_row.root_id
            is not distinct from default_application_root_id
        );
    end if;
  end loop;
end
$function$;

revoke all on function vortex_access.list_installed_applications_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_installed_applications_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_installed_applications_projection(uuid, integer) is
  'Registered installed-application projection: returns every application the current viewer may reach that is installed in the viewer''s organisation, being an active application registration whose published release still matches every fingerprint and whose installation binding is active, with the organisation, the application identity, the registration revision and the safe projected attribute values keyed by lowercase field key, or no row when the application scope refuses the viewer. Compilation output, fingerprints, release evidence and binding evidence are never projected.';
