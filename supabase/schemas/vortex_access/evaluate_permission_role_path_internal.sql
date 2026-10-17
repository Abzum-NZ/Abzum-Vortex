create or replace function vortex_access.evaluate_permission_role_path_internal(
  p_context jsonb,
  p_checked_at timestamptz,
  p_permission jsonb,
  p_action jsonb,
  p_record_type_id uuid
)
returns table (
  permission_entry vortex_access.permission_catalogue_entries,
  path_valid_until timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  context_organization_value uuid := (p_context ->> 'organizationId')::uuid;
  context_account_value uuid := (p_context ->> 'organizationAccountId')::uuid;
  context_expires_value timestamptz := (p_context ->> 'expiresAt')::timestamptz;
  decision_checked_at timestamptz := p_checked_at;
  permission_application_value uuid := (p_permission ->> 'applicationRootId')::uuid;
  permission_owner_kind_value text := p_permission ->> 'ownerKind';
  permission_owner_value uuid := (p_permission ->> 'ownerId')::uuid;
  permission_value uuid := (p_permission ->> 'permissionId')::uuid;
  action_kind_value text := p_action ->> 'actionKind';
  named_action_value text := p_action ->> 'namedAction';
begin
  return query
  with current_permission as materialized (
    select catalogue.application_root_id, catalogue.owner_kind,
      catalogue.owner_id, catalogue.permission_id,
      catalogue.registration_kind, catalogue.registration_owner_id,
      catalogue.registration_revision, continuity.continuity_revision,
      catalogue as permission_entry,
      catalogue.record_type_id is not distinct from p_record_type_id
        and catalogue.action_kind = action_kind_value
        and catalogue.named_action is not distinct from named_action_value
        as matches_request
    from vortex_access.permission_registrations as registration
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = registration.organization_id
      and catalogue.registration_kind = registration.registration_kind
      and catalogue.registration_owner_id = registration.registration_owner_id
      and catalogue.registration_revision = registration.revision
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = catalogue.organization_id
      and continuity.application_scope_id = coalesce(catalogue.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and continuity.owner_kind = catalogue.owner_kind
      and continuity.owner_id = catalogue.owner_id
      and continuity.permission_id = catalogue.permission_id
      and continuity.registration_kind = catalogue.registration_kind
      and continuity.registration_owner_id = catalogue.registration_owner_id
      and continuity.last_processed_registration_revision = registration.revision
      and continuity.state = 'available'
      and continuity.meaning_fingerprint = catalogue.meaning_fingerprint
    where registration.organization_id = context_organization_value
      and registration.state = 'active'
      and catalogue.application_root_id is not distinct from
        permission_application_value
      and catalogue.owner_kind = permission_owner_kind_value
      and catalogue.owner_id = permission_owner_value
      and catalogue.permission_id = permission_value
  ), current_role_permission as materialized (
    -- A role keeps exactly the meaning it was accepted under: the catalogue entry of the
    -- registration revision named by its permission entry, whatever a later registration changed
    -- in it (fields, scope, action or record type); only accepting the role revision moves it. The
    -- permission must still be registered in the same continuity lineage it was accepted in: a
    -- permission that was withdrawn and registered again starts a new lineage, so no role kind
    -- regains it without acceptance.
    select role.role_id, role.live_revision,
      revision.assignment_policy, revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision,
      accepted as accepted_entry,
      accepted.registration_revision as accepted_registration_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = revision.organization_id
      and permission.role_id = revision.role_id
      and permission.role_revision = revision.revision
    join current_permission as available
      on available.application_root_id is not distinct from
        permission.application_root_id
      and available.owner_kind = permission.owner_kind
      and available.owner_id = permission.owner_id
      and available.permission_id = permission.permission_id
      and available.registration_kind = permission.registration_kind
      and available.registration_owner_id is not distinct from
        permission.registration_owner_id
    cross join lateral vortex_access.accepted_permission_meaning_internal(
      permission.organization_id, permission.application_root_id,
      permission.owner_kind, permission.owner_id, permission.permission_id,
      permission.continuity_revision, permission.accepted_registration_revision,
      permission.meaning_fingerprint
    ) as accepted
    where role.organization_id = context_organization_value
      and revision.lifecycle in ('active', 'acceptance_required')
      and accepted.registration_kind = permission.registration_kind
      and accepted.registration_owner_id is not distinct from permission.registration_owner_id
      and accepted.record_type_id is not distinct from p_record_type_id
      and accepted.action_kind = action_kind_value
      and accepted.named_action is not distinct from named_action_value
  ), route_candidates as (
    select 1 as route_rank, permission.role_id,
      assignment.role_assignment_id, null::uuid as membership_id,
      null::uuid as role_activation_id,
      permission.accepted_entry, permission.accepted_registration_revision,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value)
      ) as path_valid_until
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = context_account_value
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'standing'

    union all

    select 2, permission.role_id, assignment.role_assignment_id,
      membership.membership_id, null::uuid,
      permission.accepted_entry, permission.accepted_registration_revision,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value)
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_value
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'standing'

    union all

    select 3, permission.role_id, assignment.role_assignment_id,
      null::uuid, activation.role_activation_id,
      permission.accepted_entry, permission.accepted_registration_revision,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        activation.expires_at
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = context_account_value
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = context_account_value
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'direct'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= decision_checked_at
      and activation.expires_at > decision_checked_at
      and activation.authority_continuity_revision =
        permission.authority_continuity_revision
      and activation.policy_continuity_revision =
        permission.policy_continuity_revision
      and activation.activation_policy_id = permission.activation_policy_id
      and activation.activation_policy_revision =
        permission.activation_policy_revision
    where permission.assignment_policy = 'activation_required'

    union all

    select 4, permission.role_id, assignment.role_assignment_id,
      membership.membership_id, activation.role_activation_id,
      permission.accepted_entry, permission.accepted_registration_revision,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value),
        activation.expires_at
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = context_account_value
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'group'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= decision_checked_at
      and activation.expires_at > decision_checked_at
      and activation.authority_continuity_revision =
        permission.authority_continuity_revision
      and activation.policy_continuity_revision =
        permission.policy_continuity_revision
      and activation.activation_policy_id = permission.activation_policy_id
      and activation.activation_policy_revision =
        permission.activation_policy_revision
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_value
      and membership.membership_id = activation.membership_id
      and membership.revision = activation.membership_revision
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'activation_required'
  ), granted as materialized (
    -- Every accepted meaning the caller holds through a live path is granted: a caller holding
    -- two roles with different accepted meanings of the permission has both, each with the
    -- earliest deadline of the paths that carry it.
    select distinct on (route.accepted_registration_revision)
      route.accepted_entry as permission_entry, route.path_valid_until
    from route_candidates as route
    order by route.accepted_registration_revision, route.path_valid_until
  ), administered as materialized (
    -- A super administrator is evaluated with the registered meaning.
    select available.permission_entry, context_expires_value as path_valid_until
    from current_permission as available
    where available.matches_request
      and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
        (p_context ->> 'identityId')::uuid, decision_checked_at
      ) is not null
  )
  select granted.permission_entry, granted.path_valid_until from granted
  union all
  select administered.permission_entry, administered.path_valid_until from administered
  union all
  -- Without a live path the registered permission is returned with no deadline, so callers
  -- can tell an unavailable permission from one that is not effective.
  select available.permission_entry, null::timestamptz
  from current_permission as available
  where available.matches_request
    and not exists (select 1 from granted)
    and not exists (select 1 from administered);
end
$function$;

revoke execute on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  ) to vortex_owner;

comment on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  ) is
  'Private current-permission and role-path evidence; null record type selects only non-record permissions. It returns one row per accepted meaning the caller holds through a live role path (never a later registered meaning), the registered meaning for a super administrator, or the registered permission without a deadline when no path is live. No row authority.';

alter function vortex_access.evaluate_permission_role_path_internal(p_context jsonb, p_checked_at timestamp with time zone, p_permission jsonb, p_action jsonb, p_record_type_id uuid) owner to vortex_owner;

grant execute on function vortex_access.evaluate_permission_role_path_internal(p_context jsonb, p_checked_at timestamp with time zone, p_permission jsonb, p_action jsonb, p_record_type_id uuid) to postgres;
