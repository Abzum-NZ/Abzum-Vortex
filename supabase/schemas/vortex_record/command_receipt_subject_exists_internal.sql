create or replace function vortex_record.command_receipt_subject_exists_internal(
  p_command_kind text,
  p_tenant_id uuid,
  p_subject_id uuid,
  p_excluding_command_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  -- True when a completed receipt of this command kind exists, optionally narrowed to one tenant
  -- (null tenant matches any) and to a receipt whose result names the subject id (null subject
  -- matches any), leaving out the receipt of the command that is asking.
  select exists (
    select 1
    from vortex_record.command_receipts as stored
    where stored.command_kind = p_command_kind
      and stored.result is not null
      and stored.command_id is distinct from p_excluding_command_id
      and (p_tenant_id is null or stored.tenant_id = p_tenant_id)
      and (
        p_subject_id is null
        or stored.result -> 'subjectIds' @> pg_catalog.to_jsonb(array[p_subject_id])
      )
  )
$function$;

alter function vortex_record.command_receipt_subject_exists_internal(text,uuid,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.command_receipt_subject_exists_internal(text, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_record.command_receipt_subject_exists_internal(text, uuid, uuid, uuid)
  to vortex_owner, postgres;

comment on function vortex_record.command_receipt_subject_exists_internal(text, uuid, uuid, uuid) is
  'True when a completed receipt of one command kind exists, optionally for one tenant and naming one subject id in its result, ignoring the receipt of the asking command. Identity administration commands use it to tell whether a tenant or organisation was already adopted or provisioned.';
