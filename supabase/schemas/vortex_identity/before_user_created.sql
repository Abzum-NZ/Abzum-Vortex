create or replace function vortex_identity.before_user_created(event jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_identity.validate_privacy_notice_internal(event #> '{user,user_metadata}');
  return '{}'::jsonb;
exception when sqlstate 'P0001' then
  if sqlerrm not in ('privacy_notice_required', 'privacy_notice_changed', 'privacy_notice_unavailable') then
    raise;
  end if;
  return pg_catalog.jsonb_build_object('error', pg_catalog.jsonb_build_object(
    'http_code', 400, 'message', sqlerrm
  ));
end
$function$;
revoke all on function vortex_identity.before_user_created(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.before_user_created(jsonb) to supabase_auth_admin;
alter function vortex_identity.before_user_created(jsonb) owner to vortex_owner;
-- Schema ownership remains with postgres; vortex_owner cannot grant schema USAGE onward.
reset role;
grant usage on schema vortex_identity to supabase_auth_admin;
set role vortex_owner;
