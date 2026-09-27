create or replace function vortex_record.list_offboarding_owned_records(
  p_source_organization_account_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_section_kind text,
  p_after_storage_contract_id uuid default null,
  p_after_record_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  inventory jsonb;
begin
  select authorized.* into strict scope
  from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;

  if p_section_kind = 'organization_shared' then
    inventory := vortex_record.list_offboarding_owned_shared_records_internal(
      p_source_organization_account_id, p_target_kind, p_target_id,
      p_after_storage_contract_id, p_after_record_id, p_limit
    );
    return inventory || pg_catalog.jsonb_build_object('accessVersion', scope.access_version);
  end if;
  if p_section_kind is distinct from 'application' then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory section is invalid';
  end if;

  inventory := vortex_record.list_offboarding_owned_records_internal(
    p_source_organization_account_id, p_target_kind, p_target_id,
    p_after_storage_contract_id, p_after_record_id, p_limit
  );
  return inventory || pg_catalog.jsonb_build_object('accessVersion', scope.access_version);
end
$function$;

alter function vortex_record.list_offboarding_owned_records(uuid, text, uuid, text, uuid, uuid, integer) owner to vortex_record_adapter;

revoke all on function vortex_record.list_offboarding_owned_records(
  uuid, text, uuid, text, uuid, uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_record.list_offboarding_owned_records(
  uuid, text, uuid, text, uuid, uuid, integer
) to vortex_request;

grant execute on function vortex_record.list_offboarding_owned_records(
  uuid, text, uuid, text, uuid, uuid, integer
) to vortex_record_adapter;

revoke all on function vortex_record.list_offboarding_owned_records(
  uuid, text, uuid, text, uuid, uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_record.list_offboarding_owned_records(
  uuid, text, uuid, text, uuid, uuid, integer
) to vortex_request;

comment on function vortex_record.list_offboarding_owned_records(
  uuid, text, uuid, text, uuid, uuid, integer
) is
  'Protected account-offboarding inventory: accounts.manage once and per-record exact transfer disclosure for the application-contained and organisation-shared sections.';
