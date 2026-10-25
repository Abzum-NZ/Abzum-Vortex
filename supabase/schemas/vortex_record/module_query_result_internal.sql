create or replace function vortex_record.module_query_result_internal(
  p_plan jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  if (p_plan ->> 'preview')::boolean then
    -- No rows leave this invocation until the builder's authority is current
    -- again. Its role/group path can expire while the page is assembled;
    -- invocation-local reuse must never extend that permission deadline.
    if vortex_record.read_current_preview_installation_internal() -> 'previewInstallationId'
      is distinct from p_plan #> '{prepared,preview,previewInstallationId}' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  end if;
  -- The reader's current field bound travels with every page, even an empty one: the fields it is
  -- guaranteed to see on every record it may read, and whether a search can match through any.
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'moduleReleaseRevision', p_plan #> '{resolved,moduleReleaseRevision}',
    'moduleReleaseVersion', p_plan #> '{resolved,moduleReleaseVersion}',
    'fieldBounds', pg_catalog.jsonb_build_object(
      'readableFieldIds', p_plan -> 'boundFieldIds',
      'searchable', exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(p_plan #> '{searchPlan,fieldIds}') as searched(id)
        where (p_plan -> 'boundFieldIds') ? searched.id
      )
    )
  );
end
$function$;

alter function vortex_record.module_query_result_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_result_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_result_internal(jsonb) is
  'Adapter-only last step of every Module query page read: refuses a preview page whose builder authority changed while it was assembled, and otherwise returns the completed envelope with the resolved release and the reader''s current field bound (guaranteed-readable fields and whether any searchable field is among them).';
