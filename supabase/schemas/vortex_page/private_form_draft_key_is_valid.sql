create or replace function vortex_page.private_form_draft_key_is_valid(p_key text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select p_key is not null
    and (
      p_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or (
        pg_catalog.length(p_key) <= 40
        and p_key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
      )
    )
$function$;

revoke all on function vortex_page.private_form_draft_key_is_valid(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_page.private_form_draft_key_is_valid(text)
  to vortex_page_owner;
