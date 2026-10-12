CREATE FUNCTION vortex_record.ensure_offboarding_owner_index_internal(p_physical_table_token text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
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
$_$;

COMMENT ON FUNCTION vortex_record.ensure_offboarding_owner_index_internal(p_physical_table_token text) IS 'Private provisioner helper for the partial account-owner inventory index.';

REVOKE ALL ON FUNCTION vortex_record.ensure_offboarding_owner_index_internal(p_physical_table_token text) FROM PUBLIC;
