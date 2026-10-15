create or replace function vortex_access.permission_projection_record_id(
  p_organization_id uuid, p_registration_kind text, p_registration_owner_id uuid,
  p_owner_kind text, p_owner_id uuid, p_permission_id uuid
)
returns uuid
language sql immutable parallel safe set search_path = ''
as $function$
  select (
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
  )::uuid
  from (
    select pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        'vortex.permission_projection' || E'\x1f'
          || p_organization_id::text || E'\x1f'
          || p_registration_kind || E'\x1f'
          || p_registration_owner_id::text || E'\x1f'
          || p_owner_kind || E'\x1f'
          || p_owner_id::text || E'\x1f'
          || p_permission_id::text,
        'UTF8'
      )),
      'hex'
    ) as hash_hex
  ) as derived
$function$;

revoke all on function vortex_access.permission_projection_record_id(uuid, text, uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.permission_projection_record_id(uuid, text, uuid, text, uuid, uuid)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.permission_projection_record_id(uuid, text, uuid, text, uuid, uuid)
  owner to vortex_owner;
