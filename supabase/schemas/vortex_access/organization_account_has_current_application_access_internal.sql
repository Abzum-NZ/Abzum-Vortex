create or replace function vortex_access.organization_account_has_current_application_access_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_application_root_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  checked_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId'
    or (context_value ->> 'expiresAt')::timestamptz <= checked_at
    or (context_value ->> 'organizationId')::uuid is distinct from p_organization_id
    or (context_value ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    return false;
  end if;

  -- The Record writer invokes this helper only after locking the exact active
  -- organisation-account projection and its active identity in this organisation.
  return exists (
    with current_roles as (
      select role.role_id, role.source_role_id, revision.assignment_policy,
        revision.authority_continuity_revision,
        revision.policy_continuity_revision, revision.activation_policy_id,
        revision.activation_policy_revision, revision.activation_policy_fingerprint
      from vortex_access.organization_roles as role
      join vortex_access.organization_role_revisions as revision
        on revision.organization_id = role.organization_id
        and revision.role_id = role.role_id
        and revision.revision = role.live_revision
      where role.organization_id = p_organization_id
        and role.application_root_id = p_application_root_id
        and role.role_kind = 'application'
        and revision.lifecycle in ('active', 'acceptance_required')
    ), active_roles as (
      select role.source_role_id
      from current_roles as role
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = p_organization_id
        and assignment.role_id = role.role_id
        and assignment.assignee_kind = 'organization_account'
        and assignment.organization_account_id = p_organization_account_id
        and assignment.assignment_kind = 'standing'
        and assignment.state = 'live'
        and assignment.starts_at <= checked_at
        and (assignment.expires_at is null or assignment.expires_at > checked_at)
      where role.assignment_policy = 'standing'

      union

      select role.source_role_id
      from current_roles as role
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = p_organization_id
        and assignment.role_id = role.role_id
        and assignment.assignee_kind = 'group'
        and assignment.assignment_kind = 'standing'
        and assignment.state = 'live'
        and assignment.starts_at <= checked_at
        and (assignment.expires_at is null or assignment.expires_at > checked_at)
      join vortex_access.organization_groups as organization_group
        on organization_group.organization_id = assignment.organization_id
        and organization_group.group_id = assignment.group_id
        and organization_group.state = 'active'
      join vortex_access.organization_group_memberships as membership
        on membership.organization_id = assignment.organization_id
        and membership.group_id = assignment.group_id
        and membership.organization_account_id = p_organization_account_id
        and membership.state = 'live'
        and membership.starts_at <= checked_at
        and (membership.expires_at is null or membership.expires_at > checked_at)
      where role.assignment_policy = 'standing'

      union

      select role.source_role_id
      from current_roles as role
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = p_organization_id
        and assignment.role_id = role.role_id
        and assignment.assignee_kind = 'organization_account'
        and assignment.organization_account_id = p_organization_account_id
        and assignment.assignment_kind = 'eligible'
        and assignment.state = 'live'
        and assignment.starts_at <= checked_at
        and (assignment.expires_at is null or assignment.expires_at > checked_at)
      join vortex_access.organization_role_activations as activation
        on activation.organization_id = assignment.organization_id
        and activation.organization_account_id = p_organization_account_id
        and activation.role_id = assignment.role_id
        and activation.eligibility_source_kind = 'direct'
        and activation.role_assignment_id = assignment.role_assignment_id
        and activation.role_assignment_revision = assignment.revision
        and activation.state = 'live'
        and activation.activated_at <= checked_at
        and activation.expires_at > checked_at
        and activation.authority_continuity_revision = role.authority_continuity_revision
        and activation.policy_continuity_revision = role.policy_continuity_revision
        and activation.activation_policy_id = role.activation_policy_id
        and activation.activation_policy_revision = role.activation_policy_revision
        and activation.activation_policy_fingerprint = role.activation_policy_fingerprint
      where role.assignment_policy = 'activation_required'

      union

      select role.source_role_id
      from current_roles as role
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = p_organization_id
        and assignment.role_id = role.role_id
        and assignment.assignee_kind = 'group'
        and assignment.assignment_kind = 'eligible'
        and assignment.state = 'live'
        and assignment.starts_at <= checked_at
        and (assignment.expires_at is null or assignment.expires_at > checked_at)
      join vortex_access.organization_groups as organization_group
        on organization_group.organization_id = assignment.organization_id
        and organization_group.group_id = assignment.group_id
        and organization_group.state = 'active'
      join vortex_access.organization_role_activations as activation
        on activation.organization_id = assignment.organization_id
        and activation.organization_account_id = p_organization_account_id
        and activation.role_id = assignment.role_id
        and activation.eligibility_source_kind = 'group'
        and activation.role_assignment_id = assignment.role_assignment_id
        and activation.role_assignment_revision = assignment.revision
        and activation.state = 'live'
        and activation.activated_at <= checked_at
        and activation.expires_at > checked_at
        and activation.authority_continuity_revision = role.authority_continuity_revision
        and activation.policy_continuity_revision = role.policy_continuity_revision
        and activation.activation_policy_id = role.activation_policy_id
        and activation.activation_policy_revision = role.activation_policy_revision
        and activation.activation_policy_fingerprint = role.activation_policy_fingerprint
      join vortex_access.organization_group_memberships as membership
        on membership.organization_id = assignment.organization_id
        and membership.group_id = assignment.group_id
        and membership.organization_account_id = p_organization_account_id
        and membership.membership_id = activation.membership_id
        and membership.revision = activation.membership_revision
        and membership.state = 'live'
        and membership.starts_at <= checked_at
        and (membership.expires_at is null or membership.expires_at > checked_at)
      where role.assignment_policy = 'activation_required'
    )
    select 1 from active_roles
  );
end
$function$;

revoke all on function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

grant execute on function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid)
  to vortex_record_adapter;

comment on function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid) is
  'Private Record-link authorization for a previously locked active organisation account: returns only whether that linked account has a current direct or Group application role under the validated human application context, including current assignment, membership and activation continuity.';

alter function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid)
  owner to vortex_access_owner;