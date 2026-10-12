CREATE FUNCTION vortex_record.ensure_account_deletion_fence_internal(p_physical_table_token text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  relation_id oid;
begin
  if p_physical_table_token is null
    or p_physical_table_token !~ '^rt_[a-f0-9]{32}$' then
    raise exception using errcode = '55000',
      message = 'Account-deletion fence storage is unavailable';
  end if;
  relation_id := pg_catalog.to_regclass(
    pg_catalog.format('record_data.%I', p_physical_table_token)
  );
  if relation_id is null then
    raise exception using errcode = '55000',
      message = 'Account-deletion fence storage is unavailable';
  end if;

  perform vortex_record.ensure_offboarding_owner_index_internal(p_physical_table_token);

  execute pg_catalog.format(
    'grant select on record_data.%I to vortex_record_inventory', p_physical_table_token
  );
  if not exists (
    select 1 from pg_catalog.pg_policy as policy
    where policy.polrelid = relation_id
      and policy.polname = 'record_account_deletion_inventory'
  ) then
    execute pg_catalog.format(
      'create policy record_account_deletion_inventory on record_data.%I
         for select to vortex_record_inventory
         using (organisation_id = vortex_context.organization_id())',
      p_physical_table_token
    );
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
$_$;

COMMENT ON FUNCTION vortex_record.ensure_account_deletion_fence_internal(p_physical_table_token text) IS 'Private provisioner for one Record table: owner index, inventory read policy and the ownership fence trigger.';

REVOKE ALL ON FUNCTION vortex_record.ensure_account_deletion_fence_internal(p_physical_table_token text) FROM PUBLIC;
