create or replace function vortex_identity.append_signup_privacy_acknowledgment()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  notice_version uuid;
begin
  -- GoTrue v2.196.0 requires before_user_created outside its insert transaction. Evidence belongs here.
  notice_version := vortex_identity.validate_privacy_notice_internal(new.raw_user_meta_data);
  insert into vortex_identity.privacy_notice_acknowledgments (
    identity_id, notice_version_id, acknowledged_at, channel, correlation_id
  ) values (
    new.id, notice_version, pg_catalog.clock_timestamp(),
    case when new.raw_app_meta_data ->> 'provider' = 'email'
      then 'email_registration' else 'identity_registration' end,
    pg_catalog.gen_random_uuid()
  );
  return new;
end
$function$;
revoke all on function vortex_identity.append_signup_privacy_acknowledgment()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_identity.append_signup_privacy_acknowledgment() owner to vortex_owner;
-- The operational migration role needs EXECUTE to attach the trigger to GoTrue's table.
grant execute on function vortex_identity.append_signup_privacy_acknowledgment() to postgres;
