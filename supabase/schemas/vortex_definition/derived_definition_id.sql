create or replace function vortex_definition.derived_definition_id(p_parts text[])
returns uuid
language sql
immutable
strict
set search_path = ''
as $function$
  -- A name-based (version-3) UUID from the MD5 of the parts joined by the unit separator, with
  -- the RFC 9562 variant bits. Studio's in-memory draft compile derives exactly the same value.
  select (
    pg_catalog.substr(source.digest_hex, 1, 12)
    || '3'
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
      pg_catalog.convert_to(pg_catalog.array_to_string(p_parts, pg_catalog.chr(31)), 'UTF8')
    ) as digest_hex
  ) as source
$function$;

alter function vortex_definition.derived_definition_id(text[]) owner to vortex_owner;

revoke all on function vortex_definition.derived_definition_id(text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_definition.derived_definition_id(text[]) is
  'The permanent identity a new Definition component or owned Module root is given: derived from its owner and position, so a draft compiled in memory names it exactly as its publication will.';
