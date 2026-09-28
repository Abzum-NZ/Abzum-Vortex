create or replace function vortex_identity.finalize_organization_account_deletion(
  p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  organization_account_id uuid,
  organization_id uuid,
  state text,
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
  set state = 'deleted',
      deleted_at = greatest(
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
    and account.state = 'closing'
  returning account.organization_account_id, account.organization_id, account.state,
    account.revision;

  if not found then
    raise exception using errcode = '40001', message = 'Organisation account deletion is stale or unavailable';
  end if;
end
$function$;

revoke all on function vortex_identity.finalize_organization_account_deletion(uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.finalize_organization_account_deletion(uuid, bigint) to vortex_record_adapter;

comment on function vortex_identity.finalize_organization_account_deletion(uuid, bigint) is
  'Private closing-to-deleted transition, reachable only through the Record deletion fence after its inventory proves nothing is owned.';

alter function vortex_identity.finalize_organization_account_deletion(uuid, bigint) owner to vortex_identity_owner;
