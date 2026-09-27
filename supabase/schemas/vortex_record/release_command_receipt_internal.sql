create or replace function vortex_record.release_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  preview_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  preview_value := vortex_record.read_current_preview_installation_internal();
  if preview_value is not null then
    if preview_value ->> 'outcome' = 'refused' then
      raise exception using errcode = '42501',
        message = 'Preview Record command is unavailable';
    end if;
    delete from vortex_record.preview_command_receipts as stored
    where stored.preview_installation_id =
        (preview_value ->> 'previewInstallationId')::uuid
      and stored.organization_id = (context_value ->> 'organizationId')::uuid
      and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and stored.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id
      and stored.state = 'pending';
    return;
  end if;
  delete from vortex_record.command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
      and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and stored.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id
    and stored.state = 'pending';
end
$function$;

alter function vortex_record.release_command_receipt_internal(text,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.release_command_receipt_internal(
  text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.release_command_receipt_internal(
  text, uuid
) to vortex_record_adapter;
comment on function vortex_record.release_command_receipt_internal(
  text, uuid
) is
  'Releases the request actor''s pending live or preview-local command receipt when its command is refused before any change, so the identity can be used again.';
