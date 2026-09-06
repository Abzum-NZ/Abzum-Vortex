-- Protected assignment-ledger reads describe stored role assignments and
-- delegation authorities. Temporal state is window-only and never replaces
-- the central Access decision.

create function vortex_access.organization_assignment_ledger_administration_scope()
returns table (
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.assignments.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '9901c0dc-8bac-45c7-be0b-3642cb839bb1'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization assignment ledger is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

create function vortex_access.list_organization_role_assignments_for_administration(
  p_after_role_assignment_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  assignments jsonb,
  next_after_role_assignment_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  checked_at timestamptz;
  assignment_items jsonb;
  page_assignment_ids uuid[];
  candidate_count integer;
begin
  if p_page_size is null or p_page_size not between 1 and 100
    or p_after_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role assignment page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_assignment_ledger_administration_scope()
    as authorized;
  checked_at := pg_catalog.clock_timestamp();

  with candidates as (
    select assignment.role_assignment_id, assignment.assignment_kind,
      assignment.revision, assignment.starts_at, assignment.expires_at,
      assignment.state, role.role_id, revision.role_key, revision.label,
      revision.lifecycle, assignment.assignee_kind,
      assignment.organization_account_id, account.display_name,
      assignment.group_id, organization_group.group_key,
      organization_group.label as group_label,
      organization_group.state as group_state,
      case
        when assignment.state = 'revoked' then 'revoked'
        when assignment.starts_at > checked_at then 'scheduled'
        when assignment.expires_at is not null
          and assignment.expires_at <= checked_at then 'expired'
        else 'active'
      end as temporal_state,
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
    left join vortex_identity.organization_accounts as account
      on assignment.assignee_kind = 'organization_account'
      and account.organization_id = assignment.organization_id
      and account.organization_account_id = assignment.organization_account_id
    left join vortex_access.organization_groups as organization_group
      on assignment.assignee_kind = 'group'
      and organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
    where assignment.organization_id = scope.organization_id
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
          'assignee', case candidate.assignee_kind
            when 'organization_account' then pg_catalog.jsonb_build_object(
              'kind', 'organization_account',
              'organizationAccountId', candidate.organization_account_id,
              'displayName', candidate.display_name
            )
            else pg_catalog.jsonb_build_object(
              'kind', 'group',
              'groupId', candidate.group_id,
              'key', candidate.group_key,
              'label', candidate.group_label,
              'state', candidate.group_state
            )
          end,
          'assignmentKind', candidate.assignment_kind,
          'revision', candidate.revision,
          'startsAt', candidate.starts_at,
          'expiresAt', candidate.expires_at,
          'state', candidate.state,
          'temporalState', candidate.temporal_state
        )) order by candidate.role_assignment_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.role_assignment_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into assignment_items, page_assignment_ids, candidate_count
  from candidates as candidate;

  return query select scope.organization_id, assignment_items,
    case when candidate_count > p_page_size
      then page_assignment_ids[p_page_size] else null end,
    scope.access_version;
end
$function$;

create function vortex_access.read_organization_role_assignment_for_administration(
  p_role_assignment_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  assignment_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  checked_at timestamptz;
  assignment_value jsonb;
begin
  if p_role_assignment_id is null
    or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role assignment detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_assignment_ledger_administration_scope()
    as authorized;
  checked_at := pg_catalog.clock_timestamp();

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'roleAssignmentId', assignment.role_assignment_id,
    'role', pg_catalog.jsonb_build_object(
      'roleId', role.role_id,
      'key', revision.role_key,
      'label', revision.label,
      'lifecycle', revision.lifecycle
    ),
    'assignee', case assignment.assignee_kind
      when 'organization_account' then pg_catalog.jsonb_build_object(
        'kind', 'organization_account',
        'organizationAccountId', assignment.organization_account_id,
        'displayName', account.display_name
      )
      else pg_catalog.jsonb_build_object(
        'kind', 'group',
        'groupId', assignment.group_id,
        'key', organization_group.group_key,
        'label', organization_group.label,
        'state', organization_group.state
      )
    end,
    'assignmentKind', assignment.assignment_kind,
    'revision', assignment.revision,
    'startsAt', assignment.starts_at,
    'expiresAt', assignment.expires_at,
    'state', assignment.state,
    'temporalState', case
      when assignment.state = 'revoked' then 'revoked'
      when assignment.starts_at > checked_at then 'scheduled'
      when assignment.expires_at is not null
        and assignment.expires_at <= checked_at then 'expired'
      else 'active'
    end
  ))
  into assignment_value
  from vortex_access.organization_role_assignments as assignment
  join vortex_access.organization_roles as role
    on role.organization_id = assignment.organization_id
    and role.role_id = assignment.role_id
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  left join vortex_identity.organization_accounts as account
    on assignment.assignee_kind = 'organization_account'
    and account.organization_id = assignment.organization_id
    and account.organization_account_id = assignment.organization_account_id
  left join vortex_access.organization_groups as organization_group
    on assignment.assignee_kind = 'group'
    and organization_group.organization_id = assignment.organization_id
    and organization_group.group_id = assignment.group_id
  where assignment.organization_id = scope.organization_id
    and assignment.role_assignment_id = p_role_assignment_id;

  return query select scope.organization_id,
    case when assignment_value is null then 'unavailable' else 'available' end,
    assignment_value, scope.access_version;
end
$function$;

create function vortex_access.list_organization_delegation_authorities_for_administration(
  p_after_delegation_authority_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  delegations jsonb,
  next_after_delegation_authority_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  checked_at timestamptz;
  delegation_items jsonb;
  page_delegation_ids uuid[];
  candidate_count integer;
begin
  if p_page_size is null or p_page_size not between 1 and 100
    or p_after_delegation_authority_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization delegation authority page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_assignment_ledger_administration_scope()
    as authorized;
  checked_at := pg_catalog.clock_timestamp();

  with candidates as (
    select delegation.delegation_authority_id, delegation.holder_kind,
      delegation.organization_account_id, account.display_name,
      delegation.group_id, organization_group.group_key,
      organization_group.label as group_label,
      organization_group.state as group_state,
      delegation.scope_kind, delegation.bounded_permissions,
      delegation.revision, delegation.starts_at, delegation.expires_at,
      delegation.state,
      case
        when delegation.state = 'revoked' then 'revoked'
        when delegation.starts_at > checked_at then 'scheduled'
        when delegation.expires_at is not null
          and delegation.expires_at <= checked_at then 'expired'
        else 'active'
      end as temporal_state,
      pg_catalog.row_number() over (
        order by delegation.delegation_authority_id
      ) as ordinal
    from vortex_access.organization_delegation_authorities as delegation
    left join vortex_identity.organization_accounts as account
      on delegation.holder_kind = 'organization_account'
      and account.organization_id = delegation.organization_id
      and account.organization_account_id = delegation.organization_account_id
    left join vortex_access.organization_groups as organization_group
      on delegation.holder_kind = 'group'
      and organization_group.organization_id = delegation.organization_id
      and organization_group.group_id = delegation.group_id
    where delegation.organization_id = scope.organization_id
      and (
        p_after_delegation_authority_id is null
        or delegation.delegation_authority_id > p_after_delegation_authority_id
      )
    order by delegation.delegation_authority_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'delegationAuthorityId', candidate.delegation_authority_id,
          'holder', case candidate.holder_kind
            when 'organization_account' then pg_catalog.jsonb_build_object(
              'kind', 'organization_account',
              'organizationAccountId', candidate.organization_account_id,
              'displayName', candidate.display_name
            )
            else pg_catalog.jsonb_build_object(
              'kind', 'group',
              'groupId', candidate.group_id,
              'key', candidate.group_key,
              'label', candidate.group_label,
              'state', candidate.group_state
            )
          end,
          'scope', case candidate.scope_kind
            when 'organization_catalogue' then pg_catalog.jsonb_build_object(
              'kind', 'organization_catalogue'
            )
            else pg_catalog.jsonb_build_object(
              'kind', 'bounded',
              'permissions', (
                select coalesce(
                  pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                      'applicationRootId', permission.value -> 'applicationRootId',
                      'ownerKind', permission.value -> 'ownerKind',
                      'ownerId', permission.value -> 'ownerId',
                      'permissionId', permission.value -> 'permissionId'
                    )) order by permission.ordinality
                  ),
                  '[]'::jsonb
                )
                from pg_catalog.jsonb_array_elements(candidate.bounded_permissions)
                  with ordinality as permission(value, ordinality)
              )
            )
          end,
          'revision', candidate.revision,
          'startsAt', candidate.starts_at,
          'expiresAt', candidate.expires_at,
          'state', candidate.state,
          'temporalState', candidate.temporal_state
        )) order by candidate.delegation_authority_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.delegation_authority_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into delegation_items, page_delegation_ids, candidate_count
  from candidates as candidate;

  return query select scope.organization_id, delegation_items,
    case when candidate_count > p_page_size
      then page_delegation_ids[p_page_size] else null end,
    scope.access_version;
end
$function$;

create function vortex_access.read_organization_delegation_authority_for_administration(
  p_delegation_authority_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  delegation_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  checked_at timestamptz;
  delegation_value jsonb;
begin
  if p_delegation_authority_id is null
    or p_delegation_authority_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization delegation authority detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_assignment_ledger_administration_scope()
    as authorized;
  checked_at := pg_catalog.clock_timestamp();

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'delegationAuthorityId', delegation.delegation_authority_id,
    'holder', case delegation.holder_kind
      when 'organization_account' then pg_catalog.jsonb_build_object(
        'kind', 'organization_account',
        'organizationAccountId', delegation.organization_account_id,
        'displayName', account.display_name
      )
      else pg_catalog.jsonb_build_object(
        'kind', 'group',
        'groupId', delegation.group_id,
        'key', organization_group.group_key,
        'label', organization_group.label,
        'state', organization_group.state
      )
    end,
    'scope', case delegation.scope_kind
      when 'organization_catalogue' then pg_catalog.jsonb_build_object(
        'kind', 'organization_catalogue'
      )
      else pg_catalog.jsonb_build_object(
        'kind', 'bounded',
        'permissions', (
          select coalesce(
            pg_catalog.jsonb_agg(
              pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                'applicationRootId', permission.value -> 'applicationRootId',
                'ownerKind', permission.value -> 'ownerKind',
                'ownerId', permission.value -> 'ownerId',
                'permissionId', permission.value -> 'permissionId'
              )) order by permission.ordinality
            ),
            '[]'::jsonb
          )
          from pg_catalog.jsonb_array_elements(delegation.bounded_permissions)
            with ordinality as permission(value, ordinality)
        )
      )
    end,
    'revision', delegation.revision,
    'startsAt', delegation.starts_at,
    'expiresAt', delegation.expires_at,
    'state', delegation.state,
    'temporalState', case
      when delegation.state = 'revoked' then 'revoked'
      when delegation.starts_at > checked_at then 'scheduled'
      when delegation.expires_at is not null
        and delegation.expires_at <= checked_at then 'expired'
      else 'active'
    end
  ))
  into delegation_value
  from vortex_access.organization_delegation_authorities as delegation
  left join vortex_identity.organization_accounts as account
    on delegation.holder_kind = 'organization_account'
    and account.organization_id = delegation.organization_id
    and account.organization_account_id = delegation.organization_account_id
  left join vortex_access.organization_groups as organization_group
    on delegation.holder_kind = 'group'
    and organization_group.organization_id = delegation.organization_id
    and organization_group.group_id = delegation.group_id
  where delegation.organization_id = scope.organization_id
    and delegation.delegation_authority_id = p_delegation_authority_id;

  return query select scope.organization_id,
    case when delegation_value is null then 'unavailable' else 'available' end,
    delegation_value, scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.organization_assignment_ledger_administration_scope()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.list_organization_role_assignments_for_administration(uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.read_organization_role_assignment_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.list_organization_delegation_authorities_for_administration(uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.read_organization_delegation_authority_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.list_organization_role_assignments_for_administration(uuid, integer)
to vortex_request;
grant execute on function
  vortex_access.read_organization_role_assignment_for_administration(uuid)
to vortex_request;
grant execute on function
  vortex_access.list_organization_delegation_authorities_for_administration(uuid, integer)
to vortex_request;
grant execute on function
  vortex_access.read_organization_delegation_authority_for_administration(uuid)
to vortex_request;

comment on function
  vortex_access.organization_assignment_ledger_administration_scope() is
  'Private fixed assignments-read authorization for role assignment and delegation ledger reads.';
comment on function
  vortex_access.list_organization_role_assignments_for_administration(uuid, integer) is
  'Returns one bounded role-assignment page with descriptive window state, not effective permission.';
comment on function
  vortex_access.read_organization_role_assignment_for_administration(uuid) is
  'Returns one safe exact role-assignment detail without grant audit or effective-access evidence.';
comment on function
  vortex_access.list_organization_delegation_authorities_for_administration(uuid, integer) is
  'Returns one bounded delegation page with internal scope evidence removed.';
comment on function
  vortex_access.read_organization_delegation_authority_for_administration(uuid) is
  'Returns one safe exact delegation detail without inferring holder authority.';
