create or replace function vortex_record.ensure_record_owner_account_fence_internal(
  p_physical_table_token text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_physical_table_token is null
    or p_physical_table_token !~ '^rt_[a-f0-9]{32}$'
    or pg_catalog.to_regclass(
      pg_catalog.format('record_data.%I', p_physical_table_token)
    ) is null then
    raise exception using errcode = '55000',
      message = 'Record owner-account fence storage is unavailable';
  end if;

  execute pg_catalog.format(
    'drop trigger if exists record_owner_account_fence on record_data.%I',
    p_physical_table_token
  );
  execute pg_catalog.format(
    'create trigger record_owner_account_fence
       before insert or update of owner_organisation_account_id, organisation_id
       on record_data.%I
       for each row execute function vortex_access.fence_record_owner_account_target_internal()',
    p_physical_table_token
  );
end
$function$;

alter function vortex_record.ensure_record_owner_account_fence_internal(text) owner to vortex_owner;

revoke all on function vortex_record.ensure_record_owner_account_fence_internal(text) from public;

comment on function vortex_record.ensure_record_owner_account_fence_internal(text) is
  'Private provisioner for one Record table: the row trigger that keeps an assigned account owner active in the row organisation.';
