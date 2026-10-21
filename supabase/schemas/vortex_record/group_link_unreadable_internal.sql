create or replace function vortex_record.group_link_unreadable_internal(
  p_cache jsonb,
  p_values jsonb[],
  p_field jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  missing jsonb[];
begin
  -- Seeds p_cache (target record id -> true when the reader cannot read that target now) for every
  -- distinct link target of p_values it does not hold yet, through ONE protected title batch the
  -- summary folds with. A target is readable only when the batch returns it unchanged; missing,
  -- withheld and unreadable targets alike are unreadable.
  select pg_catalog.array_agg(wanted.value)
  into missing
  from (
    select distinct on (item.value ->> 'recordId') item.value
    from pg_catalog.unnest(p_values) as item(value)
    where pg_catalog.jsonb_typeof(item.value) = 'object'
      and not (p_cache ? (item.value ->> 'recordId'))
    order by item.value ->> 'recordId'
  ) as wanted;
  if missing is null then
    return p_cache;
  end if;
  return p_cache || (
    with readable as materialized (
      select target.normalized from vortex_record.dimension_value_internal(missing, p_field) as target
    )
    select pg_catalog.jsonb_object_agg(
      wanted.value ->> 'recordId',
      not exists (select 1 from readable where readable.normalized = wanted.value))
    from pg_catalog.unnest(missing) as wanted(value)
  );
end
$function$;

alter function vortex_record.group_link_unreadable_internal(jsonb,jsonb[],jsonb) owner to vortex_owner;
revoke all on function vortex_record.group_link_unreadable_internal(jsonb,jsonb[],jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.group_link_unreadable_internal(jsonb,jsonb[],jsonb)
  to vortex_record_adapter;

comment on function vortex_record.group_link_unreadable_internal(jsonb,jsonb[],jsonb) is
  'Owner-only seeding of the per-call cache that says whether each link target is unreadable to the reader now (missing, withheld and unreadable targets alike): one protected target-title batch for every distinct target the cache does not hold, returning the updated cache a member scan carries.';
