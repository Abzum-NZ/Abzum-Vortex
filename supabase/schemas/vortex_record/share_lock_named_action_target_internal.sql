create or replace function vortex_record.share_lock_named_action_target_internal(
  p_catalogue jsonb,
  p_record_type_id uuid,
  p_record_id uuid
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type jsonb;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;

  select item.value into record_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') =
    pg_catalog.lower(p_record_type_id::text);
  if record_type is null or not exists (
    select 1
    from vortex_record.storage_catalogue as stored
    where stored.storage_contract_id = (record_type ->> 'storageContractId')::uuid
      and stored.record_type_id = p_record_type_id
      and stored.state = 'active'
  ) then
    return false;
  end if;

  context_value := vortex_access.validated_human_request_context();
  begin
    perform vortex_record.lock_relationship_target_row_internal(
      p_record_type_id, p_record_id,
      (context_value ->> 'organizationId')::uuid
    );
    return true;
  exception when no_data_found then
    return false;
  end;
end
$function$;

alter function vortex_record.share_lock_named_action_target_internal(jsonb, uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.share_lock_named_action_target_internal(jsonb, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

grant execute on function vortex_record.share_lock_named_action_target_internal(jsonb, uuid, uuid)
  to vortex_record_adapter;

comment on function vortex_record.share_lock_named_action_target_internal(jsonb, uuid, uuid) is
  'Private named-action preflight target lock: checks the installed target contract, then takes the canonical active same-organisation record or protected projection lock before later command locks.';
