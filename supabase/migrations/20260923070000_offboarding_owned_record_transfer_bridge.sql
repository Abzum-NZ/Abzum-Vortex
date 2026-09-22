-- Account offboarding transfer bridge (#564).
--
-- The fixed record transfer deliberately keeps its retained-row/offboarding
-- entry adapter-only. This narrow request entry does not discover, batch,
-- delete or activate records: the identity runtime obtains one bounded #563
-- inventory page and calls this bridge once per already-disclosed record.

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

begin;

set local role vortex_record_adapter;

create function vortex_record.transfer_offboarding_owned_record(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_target_kind text,
  p_target_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_source_organization_account_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
begin
  -- Re-admit the current accounts.manage scope for every item. The nested
  -- fixed transfer then reloads record facts, locks the target and requires the
  -- caller's expected concurrency number before it can mutate anything.
  select authorized.* into strict scope
  from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;

  begin
    return vortex_record.transfer_record_ownership_for_offboarding_internal(
      p_command_id,
      p_record_type_id,
      p_record_id,
      p_expected_concurrency_number,
      p_target_kind,
      p_target_id,
      p_activity_id,
      p_occurrence_id,
      p_source_organization_account_id
    );
  exception
    when serialization_failure then
      -- A contested final update is an expected per-record result. The nested
      -- exception block rolls back its pending receipt before returning it.
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end;
end
$function$;

revoke all on function vortex_record.transfer_offboarding_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.transfer_offboarding_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) to vortex_request;
comment on function vortex_record.transfer_offboarding_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) is
  'Protected request entry for one disclosed account-offboarding transfer; it rechecks accounts.manage scope and delegates all target, owner, lifecycle and revision checks to the fixed adapter-only operation.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
