-- Private grant-side compositions for the later verified IAM action. These
-- functions deliberately have no request-role grant: a validated session is
-- context evidence, not authority to initiate an access grant.

create function vortex_access.coordinate_private_organization_group_membership_change(
  p_operation text,
  p_membership_id uuid,
  p_expected_membership_revision bigint,
  p_group_id uuid,
  p_organization_account_id uuid,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_replacement_membership_id uuid,
  p_activity_source text,
  p_activity_id uuid
)
returns table (
  outcome text,
  operation text,
  membership jsonb,
  closed_predecessor jsonb,
  access_version bigint,
  correlation_id uuid
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
  target_group_id uuid;
  membership_fact vortex_access.organization_group_memberships%rowtype;
  authority_after jsonb;
  authority_requirement jsonb;
  decision record;
  changed record;
  activity_result text;
  subject_ids uuid[];
  operation_key text;
begin
  if p_operation is null
    or p_operation not in ('add_membership', 'restore_membership', 'renew_membership')
    or p_activity_source not in (
      'web', 'workflow', 'interface', 'connection', 'federation', 'system'
    )
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Private Organization Group membership input is invalid';
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
      message = 'Private Organization Group membership change is unavailable';
  end if;

  if p_operation = 'add_membership' then
    target_group_id := p_group_id;
  else
    select stored.* into membership_fact
    from vortex_access.organization_group_memberships as stored
    where stored.organization_id = context_organization_id
      and stored.membership_id = p_membership_id
    for update;
    if not found
      or membership_fact.revision is distinct from p_expected_membership_revision
      or (p_operation = 'restore_membership' and membership_fact.state <> 'revoked')
      or (p_operation = 'renew_membership' and membership_fact.state <> 'live') then
      raise exception using errcode = '40001',
        message = 'Private Organization Group membership change is stale or unavailable';
    end if;
    target_group_id := membership_fact.group_id;
  end if;

  perform 1
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = context_organization_id
    and organization_group.group_id = target_group_id
    and organization_group.state = 'active'
  for update;
  if not found then
    raise exception using errcode = '40001',
      message = 'Private Organization Group membership source is unavailable';
  end if;

  authority_after := vortex_access.organization_group_reduction_authority(
    context_organization_id, target_group_id
  );
  authority_requirement := case authority_after ->> 'kind'
    when 'none' then pg_catalog.jsonb_build_object('kind', 'permission')
    else pg_catalog.jsonb_build_object(
      'kind', 'delegated_management',
      'before', pg_catalog.jsonb_build_object('kind', 'none'),
      'after', authority_after
    )
  end;
  operation_key := 'platform.organization.group_memberships.' ||
    case p_operation
      when 'add_membership' then 'add'
      when 'restore_membership' then 'restore'
      else 'renew'
    end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_key,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '6185dc64-464b-4776-97dc-c64a6f299550'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', authority_requirement
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from operation_key
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Private Organization Group membership change is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_group_membership_change(
    p_operation, context_organization_id, p_membership_id,
    p_expected_membership_revision, p_group_id, p_organization_account_id,
    p_starts_at, p_expires_at, p_replacement_membership_id,
    context_account_id, context_correlation_id
  ) as result;

  subject_ids := case when p_operation = 'renew_membership'
    then array[p_membership_id, p_replacement_membership_id]::uuid[]
    else array[p_membership_id]::uuid[] end;
  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.membership ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, p_operation,
    subject_ids, array[]::uuid[], p_activity_source,
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Private Organization Group membership Activity is stale';
  end if;

  return query select changed.outcome, changed.operation, changed.membership,
    changed.closed_predecessor, changed.access_version, changed.correlation_id;
end
$function$;

create function vortex_access.coordinate_private_organization_role_assignment_grant(
  p_role_assignment_id uuid,
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_assignee_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_assignment_kind text,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_activity_source text,
  p_activity_id uuid
)
returns table (
  outcome text, operation text, organization_id uuid,
  role_assignment_id uuid, role_id uuid, assignee_kind text,
  organization_account_id uuid, group_id uuid, assignment_kind text,
  revision bigint, starts_at timestamptz, expires_at timestamptz, state text,
  granted_by_actor_id uuid, granted_at timestamptz,
  grant_correlation_id uuid, changed_by_actor_id uuid,
  changed_at timestamptz, change_correlation_id uuid,
  revoked_by_actor_id uuid, revoked_at timestamptz,
  revocation_correlation_id uuid, access_version bigint,
  correlation_id uuid
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
  affected_permissions jsonb;
  decision record;
  changed record;
  activity_result text;
begin
  if p_activity_source not in (
      'web', 'workflow', 'interface', 'connection', 'federation', 'system'
    )
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Private Organization role-assignment grant input is invalid';
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
      message = 'Private Organization role-assignment grant is unavailable';
  end if;

  perform 1
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = p_role_id
    and role.live_revision = p_expected_role_revision
  for update;
  if not found then
    raise exception using errcode = '40001',
      message = 'Private Organization role-assignment grant is stale or unavailable';
  end if;

  select pg_catalog.jsonb_agg(reference.permission order by
      reference.application_root_id nulls first, reference.owner_kind,
      reference.owner_id, reference.permission_id)
  into affected_permissions
  from (
    select distinct permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id,
        'ownerKind', permission.owner_kind, 'ownerId', permission.owner_id,
        'permissionId', permission.permission_id
      )) as permission
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = context_organization_id
      and permission.role_id = p_role_id
      and permission.role_revision = p_expected_role_revision
  ) as reference;
  if affected_permissions is null then
    raise exception using errcode = '40001',
      message = 'Private Organization role-assignment authority is unavailable';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.role_assignments.grant',
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
        'before', pg_catalog.jsonb_build_object('kind', 'none'),
        'after', pg_catalog.jsonb_build_object(
          'kind', 'bounded', 'permissions', affected_permissions
        )
      )
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.role_assignments.grant'
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Private Organization role-assignment grant is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_role_assignment_change(
    'grant', context_organization_id, p_role_assignment_id, null,
    p_role_id, p_expected_role_revision, p_assignee_kind,
    p_organization_account_id, p_group_id, p_assignment_kind,
    p_starts_at, p_expires_at, context_account_id, context_correlation_id
  ) as result;

  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed.changed_at,
    'organization_account', context_account_id, 'grant_role_assignment',
    array[p_role_assignment_id]::uuid[], array[]::uuid[], p_activity_source,
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Private Organization role-assignment Activity is stale';
  end if;

  return query select changed.outcome, changed.operation,
    changed.organization_id, changed.role_assignment_id, changed.role_id,
    changed.assignee_kind, changed.organization_account_id, changed.group_id,
    changed.assignment_kind, changed.revision, changed.starts_at,
    changed.expires_at, changed.state, changed.granted_by_actor_id,
    changed.granted_at, changed.grant_correlation_id,
    changed.changed_by_actor_id, changed.changed_at,
    changed.change_correlation_id, changed.revoked_by_actor_id,
    changed.revoked_at, changed.revocation_correlation_id,
    changed.access_version, changed.correlation_id;
end
$function$;

revoke execute on function
  vortex_access.coordinate_private_organization_group_membership_change(
    text, uuid, bigint, uuid, uuid, timestamptz, timestamptz, uuid, text, uuid
  ),
  vortex_access.coordinate_private_organization_role_assignment_grant(
    uuid, uuid, bigint, text, uuid, uuid, text, timestamptz, timestamptz,
    text, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function
  vortex_access.coordinate_private_organization_group_membership_change(
    text, uuid, bigint, uuid, uuid, timestamptz, timestamptz, uuid, text, uuid
  ) is
  'Owner-only governed add, restore or renew Group membership composition for the later verified IAM action; it has no request-role grant.';
comment on function
  vortex_access.coordinate_private_organization_role_assignment_grant(
    uuid, uuid, bigint, text, uuid, uuid, text, timestamptz, timestamptz,
    text, uuid
  ) is
  'Owner-only governed role-assignment grant composition for the later verified IAM action; it has no request-role grant.';
