create or replace function vortex_identity.lock_organization_account_for_deletion_internal(
  p_organization_account_id uuid
)
returns table (
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
  select account.state, account.revision
  from vortex_identity.organization_accounts as account
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = (checked ->> 'organizationId')::uuid
  for update of account;
end
$function$;

revoke all on function vortex_identity.lock_organization_account_for_deletion_internal(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.lock_organization_account_for_deletion_internal(uuid) to vortex_record_adapter;

comment on function vortex_identity.lock_organization_account_for_deletion_internal(uuid) is
  'Private exclusive lock and state read that opens the account-deletion fence.';

alter function vortex_identity.lock_organization_account_for_deletion_internal(uuid) owner to vortex_identity_owner;
set role vortex_identity_owner;
grant execute on function vortex_identity.lock_organization_account_for_deletion_internal(uuid) to postgres;
reset role;
