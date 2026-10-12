CREATE FUNCTION vortex_record.index_scope_columns(p_storage_scope text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case p_storage_scope
    when 'organization_shared' then 'organisation_id'
    when 'application_contained' then 'organisation_id, application_root_id'
    else null
  end
$$;

REVOKE ALL ON FUNCTION vortex_record.index_scope_columns(p_storage_scope text) FROM PUBLIC;
