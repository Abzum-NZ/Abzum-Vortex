create or replace function vortex_page.private_form_draft_expiry_internal(p_touched_at timestamptz)
returns timestamptz
language sql
immutable
security invoker
set search_path = ''
as $function$
  select p_touched_at + interval '30 days'
$function$;

revoke all on function vortex_page.private_form_draft_expiry_internal(timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_page.private_form_draft_expiry_internal(timestamptz) is
  'Calculates the expiry time for an untouched private form draft.';

grant execute on function vortex_page.private_form_draft_expiry_internal(timestamptz)
  to vortex_page_owner;
