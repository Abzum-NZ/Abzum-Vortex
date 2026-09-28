create or replace function vortex_identity.change_organization_account_state(
  p_organization_account_id uuid,
  p_expected_revision bigint,
  p_state text
)
returns table (
  organization_account_id uuid,
  organization_id uuid,
  identity_id uuid,
  display_name text,
  state text,
  language text,
  time_zone text,
  invitation_id uuid,
  activated_at timestamptz,
  suspended_at timestamptz,
  closed_at timestamptz,
  changed_at timestamptz,
  state_changed_at timestamptz,
  state_changed_by uuid,
  state_change_correlation_id uuid,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  checked := vortex_identity.validated_human_account_context();
  if p_state not in ('active', 'suspended', 'closed') then
    raise exception using errcode = '22023', message = 'Organisation-account state is invalid';
  end if;

  return query
  update vortex_identity.organization_accounts as account
  set state = p_state,
      activated_at = account.activated_at,
      suspended_at = case when p_state = 'suspended' then operation_at else account.suspended_at end,
      closed_at = case when p_state = 'closed' then operation_at else account.closed_at end,
      changed_at = operation_at,
      state_changed_at = operation_at,
      state_changed_by = (checked ->> 'organizationAccountId')::uuid,
      state_change_correlation_id = (checked ->> 'correlationId')::uuid,
      revision = account.revision + 1
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = (checked ->> 'organizationId')::uuid
    and account.revision = p_expected_revision
    and account.state is distinct from p_state
  returning account.organization_account_id, account.organization_id, account.identity_id,
    account.display_name, account.state, account.language, account.time_zone,
    account.originating_invitation_id, account.activated_at, account.suspended_at,
    account.closed_at, account.changed_at, account.state_changed_at,
    account.state_changed_by, account.state_change_correlation_id, account.revision;

  if not found then
    raise exception using errcode = '40001', message = 'Organisation account is stale or unavailable';
  end if;
end
$function$;

revoke all on function vortex_identity.change_organization_account_state(uuid, bigint, text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.change_organization_account_state(uuid, bigint, text) is null;

alter function vortex_identity.change_organization_account_state(uuid, bigint, text) owner to vortex_identity_owner;
set role vortex_identity_owner;
grant execute on function vortex_identity.change_organization_account_state(uuid, bigint, text) to postgres;
reset role;
