CREATE OR REPLACE FUNCTION vortex_platform.file_activity_id(p_action text, p_organization_id uuid, p_correlation_id uuid, p_subject_id uuid) RETURNS uuid
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $_$
declare
  hash_hex text;
begin
  if p_action is null
    or pg_catalog.char_length(p_action) not between 1 and 40
    or p_action !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_subject_id is null
    or p_subject_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'File Activity identity input is invalid';
  end if;

  hash_hex := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      p_action || E'\x1f' || p_organization_id::text || E'\x1f'
        || p_correlation_id::text || E'\x1f' || p_subject_id::text, 'UTF8')),
    'hex'
  );

  return (
    pg_catalog.substr(hash_hex, 1, 8) || '-'
    || pg_catalog.substr(hash_hex, 9, 4) || '-'
    || '8' || pg_catalog.substr(hash_hex, 14, 3) || '-'
    || pg_catalog.substr(
         '89ab',
         1 + ((pg_catalog.strpos(
           '0123456789abcdef', pg_catalog.substr(hash_hex, 17, 1)
         ) - 1) % 4),
         1
       ) || pg_catalog.substr(hash_hex, 18, 3) || '-'
    || pg_catalog.substr(hash_hex, 21, 12)
  )::uuid;
end
$_$;

alter function vortex_platform.file_activity_id(p_action text, p_organization_id uuid, p_correlation_id uuid, p_subject_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_platform.file_activity_id(p_action text, p_organization_id uuid, p_correlation_id uuid, p_subject_id uuid) IS 'The deterministic version-8 Activity identity of one File operation, derived from its action, organisation, correlation and subject.';

REVOKE ALL ON FUNCTION vortex_platform.file_activity_id(p_action text, p_organization_id uuid, p_correlation_id uuid, p_subject_id uuid) FROM PUBLIC;

grant execute on function vortex_platform.file_activity_id(p_action text, p_organization_id uuid, p_correlation_id uuid, p_subject_id uuid) to postgres;
