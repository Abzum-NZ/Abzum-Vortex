create or replace function vortex_page.private_form_draft_values_are_valid(p_values jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when p_values is null or pg_catalog.jsonb_typeof(p_values) <> 'object' then false
    else pg_catalog.octet_length(p_values::text) <= 524288
      and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_values)) <= 500
      and not exists (
        select 1
        from pg_catalog.jsonb_object_keys(p_values) as supplied(key)
        where not vortex_page.private_form_draft_key_is_valid(supplied.key)
      )
  end
$function$;

revoke all on function vortex_page.private_form_draft_values_are_valid(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_page.private_form_draft_values_are_valid(jsonb) is
  'Validates bounded private form draft field values.';

grant execute on function vortex_page.private_form_draft_values_are_valid(jsonb)
  to vortex_page_owner;
