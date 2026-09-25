create or replace function vortex_access.retire_organization_role_for_administration(
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_prepared_role_change jsonb,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  role_summary jsonb,
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
  role_fact vortex_access.organization_roles%rowtype;
  revision_fact vortex_access.organization_role_revisions%rowtype;
  expected_candidate jsonb;
  affected_permissions jsonb;
  authority_requirement jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  activity_result text;
begin
  if p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_role_revision is null
    or p_expected_role_revision not between 1 and 9007199254740991
    or p_prepared_role_change is null
    or pg_catalog.jsonb_typeof(p_prepared_role_change) is distinct from 'object'
    or p_prepared_role_change - array[
      'contractVersion', 'candidate', 'roleCandidateFingerprint'
    ]::text[] <> '{}'::jsonb
    or not (p_prepared_role_change ?& array[
      'contractVersion', 'candidate', 'roleCandidateFingerprint'
    ])
    or p_prepared_role_change ->> 'contractVersion' is distinct from '1.0.0'
    or pg_catalog.jsonb_typeof(p_prepared_role_change -> 'candidate')
      is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_prepared_role_change -> 'roleCandidateFingerprint')
      is distinct from 'string'
    or p_prepared_role_change ->> 'roleCandidateFingerprint'
      !~ '^sha256:[a-f0-9]{64}$'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role retirement input is invalid';
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
      message = 'Organization role retirement is unavailable';
  end if;

  select role.* into role_fact
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = p_role_id
  for update;
  if not found or role_fact.live_revision <> p_expected_role_revision then
    raise exception using errcode = '40001',
      message = 'Organization role retirement is stale or unavailable';
  end if;
  select revision.* into strict revision_fact
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = p_role_id
    and revision.revision = role_fact.live_revision;
  if revision_fact.lifecycle = 'retired' then
    raise exception using errcode = '40001',
      message = 'Organization role retirement is stale or unavailable';
  end if;

  expected_candidate := pg_catalog.jsonb_build_object(
    'operation', 'retire_role',
    'organizationId', context_organization_id,
    'roleId', p_role_id,
    'expectedRoleRevision', p_expected_role_revision
  );
  if p_prepared_role_change -> 'candidate' is distinct from expected_candidate then
    raise exception using errcode = '40001',
      message = 'Prepared organization role retirement is stale or unavailable';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'applicationRootId', permission.application_root_id,
      'ownerKind', permission.owner_kind,
      'ownerId', permission.owner_id,
      'permissionId', permission.permission_id
    )) order by permission.application_root_id nulls first,
      permission.owner_kind collate "C", permission.owner_id,
      permission.permission_id
  ) into affected_permissions
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = context_organization_id
    and permission.role_id = p_role_id
    and permission.role_revision = role_fact.live_revision;

  if affected_permissions is null
    and revision_fact.lifecycle not in ('unavailable', 'acceptance_required')
    and exists (
      select 1
      from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = context_organization_id
        and assignment.role_id = p_role_id
        and assignment.state = 'live'
  ) then
    raise exception using errcode = '40001',
      message = 'Organization role retained authority is stale or unavailable';
  end if;

  authority_requirement := case
    when affected_permissions is not null
      then pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object(
          'kind', 'bounded', 'permissions', affected_permissions
        ),
        'after', pg_catalog.jsonb_build_object('kind', 'none')
      )
    when revision_fact.lifecycle in ('unavailable', 'acceptance_required')
      and exists (
        select 1
        from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id = context_organization_id
          and assignment.role_id = p_role_id
          and assignment.state = 'live'
      )
      then pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object(
          'kind', 'organization_catalogue'
        ),
        'after', pg_catalog.jsonb_build_object('kind', 'none')
      )
    else pg_catalog.jsonb_build_object('kind', 'permission')
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.roles.retire',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '87c96495-c806-4692-9bc2-250ddb10613c'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', authority_requirement
    )
  ) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.roles.retire'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_activity.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'retire_role',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_context.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization role retirement refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.roles.retire'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization role retirement is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_role_change(
    p_prepared_role_change, context_account_id, context_correlation_id
  ) as result;
  changed_summary := vortex_access.project_organization_role_change_summary(
    context_organization_id, p_role_id
  );
  if changed_summary is null then
    raise exception using errcode = '40001',
      message = 'Changed organization role projection is unavailable';
  end if;

  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.role ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, 'retire_role',
    array[p_role_id]::uuid[], array[]::uuid[], vortex_context.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization role retirement Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed.access_version;
end
$function$;

revoke execute on function vortex_access.retire_organization_role_for_administration(uuid, bigint, jsonb, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.retire_organization_role_for_administration(uuid, bigint, jsonb, uuid)
to vortex_request;

comment on function vortex_access.retire_organization_role_for_administration(uuid, bigint, jsonb, uuid) is
  'Standalone request entry: performs retire_role after fixed protected checks; a zero-entry unavailable or acceptance_required role with live assignments uses catalogue delegation, with one atomic completed Activity or one content-free refused Activity row; no SQL function composes this result.';
