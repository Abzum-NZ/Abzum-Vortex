create or replace function vortex_record.read_record_page_row_facts_internal(
  p_envelope jsonb,
  p_row jsonb
)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $function$
  -- One page record's complete read facts: the page envelope with this
  -- record's own stored fact, concurrency number and definition revision.
  -- The same value the exact loader gives the record, rebuilt only on the
  -- paths that need the whole facts object.
  select pg_catalog.jsonb_set(p_envelope, '{facts,records}', pg_catalog.jsonb_build_array(p_row -> 'record'))
    || pg_catalog.jsonb_build_object(
      'concurrencyNumber', p_row -> 'concurrencyNumber',
      'definitionRevision', p_row -> 'definitionRevision',
      'fieldValues', p_row -> 'record' -> 'fieldValues')
$function$;

alter function vortex_record.read_record_page_envelope_internal(uuid,jsonb) owner to vortex_record_adapter;
alter function vortex_record.read_record_page_row_facts_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.read_record_page_envelope_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_record.read_record_page_row_facts_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_page_envelope_internal(uuid,jsonb) is
  'Private page read helper for the fixed record adapter: the page-wide part of every record''s read facts, built once from the first record''s exact facts, narrowed to the record type and its permissions when nothing about that type reaches another record or type.';
comment on function vortex_record.read_record_page_row_facts_internal(jsonb,jsonb) is
  'Private page read helper: one page record''s complete read facts, rebuilt from the page envelope and the record''s own compact scope (stored fact, concurrency number, definition revision).';
