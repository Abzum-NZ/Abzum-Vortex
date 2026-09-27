create or replace function vortex_record.load_record_access_facts_internal(
  p_record_type_id uuid,
  p_action_kind text,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_application_root_id uuid;
  installation jsonb;
  preview_installation jsonb;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore')
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740991) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  -- Step 1: the verified request context, checked here so the active reader
  -- and the shared loader refuse an absent Application context identically.
  context_value := vortex_access.validated_human_request_context();
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  -- Step 2: resolve only the explicitly addressed preview for its owner, or
  -- preserve the active installation reader for an ordinary live request.
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  installation := case when preview_installation is null
    then vortex_module.read_current_active_installation()
    else preview_installation end;

  return vortex_record.load_record_access_facts_from_installation_internal(
    p_record_type_id, p_action_kind, p_record_id, p_expected_concurrency_number, installation
  );
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.load_record_access_facts_internal(uuid,text,uuid,bigint) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_internal(
  uuid, text, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

comment on function vortex_record.load_record_access_facts_internal(
  uuid, text, uuid, bigint
) is
  'Private adapter fact loader over the exact active installation or the current owner-validated preview, including each pinned Module validation contract version.';
