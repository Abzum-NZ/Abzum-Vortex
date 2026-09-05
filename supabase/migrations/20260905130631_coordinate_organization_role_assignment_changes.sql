create function vortex_access.coordinate_organization_role_assignment_change(
  p_operation text,
  p_organization_id uuid,
  p_role_assignment_id uuid,
  p_expected_assignment_revision bigint,
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_assignee_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_assignment_kind text,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  role_assignment_id uuid,
  role_id uuid,
  assignee_kind text,
  organization_account_id uuid,
  group_id uuid,
  assignment_kind text,
  revision bigint,
  starts_at timestamptz,
  expires_at timestamptz,
  state text,
  granted_by_actor_id uuid,
  granted_at timestamptz,
  grant_correlation_id uuid,
  changed_by_actor_id uuid,
  changed_at timestamptz,
  change_correlation_id uuid,
  revoked_by_actor_id uuid,
  revoked_at timestamptz,
  revocation_correlation_id uuid,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  next_access_version bigint;
  operation_at timestamptz;
  role_fact record;
  assignment_fact vortex_access.organization_role_assignments%rowtype;
begin
  if p_operation is null
    or p_operation not in ('grant', 'revoke')
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_assignment_id is null
    or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-assignment change input is invalid';
  end if;

  if p_operation = 'grant' then
    if p_expected_assignment_revision is not null
      or p_role_id is null
      or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_role_revision is null
      or p_expected_role_revision not between 1 and 9007199254740991
      or p_assignee_kind is null
      or p_assignee_kind not in ('organization_account', 'group')
      or p_assignment_kind is null
      or p_assignment_kind not in ('standing', 'eligible')
      or p_starts_at is null
      or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or (p_expires_at is not null and p_expires_at <= p_starts_at)
      or (
        p_assignee_kind = 'organization_account'
        and (
          p_organization_account_id is null
          or p_organization_account_id =
            '00000000-0000-0000-0000-000000000000'::uuid
          or p_group_id is not null
        )
      )
      or (
        p_assignee_kind = 'group'
        and (
          p_group_id is null
          or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
          or p_organization_account_id is not null
        )
      ) then
      raise exception using errcode = '22023',
        message = 'Organization role-assignment grant input is invalid';
    end if;
  elsif p_expected_assignment_revision is null
    or p_expected_assignment_revision not between 1 and 9007199254740991
    or p_role_id is not null
    or p_expected_role_revision is not null
    or p_assignee_kind is not null
    or p_organization_account_id is not null
    or p_group_id is not null
    or p_assignment_kind is not null
    or p_starts_at is not null
    or p_expires_at is not null then
    raise exception using errcode = '22023',
      message = 'Organization role-assignment revocation input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization role-assignment change scope is unavailable';
  end if;

  if p_operation = 'grant' then
    select role.live_revision, role_revision.lifecycle,
      role_revision.assignment_policy
    into role_fact
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id
      and role_revision.revision = role.live_revision
    where role.organization_id = p_organization_id
      and role.role_id = p_role_id
    for update of role;

    if not found
      or role_fact.live_revision <> p_expected_role_revision
      or role_fact.lifecycle <> 'active'
      or not (
        (p_assignment_kind = 'standing' and role_fact.assignment_policy = 'standing')
        or (
          p_assignment_kind = 'eligible'
          and role_fact.assignment_policy = 'activation_required'
        )
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment grant evidence is stale or unavailable';
    end if;

    if p_assignee_kind = 'organization_account' then
      perform 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = p_organization_id
        and account.organization_account_id = p_organization_account_id
        and account.state = 'active'
      for update;
    else
      perform 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = p_organization_id
        and organization_group.group_id = p_group_id
        and organization_group.state = 'active'
      for update;
    end if;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment grant evidence is stale or unavailable';
    end if;

    operation_at := pg_catalog.clock_timestamp();
    if p_expires_at is not null and p_expires_at <= operation_at then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment grant window is no longer current';
    end if;

    insert into vortex_access.organization_role_assignments (
      organization_id, role_assignment_id, role_id, assignee_kind,
      organization_account_id, group_id, assignment_kind, revision, starts_at,
      expires_at, state, granted_by, granted_at, grant_correlation_id,
      changed_by, changed_at, change_correlation_id, revoked_by, revoked_at,
      revocation_correlation_id
    ) values (
      p_organization_id, p_role_assignment_id, p_role_id, p_assignee_kind,
      p_organization_account_id, p_group_id, p_assignment_kind, 1, p_starts_at,
      p_expires_at, 'live', p_changed_by, operation_at, p_correlation_id,
      p_changed_by, operation_at, p_correlation_id, null, null, null
    );
  else
    select assignment.* into assignment_fact
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = p_organization_id
      and assignment.role_assignment_id = p_role_assignment_id
    for update;

    if not found
      or assignment_fact.revision <> p_expected_assignment_revision
      or assignment_fact.state <> 'live' then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment revocation is stale or unavailable';
    end if;
    if assignment_fact.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role-assignment revision is exhausted';
    end if;

    operation_at := pg_catalog.clock_timestamp();
    update vortex_access.organization_role_assignments as assignment
    set revision = assignment_fact.revision + 1,
      state = 'revoked',
      changed_by = p_changed_by,
      changed_at = operation_at,
      change_correlation_id = p_correlation_id,
      revoked_by = p_changed_by,
      revoked_at = operation_at,
      revocation_correlation_id = p_correlation_id
    where assignment.organization_id = p_organization_id
      and assignment.role_assignment_id = p_role_assignment_id
      and assignment.revision = p_expected_assignment_revision
      and assignment.state = 'live';
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment revocation is stale or unavailable';
    end if;
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id,
    p_changed_by,
    p_correlation_id,
    'role_assignment_changed'
  ) as version;

  return query
  select 'changed'::text, p_operation, assignment.organization_id,
    assignment.role_assignment_id, assignment.role_id, assignment.assignee_kind,
    assignment.organization_account_id, assignment.group_id,
    assignment.assignment_kind, assignment.revision, assignment.starts_at,
    assignment.expires_at, assignment.state, assignment.granted_by,
    assignment.granted_at, assignment.grant_correlation_id,
    assignment.changed_by, assignment.changed_at,
    assignment.change_correlation_id, assignment.revoked_by,
    assignment.revoked_at, assignment.revocation_correlation_id,
    next_access_version, p_correlation_id
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = p_organization_id
    and assignment.role_assignment_id = p_role_assignment_id;
end
$function$;

revoke execute on function
  vortex_access.coordinate_organization_role_assignment_change(
    text, uuid, uuid, bigint, uuid, bigint, text, uuid, uuid, text,
    timestamptz, timestamptz, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_organization_role_assignment_change(
  text, uuid, uuid, bigint, uuid, bigint, text, uuid, uuid, text,
  timestamptz, timestamptz, uuid, uuid
) is
  'Owner-only atomic role-assignment grant or terminal revocation. It checks integrity and changes Access once but grants no caller authority.';
