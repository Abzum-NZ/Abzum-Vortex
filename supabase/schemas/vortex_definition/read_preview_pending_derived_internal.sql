create or replace function vortex_definition.read_preview_pending_derived_internal(
  p_preview_installation_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.lower(seed.record_type_id::text)
      order by seed.record_type_id), '[]'::jsonb)
  from vortex_definition.preview_installation_seeds as seed
  where seed.preview_installation_id = p_preview_installation_id
    and seed.derived_ready_at is null
$function$;

alter function vortex_definition.read_preview_pending_derived_internal(uuid) owner to vortex_owner;

revoke all on function vortex_definition.read_preview_pending_derived_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_preview_pending_derived_internal(uuid)
  to vortex_record_adapter;
comment on function vortex_definition.read_preview_pending_derived_internal(uuid) is
  'The record types of a preview''s seed ledger whose derived fields are not worked out yet, for the derived-field backfill scope of the request''s validated preview.';
