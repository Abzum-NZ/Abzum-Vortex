create or replace function vortex_access.read_current_application_role_ids_for_launcher()
returns table (source_role_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  checked_at timestamptz := pg_catalog.clock_timestamp();
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId'
    or (context_value ->> 'expiresAt')::timestamptz <= checked_at then
    return;
  end if;

  -- In a preview the builder who opened it holds every role of the previewed draft.
  if nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  ) is not null then
    return query
    select distinct role_id.value
    from vortex_access.request_application_registration_internal(
      (context_value ->> 'organizationId')::uuid,
      (context_value ->> 'applicationRootId')::uuid,
      (context_value ->> 'organizationAccountId')::uuid
    ) as registration
    cross join lateral pg_catalog.unnest(registration.role_ids) as role_id(value)
    where registration.registration_kind = 'preview'
      and registration.valid_until > checked_at
    order by role_id.value;
    return;
  end if;

  return query
  with current_roles as (
    select role.role_id, role.source_role_id, revision.assignment_policy,
      revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = (context_value ->> 'organizationId')::uuid
      and role.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and role.role_kind = 'application'
      and revision.lifecycle in ('active', 'acceptance_required')
  ), active_roles as (
    select role.source_role_id
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = (context_value ->> 'organizationId')::uuid
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= checked_at
      and (assignment.expires_at is null or assignment.expires_at > checked_at)
    where role.assignment_policy = 'standing'

    union

    select role.source_role_id
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = (context_value ->> 'organizationId')::uuid
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
      and membership.organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and membership.state = 'live'
      and membership.starts_at <= checked_at
      and (membership.expires_at is null or membership.expires_at > checked_at)
    where role.assignment_policy = 'standing'

    union

    select role.source_role_id
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = (context_value ->> 'organizationId')::uuid
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= checked_at
      and (assignment.expires_at is null or assignment.expires_at > checked_at)
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
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
    where role.assignment_policy = 'activation_required'

    union

    select role.source_role_id
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = (context_value ->> 'organizationId')::uuid
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
      and activation.organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
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
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and membership.membership_id = activation.membership_id
      and membership.revision = activation.membership_revision
      and membership.state = 'live'
      and membership.starts_at <= checked_at
      and (membership.expires_at is null or membership.expires_at > checked_at)
    where role.assignment_policy = 'activation_required'
  )
  select active.source_role_id from active_roles as active
  order by active.source_role_id;
end
$function$;

revoke execute on function vortex_access.read_current_application_role_ids_for_launcher()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.read_current_application_role_ids_for_launcher()
  to vortex_request;

comment on function vortex_access.read_current_application_role_ids_for_launcher() is
  'Returns only current direct or group application-role source identities for the validated human application context, or every role of the previewed draft for the builder of a preview; page authority is checked separately.';

alter function vortex_access.read_current_application_role_ids_for_launcher() owner to vortex_owner;
