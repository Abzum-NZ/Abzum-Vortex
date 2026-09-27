create or replace function vortex_access.read_application_permission_snapshot(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns table (
  organization_id uuid,
  application_root_id uuid,
  registration_revision bigint,
  release_revision bigint,
  definition_key text,
  release_version text,
  validation_contract_version text,
  content_fingerprint text,
  resolution_fingerprint text,
  catalogue_fingerprint text,
  permission_ids uuid[]
)
language sql
stable
security definer
set search_path = ''
as $function$
  select registration.organization_id, registration.registration_owner_id,
    registration.revision, registration.source_revision, registration.source_definition_key,
    registration.source_version,
    registration.validation_contract_version, registration.source_content_fingerprint,
    registration.source_resolution_fingerprint,
    registration.permission_catalogue_fingerprint,
    coalesce(
      pg_catalog.array_agg(entry.permission_id order by
        entry.permission_key collate "C", entry.permission_id)
        filter (where entry.permission_id is not null),
      array[]::uuid[]
    )
  from vortex_access.permission_registrations as registration
  left join vortex_access.permission_catalogue_entries as entry
    on entry.organization_id = registration.organization_id
    and entry.registration_kind = registration.registration_kind
    and entry.registration_owner_id = registration.registration_owner_id
    and entry.registration_revision = registration.revision
    and entry.owner_kind = 'application'
    and entry.administrative = false
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
    and registration.state = 'active'
  group by registration.organization_id, registration.registration_owner_id,
    registration.revision, registration.source_revision, registration.source_definition_key,
    registration.source_version,
    registration.validation_contract_version, registration.source_content_fingerprint,
    registration.source_resolution_fingerprint,
    registration.permission_catalogue_fingerprint
$function$;
revoke execute on function vortex_access.read_application_permission_snapshot(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.read_application_permission_snapshot(uuid, uuid)
  to vortex_module_owner;
comment on function vortex_access.read_application_permission_snapshot(uuid, uuid) is
  'Owner-only active exact release reference and deterministic application-only permission snapshot; role templates remain in Definition.';
alter function vortex_access.read_application_permission_snapshot(uuid, uuid)
  owner to vortex_access_owner;
