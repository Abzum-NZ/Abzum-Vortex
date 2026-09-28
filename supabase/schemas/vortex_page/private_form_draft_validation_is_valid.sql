create or replace function vortex_page.private_form_draft_validation_is_valid(p_validation jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when p_validation is null or pg_catalog.jsonb_typeof(p_validation) <> 'object' then false
    else (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_validation)) <= 500
      and not exists (
        select 1
        from pg_catalog.jsonb_each(p_validation) as supplied(key, value)
        where not vortex_page.private_form_draft_key_is_valid(supplied.key)
          or case
            when pg_catalog.jsonb_typeof(supplied.value) <> 'object' then true
            else supplied.value ->> 'state' is null
              or supplied.value ->> 'state' not in ('valid', 'invalid', 'incomplete')
              or (supplied.value - array['state', 'reasonCode']) <> '{}'::jsonb
              or (
                supplied.value ? 'reasonCode'
                and case
                  when pg_catalog.jsonb_typeof(supplied.value -> 'reasonCode') <> 'string'
                    then true
                  else pg_catalog.length(supplied.value ->> 'reasonCode') > 120
                    or supplied.value ->> 'reasonCode' !~ '^[a-z][a-z0-9_]*$'
                end
              )
          end
      )
  end
$function$;

revoke all on function vortex_page.private_form_draft_validation_is_valid(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_page.private_form_draft_validation_is_valid(jsonb)
  to vortex_page_owner;
