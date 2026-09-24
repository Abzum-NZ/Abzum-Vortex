-- Personal privileged-access reads. Each function returns only the verified
-- viewer's own privileged eligibility or activations. The organisation and the
-- account come from the validated human request context, never from an input,
-- and no administrator permission is involved, so an administrator receives no
-- rows beyond their own through these readers.

create function vortex_access.list_own_privileged_eligible_roles_for_application(
  p_after_role_assignment_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  eligibilities jsonb,
  next_after_role_assignment_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  checked_at timestamptz;
  eligibility_items jsonb;
  page_assignment_ids uuid[];
  candidate_count integer;
begin
  if p_page_size is null or p_page_size not between 1 and 100
    or p_after_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Personal privileged eligibility page input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  checked_at := pg_catalog.clock_timestamp();

  with candidates as (
    select assignment.role_assignment_id, assignment.assignee_kind,
      assignment.starts_at, assignment.expires_at,
      role.role_id, revision.role_key, revision.label, revision.lifecycle,
      organization_group.group_id, organization_group.group_key,
      organization_group.label as group_label,
      pg_catalog.row_number() over (
        order by assignment.role_assignment_id
      ) as ordinal
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    left join vortex_access.organization_groups as organization_group
      on assignment.assignee_kind = 'group'
      and organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    left join vortex_access.organization_group_memberships as membership
      on assignment.assignee_kind = 'group'
      and membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_id
      and membership.state = 'live'
      and membership.starts_at <= checked_at
      and (membership.expires_at is null or membership.expires_at > checked_at)
    where assignment.organization_id = context_organization_id
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= checked_at
      and (assignment.expires_at is null or assignment.expires_at > checked_at)
      and revision.privilege_classification = 'privileged'
      -- An eligible assignment is dormant while the role accepts standing use,
      -- and existing eligibility may still request activation of the retained
      -- remainder while an application role awaits acceptance.
      and revision.assignment_policy = 'activation_required'
      and revision.lifecycle in ('active', 'acceptance_required')
      and (
        (
          assignment.assignee_kind = 'organization_account'
          and assignment.organization_account_id = context_account_id
        ) or (
          assignment.assignee_kind = 'group'
          and membership.membership_id is not null
          and organization_group.group_id is not null
        )
      )
      and (
        p_after_role_assignment_id is null
        or assignment.role_assignment_id > p_after_role_assignment_id
      )
    order by assignment.role_assignment_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'roleAssignmentId', candidate.role_assignment_id,
          'role', pg_catalog.jsonb_build_object(
            'roleId', candidate.role_id,
            'key', candidate.role_key,
            'label', candidate.label,
            'lifecycle', candidate.lifecycle
          ),
          'source', case candidate.assignee_kind
            when 'organization_account' then
              pg_catalog.jsonb_build_object('kind', 'direct')
            else pg_catalog.jsonb_build_object(
              'kind', 'group',
              'groupId', candidate.group_id,
              'key', candidate.group_key,
              'label', candidate.group_label
            )
          end,
          'startsAt', candidate.starts_at,
          'expiresAt', candidate.expires_at
        )) order by candidate.role_assignment_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.role_assignment_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into eligibility_items, page_assignment_ids, candidate_count
  from candidates as candidate;

  return query select context_organization_id, eligibility_items,
    case when candidate_count > p_page_size
      then page_assignment_ids[p_page_size] else null end,
    context_access_version;
end
$function$;

create function vortex_access.list_own_privileged_active_roles_for_application(
  p_after_role_activation_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  activations jsonb,
  next_after_role_activation_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  checked_at timestamptz;
  activation_items jsonb;
  page_activation_ids uuid[];
  candidate_count integer;
begin
  if p_page_size is null or p_page_size not between 1 and 100
    or p_after_role_activation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Personal privileged activation page input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  checked_at := pg_catalog.clock_timestamp();

  with candidates as (
    select activation.role_activation_id, activation.role_id,
      revision.role_key, revision.label, revision.lifecycle,
      activation.eligibility_source_kind, activation.activated_at,
      activation.expires_at,
      pg_catalog.row_number() over (
        order by activation.role_activation_id
      ) as ordinal
    from vortex_access.organization_role_activations as activation
    join vortex_access.organization_roles as role
      on role.organization_id = activation.organization_id
      and role.role_id = activation.role_id
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    -- An activation is current only while its exact eligibility source, and for
    -- a Group source its exact originating membership, remain valid and its
    -- authority and policy periods still match the live role revision.
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = activation.organization_id
      and assignment.role_assignment_id = activation.role_assignment_id
      and assignment.role_id = activation.role_id
      and assignment.revision = activation.role_assignment_revision
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= checked_at
      and (assignment.expires_at is null or assignment.expires_at > checked_at)
    left join vortex_access.organization_groups as organization_group
      on activation.eligibility_source_kind = 'group'
      and organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    left join vortex_access.organization_group_memberships as membership
      on activation.eligibility_source_kind = 'group'
      and membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_id
      and membership.membership_id = activation.membership_id
      and membership.revision = activation.membership_revision
      and membership.state = 'live'
      and membership.starts_at <= checked_at
      and (membership.expires_at is null or membership.expires_at > checked_at)
    where activation.organization_id = context_organization_id
      and activation.organization_account_id = context_account_id
      and activation.state = 'live'
      and activation.activated_at <= checked_at
      and activation.expires_at > checked_at
      and revision.privilege_classification = 'privileged'
      and revision.assignment_policy = 'activation_required'
      and revision.lifecycle in ('active', 'acceptance_required')
      and activation.authority_continuity_revision =
        revision.authority_continuity_revision
      and activation.policy_continuity_revision =
        revision.policy_continuity_revision
      and activation.activation_policy_id = revision.activation_policy_id
      and activation.activation_policy_revision =
        revision.activation_policy_revision
      and activation.activation_policy_fingerprint =
        revision.activation_policy_fingerprint
      and (
        (
          activation.eligibility_source_kind = 'direct'
          and assignment.assignee_kind = 'organization_account'
          and assignment.organization_account_id = context_account_id
        ) or (
          activation.eligibility_source_kind = 'group'
          and assignment.assignee_kind = 'group'
          and organization_group.group_id is not null
          and membership.membership_id is not null
        )
      )
      and (
        p_after_role_activation_id is null
        or activation.role_activation_id > p_after_role_activation_id
      )
    order by activation.role_activation_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'roleActivationId', candidate.role_activation_id,
          'role', pg_catalog.jsonb_build_object(
            'roleId', candidate.role_id,
            'key', candidate.role_key,
            'label', candidate.label,
            'lifecycle', candidate.lifecycle
          ),
          'eligibilitySourceKind', candidate.eligibility_source_kind,
          'activatedAt', candidate.activated_at,
          'expiresAt', candidate.expires_at
        ) order by candidate.role_activation_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.role_activation_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into activation_items, page_activation_ids, candidate_count
  from candidates as candidate;

  return query select context_organization_id, activation_items,
    case when candidate_count > p_page_size
      then page_activation_ids[p_page_size] else null end,
    context_access_version;
end
$function$;

revoke execute on function
  vortex_access.list_own_privileged_eligible_roles_for_application(uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke execute on function
  vortex_access.list_own_privileged_active_roles_for_application(uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;

grant execute on function
  vortex_access.list_own_privileged_eligible_roles_for_application(uuid, integer)
to vortex_request;
grant execute on function
  vortex_access.list_own_privileged_active_roles_for_application(uuid, integer)
to vortex_request;

comment on function
  vortex_access.list_own_privileged_eligible_roles_for_application(uuid, integer) is
  'Bounded page of the verified viewer''s own current privileged eligibility (direct and Group-sourced); organisation and account come from the validated request context.';
comment on function
  vortex_access.list_own_privileged_active_roles_for_application(uuid, integer) is
  'Bounded page of the verified viewer''s own current privileged activations whose exact eligibility source and policy period remain valid; organisation and account come from the validated request context.';
