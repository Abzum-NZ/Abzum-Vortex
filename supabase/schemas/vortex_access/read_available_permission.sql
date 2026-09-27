create or replace function vortex_access.read_available_permission(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_owner_kind text,
  p_owner_id uuid,
  p_permission_id uuid
)
returns table (
  organization_id uuid,
  application_root_id uuid,
  registration_revision bigint,
  owner_kind text,
  owner_id uuid,
  permission_id uuid,
  permission_key text,
  label text,
  description text,
  record_type_id uuid,
  record_scope jsonb,
  field_policy jsonb,
  action_kind text,
  named_action text,
  administrative boolean,
  source_kind text,
  source_definition_key text,
  source_root_id uuid,
  source_version text,
  source_revision bigint,
  source_validation_contract_version text,
  source_content_fingerprint text,
  source_resolution_fingerprint text,
  source_catalogue_fingerprint text,
  meaning_fingerprint text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select entry.organization_id, entry.application_root_id, entry.registration_revision,
    entry.owner_kind, entry.owner_id, entry.permission_id, entry.permission_key,
    entry.label, entry.description, entry.record_type_id, entry.record_scope,
    entry.field_policy,
    entry.action_kind, entry.named_action, entry.administrative, entry.source_kind,
    entry.source_definition_key, entry.source_root_id, entry.source_version,
    entry.source_revision, entry.source_validation_contract_version,
    entry.source_content_fingerprint, entry.source_resolution_fingerprint,
    entry.source_catalogue_fingerprint, entry.meaning_fingerprint
  from vortex_access.permission_registrations as registration
  join vortex_access.permission_catalogue_entries as entry
    on entry.organization_id = registration.organization_id
    and entry.registration_kind = registration.registration_kind
    and entry.registration_owner_id = registration.registration_owner_id
    and entry.registration_revision = registration.revision
  where registration.organization_id = p_organization_id
    and registration.state = 'active'
    and entry.owner_kind = p_owner_kind
    and entry.owner_id = p_owner_id
    and entry.permission_id = p_permission_id
    and (
      (p_owner_kind = 'platform' and p_application_root_id is null and entry.application_root_id is null)
      or (
        p_owner_kind in ('application', 'module')
        and p_application_root_id is not null
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_application_root_id
        and entry.application_root_id = p_application_root_id
      )
    )
$function$;
revoke execute on function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid) is
  'Owner-only exact current permission lookup retaining application context, record scope and field policy.';
alter function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid)
  owner to vortex_access_owner;
