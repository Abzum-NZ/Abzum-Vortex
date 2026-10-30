create or replace function vortex_record.load_record_access_facts_internal(
  p_action_kind text,
  p_targets jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_application_root_id uuid;
  installation jsonb;
  preview_installation jsonb;
begin
  -- Each target names a record type, a record, and optionally an expected
  -- revision, a protected projection row and requested fields; the result holds
  -- one facts outcome per target in the same order. The facts body checks each
  -- target.
  if p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore')
    or pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) not between 1 and 200 then
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
    return (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('outcome', 'refused'))
      from pg_catalog.jsonb_array_elements(p_targets)
    );
  end if;
  installation := case when preview_installation is null
    then vortex_definition.read_current_active_installation()
    else preview_installation end;

  return vortex_record.load_record_access_facts_from_installation_internal(
    p_action_kind, p_targets, installation
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

alter function vortex_record.load_record_access_facts_internal(text,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_internal(
  text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.load_record_access_facts_internal(text,jsonb) to vortex_owner;
