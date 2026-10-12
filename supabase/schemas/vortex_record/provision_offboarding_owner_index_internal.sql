CREATE FUNCTION vortex_record.provision_offboarding_owner_index_internal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.state = 'active'
    and new.physical_schema_token = 'record_data'
    and new.record_type_definition ->> 'ownershipMode' = 'organization_account' then
    perform vortex_record.ensure_offboarding_owner_index_internal(new.physical_table_token);
  end if;
  return new;
end
$$;

REVOKE ALL ON FUNCTION vortex_record.provision_offboarding_owner_index_internal() FROM PUBLIC;
