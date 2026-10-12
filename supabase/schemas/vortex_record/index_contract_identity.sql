CREATE FUNCTION vortex_record.index_contract_identity(p_storage_contract_id uuid, p_field_id uuid) RETURNS uuid
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select (
    pg_catalog.substr(source.digest_hex, 1, 12)
    || '8'
    || pg_catalog.substr(source.digest_hex, 14, 3)
    || pg_catalog.substr(
      '89ab',
      (pg_catalog.strpos(
        '0123456789abcdef', pg_catalog.substr(source.digest_hex, 17, 1)
      ) - 1) % 4 + 1,
      1
    )
    || pg_catalog.substr(source.digest_hex, 18, 15)
  )::uuid
  from (
    select pg_catalog.md5(
      pg_catalog.lower(p_storage_contract_id::text) || ':'
        || pg_catalog.lower(p_field_id::text)
    ) as digest_hex
  ) as source
$$;

REVOKE ALL ON FUNCTION vortex_record.index_contract_identity(p_storage_contract_id uuid, p_field_id uuid) FROM PUBLIC;
