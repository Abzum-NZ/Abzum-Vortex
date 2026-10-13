create or replace function vortex_definition.private_form_draft_expiry_internal(p_touched_at timestamptz)
returns timestamptz
language sql
immutable
security invoker
set search_path = ''
as $function$
  select p_touched_at + interval '30 days'
$function$;

revoke all on function vortex_definition.private_form_draft_expiry_internal(timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_definition.private_form_draft_expiry_internal(timestamptz) is
  'Calculates the expiry time for an untouched private form draft.';

grant execute on function vortex_definition.private_form_draft_expiry_internal(timestamptz)
  to vortex_owner;

alter function vortex_definition.private_form_draft_expiry_internal(p_touched_at timestamp with time zone) owner to vortex_owner;

grant execute on function vortex_definition.private_form_draft_expiry_internal(p_touched_at timestamp with time zone) to postgres;
