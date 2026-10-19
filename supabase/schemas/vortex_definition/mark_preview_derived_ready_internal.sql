create or replace function vortex_definition.mark_preview_derived_ready_internal(
  p_preview_installation_id uuid,
  p_record_type_id uuid
)
returns void
language sql
volatile
security definer
set search_path = ''
as $function$
  update vortex_definition.preview_installation_seeds as seed
  set derived_ready_at = pg_catalog.statement_timestamp()
  where seed.preview_installation_id = p_preview_installation_id
    and seed.record_type_id = p_record_type_id
    and seed.derived_ready_at is null
$function$;

alter function vortex_definition.mark_preview_derived_ready_internal(uuid, uuid) owner to vortex_owner;

revoke all on function vortex_definition.mark_preview_derived_ready_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.mark_preview_derived_ready_internal(uuid, uuid)
  to vortex_record_adapter;
comment on function vortex_definition.mark_preview_derived_ready_internal(uuid, uuid) is
  'Records in a preview''s seed ledger that one record type''s derived fields are worked out, in the transaction of the backfill''s last page for the request''s validated preview.';
