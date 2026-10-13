CREATE FUNCTION vortex_record.index_definition_fingerprint(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select 'sha256:' || pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        vortex_record.index_definition(
          p_purpose, p_table_token, p_scope_index_columns, p_column_token
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;
alter function vortex_record.index_definition_fingerprint(text,text,text,text) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.index_definition_fingerprint(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) IS 'Canonical sha256 fingerprint of one exact desired field-index definition, using the same convention as record storage content fingerprints.';

REVOKE ALL ON FUNCTION vortex_record.index_definition_fingerprint(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) FROM PUBLIC;
