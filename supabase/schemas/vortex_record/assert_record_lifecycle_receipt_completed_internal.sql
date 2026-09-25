create or replace function vortex_record.assert_record_lifecycle_receipt_completed_internal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1 from vortex_record.command_receipts as receipt
    where receipt.organization_id = new.organization_id
      and receipt.application_root_id = new.application_root_id
      and receipt.actor_organization_account_id = new.actor_organization_account_id
      and receipt.command_kind = new.command_kind
      and receipt.command_id = new.command_id
      and receipt.state = 'pending'
  ) then
    raise exception using errcode = '23514',
      message = 'Record lifecycle command was not finalized';
  end if;
  return null;
end
$function$;

revoke all on function vortex_record.assert_record_lifecycle_receipt_completed_internal(
  
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
comment on function vortex_record.assert_record_lifecycle_receipt_completed_internal(
  
) is
  'Deferred commit-time check that a record lifecycle command receipt never commits while pending.';
