CREATE FUNCTION vortex_record.storage_meaning_fingerprint(p_record_type jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select 'sha256:' || pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(vortex_record.storage_meaning(p_record_type)::text, 'UTF8'), 'sha256'),
    'hex'
  )
$$;
alter function vortex_record.storage_meaning_fingerprint(jsonb) owner to vortex_owner;


REVOKE ALL ON FUNCTION vortex_record.storage_meaning_fingerprint(p_record_type jsonb) FROM PUBLIC;
