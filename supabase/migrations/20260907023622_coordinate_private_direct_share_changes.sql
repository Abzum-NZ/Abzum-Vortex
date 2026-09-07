-- Private structural writers for direct-record sharing. These functions make no
-- grantor permission or field-ceiling decision; #37 owns that protected caller.

create function vortex_access.grant_organization_direct_record_share(
  p_organization_id uuid,
  p_direct_share_id uuid,
  p_storage_scope text,
  p_application_root_id uuid,
  p_module_root_id uuid,
  p_record_type_id uuid,
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_recipient_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_readable_field_ids uuid[],
  p_changeable_field_ids uuid[],
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_reason text,
  p_changed_by uuid,
  p_correlation_id uuid,
  p_activity_source text,
  p_activity_id uuid
)
returns table (
  direct_share_id uuid,
  revision bigint,
  state text,
  changed_at timestamptz,
  access_version bigint
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  operation_at timestamptz;
  next_access_version bigint;
  activity_result text;
begin
  if p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_direct_share_id is null
    or not vortex_context.is_non_nil_uuid(p_direct_share_id::text)
    or p_module_root_id is null
    or not vortex_context.is_non_nil_uuid(p_module_root_id::text)
    or p_record_type_id is null
    or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or p_storage_contract_id is null
    or not vortex_context.is_non_nil_uuid(p_storage_contract_id::text)
    or p_record_id is null
    or not vortex_context.is_non_nil_uuid(p_record_id::text)
    or p_changed_by is null
    or not vortex_context.is_non_nil_uuid(p_changed_by::text)
    or p_correlation_id is null
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text)
    or p_activity_id is null
    or not vortex_context.is_non_nil_uuid(p_activity_id::text)
    or p_activity_source not in (
      'web', 'workflow', 'interface', 'connection', 'federation', 'system'
    )
    or p_storage_scope not in ('organization_shared', 'application_contained')
    or (p_storage_scope = 'organization_shared' and p_application_root_id is not null)
    or (p_storage_scope = 'application_contained' and (
      p_application_root_id is null
      or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    ))
    or p_recipient_kind not in ('organization_account', 'group')
    or (p_recipient_kind = 'organization_account' and (
      p_organization_account_id is null
      or not vortex_context.is_non_nil_uuid(p_organization_account_id::text)
      or p_group_id is not null
    ))
    or (p_recipient_kind = 'group' and (
      p_group_id is null
      or not vortex_context.is_non_nil_uuid(p_group_id::text)
      or p_organization_account_id is not null
    ))
    or p_readable_field_ids is null
    or pg_catalog.cardinality(p_readable_field_ids) = 0
    or not vortex_access.direct_share_field_ids_are_canonical(p_readable_field_ids)
    or p_changeable_field_ids is null
    or not vortex_access.direct_share_field_ids_are_canonical(p_changeable_field_ids)
    or not (p_changeable_field_ids <@ p_readable_field_ids)
    or p_starts_at is null
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and p_expires_at <= p_starts_at)
    or p_reason is null
    or pg_catalog.char_length(p_reason) not between 1 and 500 then
    raise exception using errcode = '22023',
      message = 'Direct record-share grant input is invalid';
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
      message = 'Direct record-share grant scope is unavailable';
  end if;

  if p_recipient_kind = 'organization_account' then
    perform 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active';
  else
    perform 1
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = p_organization_id
      and organization_group.group_id = p_group_id
      and organization_group.state = 'active';
  end if;
  if not found then
    raise exception using errcode = '42501',
      message = 'Direct record-share recipient is unavailable';
  end if;

  if exists (
    select 1
    from vortex_access.organization_direct_record_shares as share
    where share.organization_id = p_organization_id
      and share.direct_share_id = p_direct_share_id
  ) then
    raise exception using errcode = '40001',
      message = 'Direct record-share grant is stale or unavailable';
  end if;

  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at is not null and p_expires_at <= operation_at then
    raise exception using errcode = '40001',
      message = 'Direct record-share grant window is stale';
  end if;
  insert into vortex_access.organization_direct_record_shares (
    organization_id, direct_share_id, storage_scope, application_root_id,
    module_root_id, record_type_id, storage_contract_id, record_id,
    recipient_kind, organization_account_id, group_id, readable_field_ids,
    changeable_field_ids, starts_at, expires_at, state, revision, granted_by,
    granted_at, grant_correlation_id, reason, changed_at
  ) values (
    p_organization_id, p_direct_share_id, p_storage_scope,
    p_application_root_id, p_module_root_id, p_record_type_id,
    p_storage_contract_id, p_record_id, p_recipient_kind,
    p_organization_account_id, p_group_id, p_readable_field_ids,
    p_changeable_field_ids, p_starts_at, p_expires_at, 'active', 1,
    p_changed_by, operation_at, p_correlation_id, p_reason, operation_at
  );

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'direct_share_changed'
  ) as version;

  activity_result := vortex_activity.append_organization_activity_entry(
    p_organization_id, p_activity_id, operation_at, 'organization_account',
    p_changed_by, 'grant_direct_record_share', array[p_direct_share_id]::uuid[],
    array[]::uuid[], p_activity_source, p_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Direct record-share grant Activity is stale';
  end if;

  return query select p_direct_share_id, 1::bigint, 'active'::text,
    operation_at, next_access_version;
end
$function$;

create function vortex_access.revoke_organization_direct_record_share(
  p_organization_id uuid,
  p_direct_share_id uuid,
  p_expected_revision bigint,
  p_reason text,
  p_changed_by uuid,
  p_correlation_id uuid,
  p_activity_source text,
  p_activity_id uuid
)
returns table (
  direct_share_id uuid,
  revision bigint,
  state text,
  changed_at timestamptz,
  access_version bigint
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  current_share vortex_access.organization_direct_record_shares%rowtype;
  operation_at timestamptz;
  next_access_version bigint;
  activity_result text;
begin
  if p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_direct_share_id is null
    or not vortex_context.is_non_nil_uuid(p_direct_share_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_reason is null
    or pg_catalog.char_length(p_reason) not between 1 and 500
    or p_changed_by is null
    or not vortex_context.is_non_nil_uuid(p_changed_by::text)
    or p_correlation_id is null
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text)
    or p_activity_id is null
    or not vortex_context.is_non_nil_uuid(p_activity_id::text)
    or p_activity_source not in (
      'web', 'workflow', 'interface', 'connection', 'federation', 'system'
    ) then
    raise exception using errcode = '22023',
      message = 'Direct record-share revocation input is invalid';
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
      message = 'Direct record-share revocation scope is unavailable';
  end if;

  select share.* into current_share
  from vortex_access.organization_direct_record_shares as share
  where share.organization_id = p_organization_id
    and share.direct_share_id = p_direct_share_id
  for update;
  if not found
    or current_share.state <> 'active'
    or current_share.revision <> p_expected_revision then
    raise exception using errcode = '40001',
      message = 'Direct record-share revocation is stale or unavailable';
  end if;
  if current_share.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Direct record-share revision is exhausted';
  end if;

  operation_at := greatest(current_share.changed_at, pg_catalog.clock_timestamp());
  update vortex_access.organization_direct_record_shares as share
  set state = 'revoked', revision = current_share.revision + 1,
      revoked_by = p_changed_by, revoked_at = operation_at,
      revocation_correlation_id = p_correlation_id,
      revocation_reason = p_reason, changed_at = operation_at
  where share.organization_id = p_organization_id
    and share.direct_share_id = p_direct_share_id
    and share.state = 'active'
    and share.revision = p_expected_revision;
  if not found then
    raise exception using errcode = '40001',
      message = 'Direct record-share revocation is stale or unavailable';
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'direct_share_changed'
  ) as version;

  activity_result := vortex_activity.append_organization_activity_entry(
    p_organization_id, p_activity_id, operation_at, 'organization_account',
    p_changed_by, 'revoke_direct_record_share', array[p_direct_share_id]::uuid[],
    array[]::uuid[], p_activity_source, p_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Direct record-share revocation Activity is stale';
  end if;

  return query select p_direct_share_id, current_share.revision + 1,
    'revoked'::text, operation_at, next_access_version;
end
$function$;

revoke execute on function vortex_access.grant_organization_direct_record_share(
  uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid[],
  uuid[], timestamptz, timestamptz, text, uuid, uuid, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.revoke_organization_direct_record_share(
  uuid, uuid, bigint, text, uuid, uuid, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.grant_organization_direct_record_share(
  uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid[],
  uuid[], timestamptz, timestamptz, text, uuid, uuid, text, uuid
) is
  'Owner-only structural direct-share grant writer. It changes Access and appends Activity but makes no grantor authorization or field-ceiling decision.';
comment on function vortex_access.revoke_organization_direct_record_share(
  uuid, uuid, bigint, text, uuid, uuid, text, uuid
) is
  'Owner-only terminal direct-share revocation writer. It changes Access and appends Activity but grants no caller authority.';
