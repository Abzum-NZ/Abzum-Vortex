-- Owner-only authority-establishing compositions for the later verified IAM
-- operation. These functions deliberately grant no runtime/request execution:
-- a validated human context is necessary evidence, not the invocation right.

create function vortex_access.private_management_scope_from_permission_evidence(
  p_permissions jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  projected jsonb;
begin
  if p_permissions is null
    or pg_catalog.jsonb_typeof(p_permissions) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Private management permission evidence is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_permissions) = 0 then
    return pg_catalog.jsonb_build_object('kind', 'none');
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_permissions) as item(value)
    where (
      pg_catalog.jsonb_typeof(item.value) = 'object'
      and item.value ?& array['ownerKind', 'ownerId', 'permissionId']
      and pg_catalog.jsonb_typeof(item.value -> 'ownerKind') = 'string'
      and item.value ->> 'ownerKind' in ('platform', 'application', 'module')
      and pg_catalog.jsonb_typeof(item.value -> 'ownerId') = 'string'
      and vortex_context.is_non_nil_uuid(item.value ->> 'ownerId')
      and pg_catalog.jsonb_typeof(item.value -> 'permissionId') = 'string'
      and vortex_context.is_non_nil_uuid(item.value ->> 'permissionId')
      and (
        (
          item.value ->> 'ownerKind' = 'platform'
          and not item.value ? 'applicationRootId'
        ) or (
          item.value ->> 'ownerKind' in ('application', 'module')
          and pg_catalog.jsonb_typeof(item.value -> 'applicationRootId') = 'string'
          and vortex_context.is_non_nil_uuid(item.value ->> 'applicationRootId')
          and (
            item.value ->> 'ownerKind' <> 'application'
            or (item.value ->> 'ownerId')::uuid =
              (item.value ->> 'applicationRootId')::uuid
          )
        )
      )
    ) is not true
  ) then
    raise exception using errcode = '22023',
      message = 'Private management permission evidence is invalid';
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(
    pg_catalog.jsonb_build_object(
      'applicationRootId', parsed.application_root_id,
      'ownerKind', parsed.owner_kind,
      'ownerId', parsed.owner_id,
      'permissionId', parsed.permission_id
    )
  ) order by parsed.application_root_id nulls first,
    parsed.owner_kind collate "C", parsed.owner_id, parsed.permission_id)
  into projected
  from (
    select distinct
      case when item.value ->> 'ownerKind' = 'platform' then null::uuid
        else (item.value ->> 'applicationRootId')::uuid end as application_root_id,
      item.value ->> 'ownerKind' as owner_kind,
      (item.value ->> 'ownerId')::uuid as owner_id,
      (item.value ->> 'permissionId')::uuid as permission_id
    from pg_catalog.jsonb_array_elements(p_permissions) as item(value)
  ) as parsed;

  return pg_catalog.jsonb_build_object(
    'kind', 'bounded', 'permissions', projected
  );
end
$function$;

revoke execute on function
  vortex_access.private_management_scope_from_permission_evidence(jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create function vortex_access.private_current_role_management_scope(
  p_organization_id uuid,
  p_role_id uuid,
  p_role_revision bigint
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  permissions jsonb;
begin
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'applicationRootId', permission.application_root_id,
      'ownerKind', permission.owner_kind,
      'ownerId', permission.owner_id,
      'permissionId', permission.permission_id
    )) order by permission.application_root_id nulls first,
      permission.owner_kind collate "C", permission.owner_id,
      permission.permission_id
  ), '[]'::jsonb)
  into permissions
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = p_organization_id
    and permission.role_id = p_role_id
    and permission.role_revision = p_role_revision;

  if pg_catalog.jsonb_array_length(permissions) = 0 then
    return pg_catalog.jsonb_build_object('kind', 'none');
  end if;
  return pg_catalog.jsonb_build_object(
    'kind', 'bounded', 'permissions', permissions
  );
end
$function$;

revoke execute on function
  vortex_access.private_current_role_management_scope(uuid, uuid, bigint)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create function vortex_access.coordinate_private_organization_delegation_authority_change(
  p_operation text,
  p_delegation_authority_id uuid,
  p_expected_delegation_revision bigint,
  p_holder_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_prepared_scope jsonb,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_activity_source text,
  p_activity_id uuid
)
returns table (
  outcome text,
  operation text,
  delegation jsonb,
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
  delegation_fact vortex_access.organization_delegation_authorities%rowtype;
  authority_before jsonb;
  authority_after jsonb;
  decision record;
  changed record;
  activity_result text;
  operation_key text;
begin
  if p_operation is null
    or p_operation not in ('grant_delegation', 'replace_delegation_scope')
    or vortex_context.is_non_nil_uuid(
      p_delegation_authority_id::text
    ) is not true
    or p_activity_source is null
    or p_activity_source not in (
      'web', 'workflow', 'interface', 'connection', 'federation', 'system'
    )
    or vortex_context.is_non_nil_uuid(p_activity_id::text) is not true
    or p_prepared_scope is null
    or pg_catalog.jsonb_typeof(p_prepared_scope) is distinct from 'object'
    or not p_prepared_scope ? 'kind'
    or pg_catalog.jsonb_typeof(p_prepared_scope -> 'kind') is distinct from 'string'
    or p_prepared_scope ->> 'kind' not in ('organization_catalogue', 'bounded')
    or (
      p_prepared_scope ->> 'kind' = 'organization_catalogue'
      and p_prepared_scope - array['kind']::text[] <> '{}'::jsonb
    )
    or (
      p_prepared_scope ->> 'kind' = 'bounded'
      and (
        p_prepared_scope - array[
          'kind', 'permissions', 'scopeFingerprint'
        ]::text[] <> '{}'::jsonb
        or not p_prepared_scope ?& array['permissions', 'scopeFingerprint']
        or pg_catalog.jsonb_typeof(p_prepared_scope -> 'permissions')
          is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_prepared_scope -> 'permissions') = 0
        or pg_catalog.jsonb_typeof(p_prepared_scope -> 'scopeFingerprint')
          is distinct from 'string'
        or p_prepared_scope ->> 'scopeFingerprint' !~ '^sha256:[a-f0-9]{64}$'
      )
    )
    or (
      p_operation = 'grant_delegation'
      and (
        p_expected_delegation_revision is not null
        or p_holder_kind not in ('organization_account', 'group')
        or (
          p_holder_kind = 'organization_account'
          and (
            vortex_context.is_non_nil_uuid(
              p_organization_account_id::text
            ) is not true
            or p_group_id is not null
          )
        )
        or (
          p_holder_kind = 'group'
          and (
            vortex_context.is_non_nil_uuid(p_group_id::text) is not true
            or p_organization_account_id is not null
          )
        )
        or p_starts_at is null
        or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
        or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
        or (p_expires_at is not null and p_expires_at <= p_starts_at)
      )
    )
    or (
      p_operation = 'replace_delegation_scope'
      and (
        p_expected_delegation_revision is null
        or p_expected_delegation_revision not between 1 and 9007199254740991
        or p_holder_kind is not null
        or p_organization_account_id is not null
        or p_group_id is not null
        or p_starts_at is not null
        or p_expires_at is not null
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Private Organization delegation change input is invalid';
  end if;

  authority_after := case p_prepared_scope ->> 'kind'
    when 'organization_catalogue' then
      pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
    else vortex_access.private_management_scope_from_permission_evidence(
      p_prepared_scope -> 'permissions'
    )
  end;

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
      message = 'Private Organization delegation change is unavailable';
  end if;

  if p_operation = 'grant_delegation' then
    authority_before := pg_catalog.jsonb_build_object('kind', 'none');
  else
    select stored.* into delegation_fact
    from vortex_access.organization_delegation_authorities as stored
    where stored.organization_id = context_organization_id
      and stored.delegation_authority_id = p_delegation_authority_id
    for update;
    if not found
      or delegation_fact.revision is distinct from p_expected_delegation_revision
      or delegation_fact.state <> 'live' then
      raise exception using errcode = '40001',
        message = 'Private Organization delegation change is stale or unavailable';
    end if;
    authority_before := case delegation_fact.scope_kind
      when 'organization_catalogue' then
        pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      else vortex_access.private_management_scope_from_permission_evidence(
        delegation_fact.bounded_permissions
      )
    end;
  end if;

  operation_key := 'platform.organization.delegations.' ||
    case p_operation when 'grant_delegation' then 'grant' else 'replace' end;
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_key,
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
        'before', authority_before,
        'after', authority_after
      )
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from operation_key
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Private Organization delegation change is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_delegation_authority_change(
    p_operation, context_organization_id, p_delegation_authority_id,
    p_expected_delegation_revision, p_holder_kind,
    p_organization_account_id, p_group_id,
    p_prepared_scope ->> 'kind',
    case when p_prepared_scope ->> 'kind' = 'bounded'
      then p_prepared_scope -> 'permissions' else null end,
    case when p_prepared_scope ->> 'kind' = 'bounded'
      then p_prepared_scope ->> 'scopeFingerprint' else null end,
    p_starts_at, p_expires_at, context_account_id, context_correlation_id
  ) as result;

  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.delegation ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, p_operation,
    array[p_delegation_authority_id]::uuid[], array[]::uuid[],
    p_activity_source, context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Private Organization delegation Activity is stale';
  end if;

  return query select changed.outcome, changed.operation,
    changed.delegation, changed.access_version, changed.correlation_id;
exception
  when invalid_text_representation or invalid_parameter_value then
    raise exception using errcode = '22023',
      message = 'Private Organization delegation change input is invalid';
end
$function$;

revoke execute on function
  vortex_access.coordinate_private_organization_delegation_authority_change(
    text, uuid, bigint, text, uuid, uuid, jsonb,
    timestamptz, timestamptz, text, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create function vortex_access.coordinate_private_organization_role_authority_change(
  p_prepared_evidence jsonb,
  p_activity_source text,
  p_activity_id uuid
)
returns table (
  outcome text,
  operation text,
  role jsonb,
  created_activation_policy jsonb,
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
  candidate jsonb;
  operation_name text;
  operation_key text;
  target_organization_id uuid;
  target_role_id uuid;
  expected_role_revision bigint;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  authority_before jsonb;
  authority_after jsonb;
  policy_choice jsonb;
  policy_changed boolean;
  decision record;
  changed record;
  activity_result text;
begin
  if p_prepared_evidence is null
    or pg_catalog.jsonb_typeof(p_prepared_evidence) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_prepared_evidence -> 'candidate')
      is distinct from 'object'
    or p_activity_source is null
    or p_activity_source not in (
      'web', 'workflow', 'interface', 'connection', 'federation', 'system'
    )
    or vortex_context.is_non_nil_uuid(p_activity_id::text) is not true then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
  end if;

  candidate := p_prepared_evidence -> 'candidate';
  operation_name := candidate ->> 'operation';
  if operation_name is null or operation_name not in (
    'create_custom', 'create_custom_from_template',
    'accept_new_application_role', 'revise_metadata_policy',
    'revise_custom_permissions', 'accept_application_role_revision'
  )
    or pg_catalog.jsonb_typeof(candidate -> 'organizationId')
      is distinct from 'string'
    or not vortex_context.is_non_nil_uuid(candidate ->> 'organizationId')
    or pg_catalog.jsonb_typeof(candidate -> 'roleId') is distinct from 'string'
    or not vortex_context.is_non_nil_uuid(candidate ->> 'roleId') then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
  end if;
  target_organization_id := (candidate ->> 'organizationId')::uuid;
  target_role_id := (candidate ->> 'roleId')::uuid;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  if target_organization_id is distinct from context_organization_id then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

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
      message = 'Private Organization role-authority change is unavailable';
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    if exists (
      select 1 from vortex_access.organization_roles as stored
      where stored.organization_id = context_organization_id
        and stored.role_id = target_role_id
    ) then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    authority_before := pg_catalog.jsonb_build_object('kind', 'none');
  else
    if pg_catalog.jsonb_typeof(candidate -> 'expectedRoleRevision')
        is distinct from 'number'
      or (candidate ->> 'expectedRoleRevision')::numeric not between
        1 and 9007199254740991
      or (candidate ->> 'expectedRoleRevision')::numeric <>
        pg_catalog.trunc((candidate ->> 'expectedRoleRevision')::numeric) then
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    expected_role_revision :=
      (candidate ->> 'expectedRoleRevision')::numeric::bigint;
    select identity.* into role_identity
    from vortex_access.organization_roles as identity
    where identity.organization_id = context_organization_id
      and identity.role_id = target_role_id
    for update of identity;
    if not found or role_identity.live_revision is distinct from expected_role_revision then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = context_organization_id
      and revision.role_id = target_role_id
      and revision.revision = role_identity.live_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    authority_before := vortex_access.private_current_role_management_scope(
      context_organization_id, target_role_id, expected_role_revision
    );
  end if;

  if operation_name = 'revise_metadata_policy' then
    policy_choice := candidate -> 'assignmentPolicy';
    if pg_catalog.jsonb_typeof(policy_choice) is distinct from 'object'
      or pg_catalog.jsonb_typeof(policy_choice -> 'kind') is distinct from 'string'
      or policy_choice ->> 'kind' not in ('standing', 'activation_required') then
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    if policy_choice ->> 'kind' = 'standing' then
      policy_changed := current_revision.assignment_policy <> 'standing';
    elsif policy_choice #>> '{activationPolicy,selection}' = 'new' then
      policy_changed := true;
    elsif policy_choice #>> '{activationPolicy,selection}' = 'existing'
      and vortex_context.is_non_nil_uuid(
        policy_choice #>> '{activationPolicy,reference,activationPolicyId}'
      )
      and pg_catalog.jsonb_typeof(
        policy_choice #> '{activationPolicy,reference,revision}'
      ) = 'number'
      and (policy_choice #>>
        '{activationPolicy,reference,revision}')::numeric between
        1 and 9007199254740991
      and (policy_choice #>>
        '{activationPolicy,reference,revision}')::numeric =
        pg_catalog.trunc((policy_choice #>>
          '{activationPolicy,reference,revision}')::numeric)
      and pg_catalog.jsonb_typeof(
        policy_choice #> '{activationPolicy,reference,fingerprint}'
      ) = 'string'
      and policy_choice #>> '{activationPolicy,reference,fingerprint}'
        ~ '^sha256:[a-f0-9]{64}$' then
      policy_changed := current_revision.assignment_policy <> 'activation_required'
        or current_revision.activation_policy_id is distinct from
          (policy_choice #>>
            '{activationPolicy,reference,activationPolicyId}')::uuid
        or current_revision.activation_policy_revision is distinct from
          (policy_choice #>> '{activationPolicy,reference,revision}')::numeric::bigint
        or current_revision.activation_policy_fingerprint is distinct from
          policy_choice #>> '{activationPolicy,reference,fingerprint}';
    else
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    if policy_changed is not true then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority candidate changes no authority';
    end if;
    authority_after := authority_before;
  else
    authority_after := vortex_access.private_management_scope_from_permission_evidence(
      candidate -> 'permissions'
    );
  end if;

  if authority_before ->> 'kind' = 'none'
    and authority_after ->> 'kind' = 'none' then
    raise exception using errcode = '40001',
      message = 'Private Organization role-authority scope is unavailable';
  end if;

  operation_key := 'platform.organization.roles.' || operation_name;
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_key,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '87c96495-c806-4692-9bc2-250ddb10613c'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', authority_before,
        'after', authority_after
      )
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from operation_key
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_role_change(
    p_prepared_evidence, context_account_id, context_correlation_id
  ) as result;

  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.role ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, operation_name,
    array[target_role_id]::uuid[], array[]::uuid[], p_activity_source,
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Private Organization role-authority Activity is stale';
  end if;

  return query select changed.outcome, changed.operation, changed.role,
    changed.created_activation_policy, changed.access_version,
    changed.correlation_id;
exception
  when invalid_text_representation or invalid_parameter_value
      or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
end
$function$;

revoke execute on function
  vortex_access.coordinate_private_organization_role_authority_change(
    jsonb, text, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function
  vortex_access.coordinate_private_organization_delegation_authority_change(
    text, uuid, bigint, text, uuid, uuid, jsonb,
    timestamptz, timestamptz, text, uuid
  ) is
  'Owner-only grant/replacement composition. It requires current complete delegated scope, reuses the canonical delegation writer and Activity, and grants no invocation right.';

comment on function
  vortex_access.coordinate_private_organization_role_authority_change(
    jsonb, text, uuid
  ) is
  'Owner-only authority-establishing role composition. It checks exact current/candidate permission scope, then reuses canonical role evidence, manifests, stewardship and Activity without exposing a grant endpoint.';
