create or replace function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740991) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  return vortex_record.load_record_access_facts_from_installation_internal(
    p_record_type_id, 'transfer', p_record_id, p_expected_concurrency_number, p_installation
  );
end
$function$;

revoke all on function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  uuid, uuid, bigint, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  uuid, uuid, bigint, jsonb
) to vortex_record_adapter;
comment on function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  uuid, uuid, bigint, jsonb
) is
  'Private complete record-scope fact loader for transfer, parameterised only by an exact trusted installation.';
