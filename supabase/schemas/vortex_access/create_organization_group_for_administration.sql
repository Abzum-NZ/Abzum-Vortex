create or replace function vortex_access.create_organization_group_for_administration(
  p_group_id uuid,
  p_group_key text,
  p_label text,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  group_summary jsonb,
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
  decision record;
  changed record;
  activity_result text;
begin
  if p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_group_key is null
    or pg_catalog.char_length(p_group_key) not between 1 and 40
    or p_group_key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_label is null
    or p_label <> pg_catalog.btrim(p_label)
    or pg_catalog.char_length(p_label) not between 1 and 60
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group creation input is invalid';
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
      message = 'Organization Group creation is unavailable';
  end if;

  if exists (
    select 1
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = context_organization_id
      and (
        organization_group.group_id = p_group_id
        or organization_group.group_key = p_group_key
      )
  ) then
    raise exception using errcode = '40001',
      message = 'Organization Group creation is stale or unavailable';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.groups.create',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '6185dc64-464b-4776-97dc-c64a6f299550'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.groups.create'
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
      'organization_account', context_account_id, 'create_group',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_context.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization Group creation refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.groups.create'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization Group creation is unavailable';
  end if;

  select group_change.* into strict changed
  from vortex_access.coordinate_organization_group_change(
    'create_group', context_organization_id, p_group_id, null,
    p_group_key, p_label, context_account_id, context_correlation_id
  ) as group_change;

  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed.changed_at,
    'organization_account', context_account_id, 'create_group',
    array[p_group_id]::uuid[], array[]::uuid[], vortex_context.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization Group creation Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id,
    pg_catalog.jsonb_build_object(
      'groupId', changed.group_id, 'key', changed.group_key,
      'label', changed.label, 'state', changed.state,
      'revision', changed.revision
    ), changed.access_version;
end
$function$;

revoke execute on function vortex_access.create_organization_group_for_administration(uuid, text, text, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.create_organization_group_for_administration(uuid, text, text, uuid)
to vortex_request;

comment on function vortex_access.create_organization_group_for_administration(uuid, text, text, uuid) is
  'Standalone request entry: creates one empty Group after fixed teams-manage authorization, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';
