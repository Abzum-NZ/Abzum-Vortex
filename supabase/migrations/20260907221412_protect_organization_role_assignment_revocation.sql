-- Protected terminal assignment revocation derives its complete affected scope
-- from the locked assignment and the role's current accepted configuration.
-- Withdrawal cleanup is the sole zero-entry exception: it requires catalogue
-- delegation and never consults an older role revision.
create function vortex_access.revoke_organization_role_assignment_for_administration(
  p_role_assignment_id uuid,
  p_expected_assignment_revision bigint,
  p_activity_id uuid
)
returns table (
  organization_id uuid,
  assignment_summary jsonb,
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
  context_correlation_id uuid;
  locked_access_version bigint;
  assignment_fact vortex_access.organization_role_assignments%rowtype;
  current_role_revision bigint;
  current_role_lifecycle text;
  affected_permissions jsonb;
  affected_authority jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  activity_result text;
begin
  if p_role_assignment_id is null
    or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_assignment_revision is null
    or p_expected_assignment_revision not between 1 and 9007199254740991
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-assignment revocation input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization role-assignment revocation is unavailable';
  end if;

  select assignment.* into assignment_fact
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = context_organization_id
    and assignment.role_assignment_id = p_role_assignment_id
  for update;
  if not found
    or assignment_fact.revision <> p_expected_assignment_revision
    or assignment_fact.state <> 'live' then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment revocation is stale or unavailable';
  end if;

  select role.live_revision, revision.lifecycle
    into strict current_role_revision, current_role_lifecycle
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  where role.organization_id = context_organization_id
    and role.role_id = assignment_fact.role_id;

  select pg_catalog.jsonb_agg(reference.permission order by
      reference.application_root_id nulls first, reference.owner_kind,
      reference.owner_id, reference.permission_id)
  into affected_permissions
  from (
    select distinct permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id,
        'ownerKind', permission.owner_kind,
        'ownerId', permission.owner_id,
        'permissionId', permission.permission_id
      )) as permission
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = context_organization_id
      and permission.role_id = assignment_fact.role_id
      and permission.role_revision = current_role_revision
  ) as reference;
  if affected_permissions is not null then
    affected_authority := pg_catalog.jsonb_build_object(
      'kind', 'bounded', 'permissions', affected_permissions
    );
  elsif current_role_lifecycle = 'unavailable' then
    affected_authority := pg_catalog.jsonb_build_object(
      'kind', 'organization_catalogue'
    );
  else
    raise exception using errcode = '40001',
      message = 'Organization role-assignment authority is stale or unavailable';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.role_assignments.revoke',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '156d01f3-8f80-45fb-8fc8-b31c47dbb1df'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', affected_authority,
        'after', pg_catalog.jsonb_build_object('kind', 'none')
      )
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.role_assignments.revoke'
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization role-assignment revocation is unavailable';
  end if;

  select assignment_change.* into strict changed
  from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', context_organization_id, p_role_assignment_id,
    p_expected_assignment_revision, null, null, null, null, null, null,
    null, null, context_account_id, context_correlation_id
  ) as assignment_change;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'roleAssignmentId', assignment.role_assignment_id,
    'role', pg_catalog.jsonb_build_object(
      'roleId', role.role_id, 'key', revision.role_key,
      'label', revision.label, 'lifecycle', revision.lifecycle
    ),
    'assignee', case assignment.assignee_kind
      when 'organization_account' then pg_catalog.jsonb_build_object(
        'kind', 'organization_account',
        'organizationAccountId', assignment.organization_account_id,
        'displayName', account.display_name
      ) else pg_catalog.jsonb_build_object(
        'kind', 'group', 'groupId', assignment.group_id,
        'key', organization_group.group_key, 'label', organization_group.label,
        'state', organization_group.state
      ) end,
    'assignmentKind', assignment.assignment_kind,
    'revision', assignment.revision, 'startsAt', assignment.starts_at,
    'expiresAt', assignment.expires_at, 'state', assignment.state,
    'temporalState', 'revoked'
  )) into strict changed_summary
  from vortex_access.organization_role_assignments as assignment
  join vortex_access.organization_roles as role
    on role.organization_id = assignment.organization_id
    and role.role_id = assignment.role_id
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id and revision.revision = role.live_revision
  left join vortex_identity.organization_accounts as account
    on assignment.assignee_kind = 'organization_account'
    and account.organization_id = assignment.organization_id
    and account.organization_account_id = assignment.organization_account_id
  left join vortex_access.organization_groups as organization_group
    on assignment.assignee_kind = 'group'
    and organization_group.organization_id = assignment.organization_id
    and organization_group.group_id = assignment.group_id
  where assignment.organization_id = context_organization_id
    and assignment.role_assignment_id = p_role_assignment_id;

  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed.changed_at,
    'organization_account', context_account_id, 'revoke_role_assignment',
    array[p_role_assignment_id]::uuid[], array[]::uuid[], 'web',
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment revocation Activity is stale';
  end if;

  return query select context_organization_id, changed_summary,
    changed.access_version;
end
$function$;

revoke execute on function
  vortex_access.revoke_organization_role_assignment_for_administration(uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function
  vortex_access.revoke_organization_role_assignment_for_administration(uuid, bigint, uuid)
to vortex_request;

comment on function
  vortex_access.revoke_organization_role_assignment_for_administration(uuid, bigint, uuid) is
  'Terminally revokes one reviewed assignment after fixed management and complete current-role scope checks; only a current unavailable zero-entry role uses catalogue delegation, with one atomic Activity entry.';
