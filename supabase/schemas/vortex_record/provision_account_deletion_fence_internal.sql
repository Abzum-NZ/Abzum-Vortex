CREATE FUNCTION vortex_record.provision_account_deletion_fence_internal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.physical_schema_token = 'record_data' then
    perform vortex_record.ensure_account_deletion_fence_internal(new.physical_table_token);
  end if;
  return new;
end
$$;
alter function vortex_record.provision_account_deletion_fence_internal() owner to vortex_owner;


REVOKE ALL ON FUNCTION vortex_record.provision_account_deletion_fence_internal() FROM PUBLIC;
