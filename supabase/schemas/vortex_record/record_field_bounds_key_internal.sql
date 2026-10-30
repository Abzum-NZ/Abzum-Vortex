create or replace function vortex_record.record_field_bounds_key_internal(
  p_decision jsonb
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'outcome', p_decision -> 'outcome', 'organizationId', p_decision -> 'organizationId',
    'action', p_decision -> 'action', 'recordBinding', p_decision -> 'recordBinding',
    'matchedContributions', p_decision -> 'matchedContributions'
  )::text, 'UTF8')), 'hex')
$function$;
alter function vortex_record.record_field_bounds_key_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.record_field_bounds_key_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.record_field_bounds_key_internal(jsonb) is
  'Private key of the parts of an access decision the field bounds are taken from (outcome, organisation, action, record binding and matched contributions), so two decisions for different records that match the same contributions share one set of bounds. It must list every decision part vortex_access.resolve_record_field_bounds_internal and vortex_record.decide_record_field_bounds_internal read.';
