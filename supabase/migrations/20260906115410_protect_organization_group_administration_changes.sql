-- Protected empty-Group creation and label revision compose the existing Group
-- writer with one fixed permission decision and one content-free Activity entry.
-- Request input never selects an authority, organization, actor or correlation.
create function vortex_access.create_organization_group_for_administration(
  p_group_id uuid,
  p_group_key text,
  p_label text,
  p_activity_id uuid
)
returns table (
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
  decision record;
  changed record;
  activity_result text;
begin
  if p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
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

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.groups.create'
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
    context_organization_id,
    p_activity_id,
    changed.changed_at,
    'organization_account',
    context_account_id,
    'create_group',
    array[p_group_id]::uuid[],
    array[]::uuid[],
    'web',
    context_correlation_id,
    'completed'
  );

  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization Group creation Activity is stale';
  end if;

  return query select context_organization_id,
    pg_catalog.jsonb_build_object(
      'groupId', changed.group_id,
      'key', changed.group_key,
      'label', changed.label,
      'state', changed.state,
      'revision', changed.revision
    ),
    changed.access_version;
end
$function$;

create function vortex_access.rename_organization_group_for_administration(
  p_group_id uuid,
  p_expected_group_revision bigint,
  p_label text,
  p_activity_id uuid
)
returns table (
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
  decision record;
  changed record;
  activity_result text;
begin
  if p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group label revision input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.groups.rename',
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

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.groups.rename'
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization Group label revision is unavailable';
  end if;

  select group_change.* into strict changed
  from vortex_access.coordinate_organization_group_change(
    'revise_group_label', context_organization_id, p_group_id,
    p_expected_group_revision, null, p_label,
    context_account_id, context_correlation_id
  ) as group_change;

  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id,
    p_activity_id,
    changed.changed_at,
    'organization_account',
    context_account_id,
    'revise_group_label',
    array[p_group_id]::uuid[],
    array[]::uuid[],
    'web',
    context_correlation_id,
    'completed'
  );

  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization Group label revision Activity is stale';
  end if;

  return query select context_organization_id,
    pg_catalog.jsonb_build_object(
      'groupId', changed.group_id,
      'key', changed.group_key,
      'label', changed.label,
      'state', changed.state,
      'revision', changed.revision
    ),
    changed.access_version;
end
$function$;

revoke execute on function
  vortex_access.create_organization_group_for_administration(uuid, text, text, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
revoke execute on function
  vortex_access.rename_organization_group_for_administration(uuid, bigint, text, uuid)
from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function
  vortex_access.create_organization_group_for_administration(uuid, text, text, uuid)
to vortex_request;
grant execute on function
  vortex_access.rename_organization_group_for_administration(uuid, bigint, text, uuid)
to vortex_request;

comment on function
  vortex_access.create_organization_group_for_administration(uuid, text, text, uuid) is
  'Creates one empty Group after fixed teams-manage authorization and atomically records its content-free Activity entry.';
comment on function
  vortex_access.rename_organization_group_for_administration(uuid, bigint, text, uuid) is
  'Revises one Group label after fixed teams-manage authorization and atomically records its content-free Activity entry.';
