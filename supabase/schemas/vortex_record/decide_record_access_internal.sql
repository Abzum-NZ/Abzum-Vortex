create or replace function vortex_record.decide_record_access_internal(
  p_memo jsonb,
  p_declaration jsonb,
  p_record_id uuid,
  p_facts jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  input_value jsonb := pg_catalog.jsonb_build_object(
    'declaration', p_declaration, 'recordId', p_record_id, 'facts', p_facts
  );
  remembered jsonb;
begin
  -- A decision the whole set already made for this exact input is reused; any other input is
  -- decided now, so a memo never answers for a different declaration, record or facts.
  if p_memo is not null then
    select entry.value -> 'decision' into remembered
    from pg_catalog.jsonb_array_elements(p_memo) as entry(value)
    where entry.value -> 'input' = input_value
    limit 1;
    if remembered is not null then return remembered; end if;
  end if;
  return (vortex_access.evaluate_organization_record_access_internal(
    pg_catalog.jsonb_build_array(input_value)
  ) -> 0);
end
$function$;
alter function vortex_record.decide_record_access_internal(jsonb,jsonb,uuid,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.decide_record_access_internal(jsonb,jsonb,uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.decide_record_access_internal(jsonb,jsonb,uuid,jsonb) is
  'Private record access decision for one input that reuses the decision a set preparation already made for the identical declaration, record and facts, and otherwise evaluates it.';
