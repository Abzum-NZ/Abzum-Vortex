create or replace function vortex_access.list_organization_permissions_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.organization.permissions.read decision the bespoke permission
  -- catalogue administration reader applies is the only visibility, and the
  -- caller's current organisation is never an input. A viewer the decision
  -- refuses sees no rows, exactly as a missing or foreign record, so the record
  -- adapters return their identical refusal and a list page is empty rather than
  -- failing. A permission identity is unique only within its registration and
  -- owner, so the record identity is a stable version-8 UUID derived from the
  -- exact owner-qualified declaration (registration kind and owner, owner kind
  -- and owner, permission): two owners declaring the same permission identity
  -- stay two distinct records, and a new registration revision keeps the record
  -- identity. The revision is the active catalogue registration revision and the
  -- attribute names are the lowercase field keys a projection record type
  -- declares. Registration provenance, fingerprints, record-scope evidence and
  -- audit columns stay in the protected storage and are never projected.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_permissions_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  return query
  select
    scope_row.organization_id,
    projected.record_id,
    projected.registration_revision,
    projected.attribute_values
  from (
    select
      (
        pg_catalog.substr(derived.hash_hex, 1, 8) || '-'
        || pg_catalog.substr(derived.hash_hex, 9, 4) || '-'
        || '8' || pg_catalog.substr(derived.hash_hex, 14, 3) || '-'
        || pg_catalog.substr(
             '89ab',
             1 + ((pg_catalog.strpos(
               '0123456789abcdef', pg_catalog.substr(derived.hash_hex, 17, 1)
             ) - 1) % 4),
             1
           ) || pg_catalog.substr(derived.hash_hex, 18, 3) || '-'
        || pg_catalog.substr(derived.hash_hex, 21, 12)
      )::uuid as record_id,
      entry.registration_revision,
      pg_catalog.jsonb_build_object(
        'key', entry.permission_key,
        'label', entry.label,
        'description', entry.description,
        'owner_kind', entry.owner_kind,
        'action_kind', entry.action_kind,
        'named_action', entry.named_action,
        'administrative', entry.administrative
      ) as attribute_values
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
    cross join lateral (
      select pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          'vortex.permission_projection' || E'\x1f'
            || entry.organization_id::text || E'\x1f'
            || entry.registration_kind || E'\x1f'
            || entry.registration_owner_id::text || E'\x1f'
            || entry.owner_kind || E'\x1f'
            || entry.owner_id::text || E'\x1f'
            || entry.permission_id::text,
          'UTF8'
        )),
        'hex'
      ) as hash_hex
    ) as derived
    where entry.organization_id = scope_row.organization_id
      and registration.state = 'active'
  ) as projected
  where p_record_id is null or p_record_id = projected.record_id
  order by projected.record_id;
end
$function$;

revoke all on function vortex_access.list_organization_permissions_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_permissions_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_permissions_projection(uuid, integer) is
  'Registered permission projection: returns every current registered permission catalogue entry the fixed platform.organization.permissions.read decision admits, with the organisation, a stable record identity derived from the exact owner-qualified permission, the active registration revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer. Registration provenance, fingerprints, record-scope evidence and audit columns are never projected.';
