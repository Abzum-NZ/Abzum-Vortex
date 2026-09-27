create or replace function vortex_access.begin_organization_account_closing_for_administration(
  p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  organization_account_id uuid,
  organization_id uuid,
  state text,
  closing_at timestamptz,
  revision bigint,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  target record;
  changed record;
  resulting_version bigint;
begin
  if p_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account closing command is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;

  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;

  if not found or target.state not in ('active', 'suspended', 'closed')
    or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account closing is stale or unavailable';
  end if;

  select result.* into strict changed
  from vortex_identity.begin_organization_account_closing(
    p_organization_account_id, p_expected_revision
  ) as result;

  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'closing' or changed.revision <> p_expected_revision + 1 then
    raise exception using errcode = '42501', message = 'Account closing result is unavailable';
  end if;

  select incremented.current_version into strict resulting_version
  from vortex_access.increment_organization_access_version(
    scope.organization_id,
    scope.organization_account_id,
    changed.state_change_correlation_id,
    'organization_account_closed'
  ) as incremented;

  if resulting_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account closing result is unavailable';
  end if;

  perform vortex_access.assert_organization_has_permanent_steward(scope.organization_id);

  return query select changed.organization_account_id, changed.organization_id,
    changed.state, changed.closing_at, changed.revision, resulting_version;
end
$function$;

comment on function vortex_access.begin_organization_account_closing_for_administration(uuid, bigint) is
  'Protected one-way active/suspended/closed-to-closing account command under accounts.manage; deletion is a separate, later fence.';

revoke all on function vortex_access.begin_organization_account_closing_for_administration(uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_access.begin_organization_account_closing_for_administration(uuid, bigint) to vortex_request;
