create or replace function vortex_record.field_storage_compatible(
  p_stored jsonb,
  p_requested jsonb,
  p_requested_is_older boolean
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  earlier jsonb := case when p_requested_is_older then p_requested else p_stored end;
  later jsonb := case when p_requested_is_older then p_stored else p_requested end;
begin
  if vortex_record.field_storage_meaning(p_stored)
    is distinct from vortex_record.field_storage_meaning(p_requested) then
    return false;
  end if;
  -- A stored value of a choice field is an option value: every earlier option stays.
  if p_requested ->> 'type' in ('choice', 'several_choices') then
    if pg_catalog.jsonb_typeof(earlier #> '{settings,options}') is distinct from 'array'
      or pg_catalog.jsonb_typeof(later #> '{settings,options}') is distinct from 'array' then
      return false;
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(earlier #> '{settings,options}') as before(value)
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(later #> '{settings,options}') as after(value)
        where after.value -> 'value' = before.value -> 'value'
      )
    ) then
      return false;
    end if;
  end if;
  -- Existing records may hold no value or a repeated value: a later release can drop these
  -- constraints but not add them.
  if (later ->> 'required')::boolean and not coalesce((earlier ->> 'required')::boolean, false)
    or (later ->> 'unique')::boolean and not coalesce((earlier ->> 'unique')::boolean, false) then
    return false;
  end if;
  return true;
end
$function$;

alter function vortex_record.field_storage_compatible(jsonb,jsonb,boolean) owner to vortex_owner;
revoke all on function vortex_record.field_storage_compatible(jsonb,jsonb,boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.field_storage_compatible(jsonb,jsonb,boolean) to vortex_owner;
