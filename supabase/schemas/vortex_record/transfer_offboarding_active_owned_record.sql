create or replace function vortex_record.transfer_offboarding_active_owned_record(
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
    return vortex_record.apply_lifecycle_record_changes_internal(
      'transfer_ownership',
      p_command_id,
      p_record_type_id,
      p_record_id,
      p_expected_concurrency_number,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind', 'transfer_ownership',
        'targetKind', p_target_kind,
        'targetId', p_target_id
      )),
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
  'Protected request entry for one disclosed account-offboarding transfer of an ordinary active record; it rechecks accounts.manage scope and delegates all target, owner, lifecycle, authority and revision checks to the one record-change operation''s terminal ownership transfer.';
