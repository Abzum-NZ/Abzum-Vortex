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
  -- GoTrue v2.196.0 refuses to call before_user_created inside a transaction (checkTX), so the
  -- hook runs before and apart from the user insert and cannot write evidence that commits or
  -- rolls back with the account. This AFTER INSERT trigger runs in the insert transaction.
  -- Public self-registration is refused by the hook without an acknowledgement. Accounts that
  -- GoTrue creates without the hook (Admin API provisioning) claim none and record none.
  if (new.raw_user_meta_data -> 'privacy_notice_acknowledged') is distinct from 'true'::jsonb then
    return new;
  end if;
  notice_version := vortex_identity.validate_privacy_notice_internal(new.raw_user_meta_data);
  insert into vortex_identity.privacy_notice_acknowledgments (
    identity_id, notice_version_id, acknowledged_at, correlation_id
  ) values (
    new.id, notice_version, pg_catalog.clock_timestamp(), pg_catalog.gen_random_uuid()
  );
  return new;
end
$function$;
revoke all on function vortex_identity.append_signup_privacy_acknowledgment()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_identity.append_signup_privacy_acknowledgment() owner to vortex_owner;
-- The operational migration role needs EXECUTE to attach the trigger to GoTrue's table.
grant execute on function vortex_identity.append_signup_privacy_acknowledgment() to postgres;
