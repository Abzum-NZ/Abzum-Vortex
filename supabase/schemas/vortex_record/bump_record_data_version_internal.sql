create or replace function vortex_record.bump_record_data_version_internal(
  p_organization_id uuid,
  p_storage_contract_id uuid,
  p_application_root_id uuid
)
returns bigint
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  record_type_id uuid;
  version_value bigint;
begin
  version_value := pg_catalog.nextval(
    'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
  );
  -- The shared per-record-type counter is gone. A save now tells open pages to
  -- re-read through the existing content-free post-commit private channel. That
  -- channel is application scoped, so an organisation-shared scope (no
  -- application root) has no topic; the bounded query-cache lifetime still
  -- bounds how long any result may be reused.
  if p_organization_id is null
    or p_storage_contract_id is null
    or p_application_root_id is null then
    return version_value;
  end if;
  select catalogue.record_type_id into record_type_id
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.state = 'active';
  if record_type_id is null then
    return version_value;
  end if;
  begin
    perform vortex_invalidation.publish_change_notice(
      p_organization_id,
      p_application_root_id,
      record_type_id,
      null,
      null,
      'changed',
      version_value,
      version_value,
      pg_catalog.gen_random_uuid()
    );
  exception
    when others then
      -- Invalidation is an advisory refresh signal, never a save condition; the
      -- query-cache policy bounds reuse, so a lost notice only delays a refresh.
      null;
  end;
  return version_value;
end
$function$;

revoke all on function vortex_record.bump_record_data_version_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.bump_record_data_version_internal(uuid, uuid, uuid)
  to vortex_record_adapter;

comment on function vortex_record.bump_record_data_version_internal(uuid, uuid, uuid) is
  'Private Record change signal: takes one non-blocking monotonic version and, for an application-contained scope, publishes the existing content-free post-commit invalidation notice for the record type. Never takes a shared row lock.';
