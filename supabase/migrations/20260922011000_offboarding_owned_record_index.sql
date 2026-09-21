-- Account-owner pages must not scan every retained business row. The catalogue
-- insert is the successful end of the live provisioning path, so this trigger
-- provisions the index for future account-owned tables and the loop below
-- backfills the already-provisioned catalogue.

set local role vortex_record_owner;

create function vortex_record.ensure_offboarding_owner_index_internal(
  p_physical_table_token text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  index_name text;
begin
  if p_physical_table_token is null
    or p_physical_table_token !~ '^rt_[a-f0-9]{32}$'
    or pg_catalog.to_regclass(pg_catalog.format('record_data.%I', p_physical_table_token)) is null then
    raise exception using errcode = '55000',
      message = 'Account-owner record storage is unavailable';
  end if;

  index_name := 'ix_' || p_physical_table_token || '_owner';
  execute pg_catalog.format(
    'create index if not exists %I on record_data.%I
       (organisation_id, owner_organisation_account_id)
       where owner_organisation_account_id is not null',
    index_name, p_physical_table_token
  );
end
$function$;

revoke all on function vortex_record.ensure_offboarding_owner_index_internal(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;

create function vortex_record.provision_offboarding_owner_index_internal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if new.state = 'active'
    and new.physical_schema_token = 'record_data'
    and new.record_type_definition ->> 'ownershipMode' = 'organization_account' then
    perform vortex_record.ensure_offboarding_owner_index_internal(new.physical_table_token);
  end if;
  return new;
end
$function$;

revoke all on function vortex_record.provision_offboarding_owner_index_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;

create trigger storage_catalogue_offboarding_owner_index
after insert on vortex_record.storage_catalogue
for each row execute function vortex_record.provision_offboarding_owner_index_internal();

do $block$
declare catalogue_row record;
begin
  for catalogue_row in
    select physical_table_token
    from vortex_record.storage_catalogue
    where state = 'active'
      and physical_schema_token = 'record_data'
      and record_type_definition ->> 'ownershipMode' = 'organization_account'
    order by storage_contract_id
  loop
    perform vortex_record.ensure_offboarding_owner_index_internal(
      catalogue_row.physical_table_token
    );
  end loop;
end
$block$;

comment on function vortex_record.ensure_offboarding_owner_index_internal(text) is
  'Private provisioner helper for the partial account-owner inventory index.';
comment on trigger storage_catalogue_offboarding_owner_index on vortex_record.storage_catalogue is
  'Provisions the account-owner partial index as each account-owned record table enters the live catalogue.';

reset role;
