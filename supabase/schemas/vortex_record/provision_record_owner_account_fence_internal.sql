create or replace function vortex_record.provision_record_owner_account_fence_internal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.physical_schema_token = 'record_data' then
    perform vortex_record.ensure_record_owner_account_fence_internal(new.physical_table_token);
  end if;
  return new;
end
$function$;

alter function vortex_record.provision_record_owner_account_fence_internal() owner to vortex_owner;

revoke all on function vortex_record.provision_record_owner_account_fence_internal() from public;

comment on function vortex_record.provision_record_owner_account_fence_internal() is
  'Storage catalogue trigger: gives every new Record table its owner-account fence.';
