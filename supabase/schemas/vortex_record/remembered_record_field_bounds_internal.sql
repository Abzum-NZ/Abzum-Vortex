create or replace function vortex_record.remembered_record_field_bounds_internal(
  p_memo jsonb,
  p_decision jsonb,
  p_kind text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  remembered jsonb;
begin
  -- The field bounds the whole set already took from this exact decision (found by its bounds key) are reused; the bounds of any other decision are taken now.
  if p_memo is not null then
    remembered := p_memo -> 'bounds' -> vortex_record.record_field_bounds_key_internal(p_decision) -> p_kind;
    if remembered is not null then return remembered; end if;
  end if;
  return case p_kind
    when 'resolved' then vortex_access.resolve_record_field_bounds_internal(p_decision)
    else vortex_record.decide_record_field_bounds_internal(p_decision) end;
end
$function$;
alter function vortex_record.remembered_record_field_bounds_internal(jsonb,jsonb,text) owner to vortex_record_adapter;
revoke all on function vortex_record.remembered_record_field_bounds_internal(jsonb,jsonb,text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.remembered_record_field_bounds_internal(jsonb,jsonb,text) is
  'Private field bounds of one allowed record access decision (resolved: the matched contributions'' field policies; decided: those with produced fields withheld) that reuse the bounds a set preparation already took from the identical decision, and otherwise take them now.';
