create or replace function vortex_identity.refuse_super_administrator_assignment_receipt_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using errcode = '23514',
    message = 'Vortex super-administrator assignment receipts are immutable';
end
$function$;

revoke all on function vortex_identity.refuse_super_administrator_assignment_receipt_change()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.refuse_super_administrator_assignment_receipt_change() is
  'Prevents rewriting or deleting a completed super-administrator assignment command receipt.';
