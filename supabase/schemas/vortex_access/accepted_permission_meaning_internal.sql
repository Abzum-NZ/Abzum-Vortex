create or replace function vortex_access.accepted_permission_meaning_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_owner_kind text,
  p_owner_id uuid,
  p_permission_id uuid,
  p_continuity_revision bigint,
  p_accepted_registration_revision bigint,
  p_meaning_fingerprint text
)
returns setof vortex_access.permission_catalogue_entries
language sql
stable
security invoker
set search_path = ''
as $function$
  -- A grant keeps its accepted meaning while the permission remains available in its original
  -- availability lineage. Explicit role acceptance or delegation scope change moves that meaning.
  select accepted.*
  from vortex_access.permission_registrations as registration
  join vortex_access.permission_catalogue_entries as current_entry
    on current_entry.organization_id = registration.organization_id
    and current_entry.registration_kind = registration.registration_kind
    and current_entry.registration_owner_id is not distinct from registration.registration_owner_id
    and current_entry.registration_revision = registration.revision
    and current_entry.application_root_id is not distinct from p_application_root_id
    and current_entry.owner_kind = p_owner_kind
    and current_entry.owner_id = p_owner_id
    and current_entry.permission_id = p_permission_id
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = current_entry.organization_id
    and continuity.application_scope_id = coalesce(current_entry.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and continuity.owner_kind = current_entry.owner_kind
    and continuity.owner_id = current_entry.owner_id
    and continuity.permission_id = current_entry.permission_id
    and continuity.registration_kind = current_entry.registration_kind
    and continuity.registration_owner_id is not distinct from current_entry.registration_owner_id
    and continuity.last_processed_registration_revision = registration.revision
    and continuity.state = 'available'
    and continuity.continuity_revision = p_continuity_revision
    and continuity.meaning_fingerprint = current_entry.meaning_fingerprint
  join vortex_access.permission_catalogue_entries as accepted
    on accepted.organization_id = current_entry.organization_id
    and accepted.registration_kind = current_entry.registration_kind
    and accepted.registration_owner_id is not distinct from current_entry.registration_owner_id
    and accepted.registration_revision = p_accepted_registration_revision
    and accepted.application_root_id is not distinct from current_entry.application_root_id
    and accepted.owner_kind = current_entry.owner_kind
    and accepted.owner_id = current_entry.owner_id
    and accepted.permission_id = current_entry.permission_id
    and accepted.meaning_fingerprint = p_meaning_fingerprint
  where registration.organization_id = p_organization_id
    and registration.state = 'active'
    and p_accepted_registration_revision <= registration.revision
  limit 1;
$function$;

revoke execute on function vortex_access.accepted_permission_meaning_internal(uuid, uuid, text, uuid, uuid, bigint, bigint, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.accepted_permission_meaning_internal(uuid, uuid, text, uuid, uuid, bigint, bigint, text)
  to vortex_owner, postgres;
alter function vortex_access.accepted_permission_meaning_internal(uuid, uuid, text, uuid, uuid, bigint, bigint, text)
  owner to vortex_owner;
