create or replace function vortex_access.revoke_organization_direct_record_share(
  p_organization_id uuid,
  p_direct_share_id uuid,
  p_expected_revision bigint,
  p_reason text,
  p_changed_by uuid,
  p_correlation_id uuid,
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
    or not vortex_context.is_non_nil_uuid(p_activity_id::text) then
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
    array[]::uuid[], vortex_context.channel(), p_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Direct record-share revocation Activity is stale';
  end if;

  return query select p_direct_share_id, current_share.revision + 1,
    'revoked'::text, operation_at, next_access_version;
end
$function$;

revoke execute on function vortex_access.revoke_organization_direct_record_share(
  uuid, uuid, bigint, text, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.revoke_organization_direct_record_share(
  uuid, uuid, bigint, text, uuid, uuid, uuid
) is
  'Owner-only terminal direct-share revocation writer. It changes Access and appends Activity but grants no caller authority.';
