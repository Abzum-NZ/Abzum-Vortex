create or replace function vortex_access.coordinate_private_organization_delegation_authority_change(
  p_operation text,
  p_delegation_authority_id uuid,
  p_expected_delegation_revision bigint,
  p_holder_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_prepared_scope jsonb,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
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
    vortex_context.channel(), context_correlation_id, 'completed'
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

revoke execute on function vortex_access.coordinate_private_organization_delegation_authority_change(text, uuid, bigint, text, uuid, uuid, jsonb, timestamptz, timestamptz, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_private_organization_delegation_authority_change(text, uuid, bigint, text, uuid, uuid, jsonb, timestamptz, timestamptz, uuid) is
  'Owner-only grant/replacement composition. It requires current complete delegated scope, reuses the canonical delegation writer and Activity, and grants no invocation right.';
