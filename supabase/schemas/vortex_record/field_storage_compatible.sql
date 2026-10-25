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
  stored_meaning jsonb := vortex_record.field_storage_meaning(p_stored);
  requested_meaning jsonb := vortex_record.field_storage_meaning(p_requested);
  earlier_options jsonb;
  later_options jsonb;
begin
  if p_requested ->> 'type' in ('choice', 'several_choices') then
    earlier_options := case when p_requested_is_older then p_requested else p_stored end #> '{settings,options}';
    later_options := case when p_requested_is_older then p_stored else p_requested end #> '{settings,options}';
    if pg_catalog.jsonb_typeof(earlier_options) is distinct from 'array'
      or pg_catalog.jsonb_typeof(later_options) is distinct from 'array' then
      return false;
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(earlier_options) as earlier(value)
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(later_options) as later(value)
        where later.value = earlier.value
      )
    ) then
      return false;
    end if;
    stored_meaning := stored_meaning #- '{settings,options}';
    requested_meaning := requested_meaning #- '{settings,options}';
  end if;
  return stored_meaning is not distinct from requested_meaning;
end
$function$;

alter function vortex_record.field_storage_compatible(jsonb,jsonb,boolean) owner to vortex_owner;
revoke all on function vortex_record.field_storage_compatible(jsonb,jsonb,boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.field_storage_compatible(jsonb,jsonb,boolean) to vortex_owner;
