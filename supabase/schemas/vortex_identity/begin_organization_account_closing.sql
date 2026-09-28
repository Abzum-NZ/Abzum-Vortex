create or replace function vortex_identity.begin_organization_account_closing(
  p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  organization_account_id uuid,
  organization_id uuid,
  state text,
  closing_at timestamptz,
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
begin
  checked := vortex_identity.validated_human_account_context();

  return query
  update vortex_identity.organization_accounts as account
  set state = 'closing',
      closing_at = greatest(
        pg_catalog.statement_timestamp(), account.changed_at, account.state_changed_at
      ),
      activated_at = account.activated_at,
      changed_at = greatest(
        pg_catalog.statement_timestamp(), account.changed_at, account.state_changed_at
      ),
      state_changed_at = greatest(
        pg_catalog.statement_timestamp(), account.changed_at, account.state_changed_at
      ),
      state_changed_by = (checked ->> 'organizationAccountId')::uuid,
      state_change_correlation_id = (checked ->> 'correlationId')::uuid,
      revision = account.revision + 1
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = (checked ->> 'organizationId')::uuid
    and account.revision = p_expected_revision
    and account.state in ('active', 'suspended', 'closed')
  returning account.organization_account_id, account.organization_id, account.state,
    account.closing_at, account.state_change_correlation_id, account.revision;

  if not found then
    raise exception using errcode = '40001', message = 'Organisation account closing is stale or unavailable';
  end if;
end
$function$;

revoke all on function vortex_identity.begin_organization_account_closing(uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.begin_organization_account_closing(uuid, bigint) is
  'Owner-only active/suspended/closed-to-closing transition; Access composes it with version invalidation and stewardship.';

alter function vortex_identity.begin_organization_account_closing(uuid, bigint) owner to vortex_identity_owner;
set role vortex_identity_owner;
grant execute on function vortex_identity.begin_organization_account_closing(uuid, bigint) to postgres;
reset role;
