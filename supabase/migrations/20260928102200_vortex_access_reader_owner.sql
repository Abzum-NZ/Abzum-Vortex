-- Move the existing Access readers to the least-privilege owner.

begin;

alter function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  owner to vortex_access_owner;

alter function vortex_access.read_application_permission_snapshot(uuid, uuid)
  owner to vortex_access_owner;

alter function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid)
  owner to vortex_access_owner;

alter function vortex_access.resolve_record_field_bounds_internal(jsonb)
  owner to vortex_access_owner;

alter function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  owner to vortex_access_owner;

alter function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  owner to vortex_access_owner;

grant usage on schema vortex_context, vortex_identity to vortex_access_owner;

revoke all privileges on table
  vortex_access.permission_registrations,
  vortex_access.permission_catalogue_entries,
  vortex_access.permission_continuities,
  vortex_access.organization_roles,
  vortex_access.organization_role_revisions,
  vortex_access.organization_role_permission_entries,
  vortex_access.organization_role_assignments,
  vortex_access.organization_role_activations,
  vortex_access.organization_groups,
  vortex_access.organization_group_memberships,
  vortex_access.organization_delegation_authorities,
  vortex_access.organization_direct_record_shares
from vortex_access_owner;

grant select (
  organization_id,
  registration_kind,
  registration_owner_id,
  state,
  revision,
  source_definition_key,
  source_version,
  source_revision,
  validation_contract_version,
  source_content_fingerprint,
  source_resolution_fingerprint,
  permission_catalogue_fingerprint
)
on table vortex_access.permission_registrations to vortex_access_owner;

-- These readers and their invoker role-path helper use the complete catalogue row.
grant select on table vortex_access.permission_catalogue_entries to vortex_access_owner;

grant select (
  organization_id,
  application_root_id,
  owner_kind,
  owner_id,
  permission_id,
  registration_kind,
  registration_owner_id,
  state,
  continuity_revision,
  meaning_fingerprint,
  last_processed_registration_revision
)
on table vortex_access.permission_continuities to vortex_access_owner;

grant select (organization_id, role_id, live_revision)
on table vortex_access.organization_roles to vortex_access_owner;

grant select (
  organization_id,
  role_id,
  revision,
  lifecycle,
  assignment_policy,
  policy_continuity_revision,
  activation_policy_id,
  activation_policy_revision,
  activation_policy_fingerprint,
  authority_continuity_revision
)
on table vortex_access.organization_role_revisions to vortex_access_owner;

grant select (
  organization_id,
  role_id,
  role_revision,
  application_root_id,
  owner_kind,
  owner_id,
  permission_id,
  continuity_revision,
  meaning_fingerprint
)
on table vortex_access.organization_role_permission_entries to vortex_access_owner;

grant select (
  organization_id,
  role_assignment_id,
  role_id,
  assignee_kind,
  organization_account_id,
  group_id,
  assignment_kind,
  revision,
  starts_at,
  expires_at,
  state
)
on table vortex_access.organization_role_assignments to vortex_access_owner;

grant select (organization_id, group_id, state)
on table vortex_access.organization_groups to vortex_access_owner;

grant select (
  organization_id,
  membership_id,
  group_id,
  organization_account_id,
  revision,
  starts_at,
  expires_at,
  state
)
on table vortex_access.organization_group_memberships to vortex_access_owner;

grant select (
  organization_id,
  role_activation_id,
  organization_account_id,
  role_id,
  authority_continuity_revision,
  policy_continuity_revision,
  activation_policy_id,
  activation_policy_revision,
  activation_policy_fingerprint,
  eligibility_source_kind,
  role_assignment_id,
  role_assignment_revision,
  state,
  activated_at,
  expires_at,
  membership_id,
  membership_revision
)
on table vortex_access.organization_role_activations to vortex_access_owner;

grant select (
  organization_id,
  delegation_authority_id,
  holder_kind,
  organization_account_id,
  group_id,
  scope_kind,
  bounded_permissions,
  starts_at,
  expires_at,
  state
)
on table vortex_access.organization_delegation_authorities to vortex_access_owner;

grant select (
  organization_id,
  storage_scope,
  application_root_id,
  module_root_id,
  record_type_id,
  storage_contract_id,
  record_id,
  recipient_kind,
  organization_account_id,
  group_id,
  readable_field_ids,
  starts_at,
  expires_at,
  state
)
on table vortex_access.organization_direct_record_shares to vortex_access_owner;

create policy permission_registrations_access_owner_select
  on vortex_access.permission_registrations
  for select to vortex_access_owner using (true);
create policy permission_catalogue_entries_access_owner_select
  on vortex_access.permission_catalogue_entries
  for select to vortex_access_owner using (true);
create policy permission_continuities_access_owner_select
  on vortex_access.permission_continuities
  for select to vortex_access_owner using (true);
create policy organization_roles_access_owner_select
  on vortex_access.organization_roles
  for select to vortex_access_owner using (true);
create policy organization_role_revisions_access_owner_select
  on vortex_access.organization_role_revisions
  for select to vortex_access_owner using (true);
create policy organization_role_permission_entries_access_owner_select
  on vortex_access.organization_role_permission_entries
  for select to vortex_access_owner using (true);
create policy organization_role_assignments_access_owner_select
  on vortex_access.organization_role_assignments
  for select to vortex_access_owner using (true);
create policy organization_role_activations_access_owner_select
  on vortex_access.organization_role_activations
  for select to vortex_access_owner using (true);
create policy organization_groups_access_owner_select
  on vortex_access.organization_groups
  for select to vortex_access_owner using (true);
create policy organization_group_memberships_access_owner_select
  on vortex_access.organization_group_memberships
  for select to vortex_access_owner using (true);
create policy organization_delegation_authorities_access_owner_select
  on vortex_access.organization_delegation_authorities
  for select to vortex_access_owner using (true);
create policy organization_direct_record_shares_access_owner_select
  on vortex_access.organization_direct_record_shares
  for select to vortex_access_owner using (true);

grant execute on function vortex_access.validated_human_request_context()
  to vortex_access_owner;
grant execute on function vortex_access.recent_authentication_deadline_internal(
  jsonb, timestamptz, jsonb
) to vortex_access_owner;
grant execute on function vortex_access.evaluate_permission_role_path_internal(
  jsonb, timestamptz, jsonb, jsonb, uuid
) to vortex_access_owner;
grant execute on function vortex_access.evaluate_organization_record_permission_eligibility_internal(
  jsonb, jsonb, timestamptz
) to vortex_access_owner;
-- Existing postgres-owned definers still call these two reader entry points.
set local role vortex_access_owner;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to postgres;
grant execute on function vortex_access.resolve_record_field_bounds_internal(jsonb)
  to postgres;
reset role;
grant execute on function vortex_context.is_non_nil_uuid(text)
  to vortex_access_owner;
grant execute on function
  vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
    uuid, timestamptz
  ) to vortex_access_owner;

commit;
