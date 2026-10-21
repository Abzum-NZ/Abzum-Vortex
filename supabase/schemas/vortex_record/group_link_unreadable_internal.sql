create or replace function vortex_record.group_link_unreadable_internal(
  p_cache jsonb,
  p_value jsonb,
  p_field jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  link_id text := p_value ->> 'recordId';
begin
  -- Whether a link value names a target the reader cannot read now, decided through the protected
  -- title batch the summary folds with. p_cache holds each distinct target's answer, so a member
  -- page decides every target once; the updated cache is returned beside the answer.
  if pg_catalog.jsonb_typeof(p_value) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('matches', false, 'cache', p_cache);
  end if;
  if not (p_cache ? link_id) then
    p_cache := p_cache || pg_catalog.jsonb_build_object(link_id, not exists (
      select 1 from vortex_record.dimension_value_internal(array[p_value], p_field) as target
      where target.normalized = p_value
    ));
  end if;
  return pg_catalog.jsonb_build_object('matches', (p_cache ->> link_id)::boolean, 'cache', p_cache);
end
$function$;

alter function vortex_record.group_link_unreadable_internal(jsonb,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_record.group_link_unreadable_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.group_link_unreadable_internal(jsonb,jsonb,jsonb)
  to vortex_record_adapter;

comment on function vortex_record.group_link_unreadable_internal(jsonb,jsonb,jsonb) is
  'Owner-only check that a link value names a target the reader cannot read now (missing, withheld and unreadable targets alike), through the protected target-title batch a link grouping folds with; returns the answer and the per-target cache a member scan carries.';
