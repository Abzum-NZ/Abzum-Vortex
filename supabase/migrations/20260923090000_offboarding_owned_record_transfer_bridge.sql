-- Account offboarding transfer bridge (#564).
--
-- The fixed record transfer deliberately keeps its retained-row/offboarding
-- entry adapter-only, and grants its ordinary entry to the runtime role rather
-- than to Request. These two narrow request entries do not discover, batch,
-- delete or activate records: the identity runtime obtains one bounded #563
-- inventory page and calls one of them once per already-disclosed record, the
-- retained entry for a retained row or a disabled installation and the active
-- entry for an ordinary active record. Each re-admits accounts.manage and then
-- delegates every ownership decision to the unchanged fixed operation.
--
-- Each entry also fences the admitted access version against the one the page
-- was disclosed under, so every record of one batch is transferred in a single
-- authorisation state. A concurrent access change refuses the remaining records
-- instead of silently continuing the batch under a different authority.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

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
  p_source_organization_account_id uuid,
  p_expected_access_version bigint
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
  if p_expected_access_version is null
    or scope.access_version is distinct from p_expected_access_version then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'access_changed');
  end if;

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
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.transfer_offboarding_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid, bigint
) to vortex_request;
comment on function vortex_record.transfer_offboarding_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid, bigint
) is
  'Protected request entry for one disclosed account-offboarding retained or disabled-installation transfer; it rechecks accounts.manage scope and delegates all target, owner, lifecycle and revision checks to the fixed adapter-only operation.';

-- The retained entry above is deliberately narrow: while an installation is
-- active it accepts only a soft-deleted row. An ordinary active record of an
-- active installation therefore belongs to the ordinary protected ownership
-- action, which offboarding reaches through this second equally narrow entry.
-- It adds nothing to that operation: the same accounts.manage re-admission,
-- then the unchanged fixed transfer, which reloads the record under the active
-- installation, evaluates current transfer authority, locks the target and
-- requires the disclosed expected revision before it can mutate anything.
--
-- The fixed operation takes no source account, so the source binding on this
-- path is that expected revision: the inventory disclosed the row while the
-- closing account owned it, and any ownership change since increments the
-- revision and turns this into a conflict instead of a transfer.
create function vortex_record.transfer_offboarding_active_owned_record(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_target_kind text,
  p_target_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_expected_access_version bigint
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
  select authorized.* into strict scope
  from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;
  if p_expected_access_version is null
    or scope.access_version is distinct from p_expected_access_version then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'access_changed');
  end if;

  begin
    return vortex_record.transfer_record_ownership(
      p_command_id,
      p_record_type_id,
      p_record_id,
      p_expected_concurrency_number,
      p_target_kind,
      p_target_id,
      p_activity_id,
      p_occurrence_id
    );
  exception
    when serialization_failure then
      -- Identical per-record boundary to the retained entry: a contested final
      -- update rolls back its own pending receipt and is reported as a
      -- conflict, so one contested record never fails the whole batch.
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end;
end
$function$;

revoke all on function vortex_record.transfer_offboarding_active_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.transfer_offboarding_active_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, bigint
) to vortex_request;
comment on function vortex_record.transfer_offboarding_active_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, bigint
) is
  'Protected request entry for one disclosed account-offboarding transfer of an ordinary active record; it rechecks accounts.manage scope and delegates all target, owner, lifecycle, authority and revision checks to the unchanged fixed ownership transfer.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
