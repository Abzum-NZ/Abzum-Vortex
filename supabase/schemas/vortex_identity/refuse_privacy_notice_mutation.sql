create or replace function vortex_identity.refuse_privacy_notice_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception using errcode = '42501', message = 'Privacy notice evidence is immutable';
end
$function$;
revoke all on function vortex_identity.refuse_privacy_notice_mutation()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_identity.refuse_privacy_notice_mutation() owner to vortex_owner;
