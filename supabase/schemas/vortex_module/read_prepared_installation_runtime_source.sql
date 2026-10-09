create or replace function vortex_module.read_prepared_installation_runtime_source(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  mapping jsonb;
  prepared_record_plan jsonb;
  application_evidence jsonb;
  module_evidence jsonb;
begin
  mapping := vortex_module.lock_prepared_installation_runtime_mapping_internal(
    p_application_root_id,
    p_application_release_revision,
    p_expected_module_bindings
  );
  select vortex_definition.project_consumer_release_evidence(
    'application', p_application_root_id, p_application_release_revision
  ) into application_evidence;
  if application_evidence is null
    or (application_evidence ->> 'organizationId')::uuid
      is distinct from (mapping ->> 'organizationId')::uuid then
    raise exception using errcode = 'P0002',
      message = 'Prepared Application source is unavailable';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
      vortex_definition.project_consumer_release_evidence(
        'module', (pin.value ->> 'moduleRootId')::uuid,
        (pin.value ->> 'moduleReleaseRevision')::bigint
      ) order by (pin.value ->> 'moduleRootId')::uuid
    ), '[]'::jsonb)
  into module_evidence
  from pg_catalog.jsonb_array_elements(mapping -> 'moduleBindings') as pin(value);

  prepared_record_plan := vortex_record.resolve_prepared_record_access_plan_internal(
    p_application_root_id,
    p_application_release_revision,
    mapping -> 'moduleBindings'
  );
  if prepared_record_plan is null
    or pg_catalog.jsonb_typeof(prepared_record_plan) is distinct from 'object'
    or not prepared_record_plan ?& array['planKey', 'mappingFingerprint', 'plan'] then
    raise exception using errcode = '55000',
      message = 'Prepared Record access plan is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', mapping -> 'organizationId',
    'applicationRootId', mapping -> 'applicationRootId',
    'applicationReleaseRevision', mapping -> 'applicationReleaseRevision',
    'accessVersion', mapping -> 'accessVersion',
    'correlationId', mapping -> 'correlationId',
    'pinFingerprint', mapping -> 'pinFingerprint',
    'mappingFingerprint', prepared_record_plan -> 'mappingFingerprint',
    'moduleBindings', mapping -> 'moduleBindings',
    'application', application_evidence,
    'modules', module_evidence,
    'preparedRecordAccessPlan', prepared_record_plan
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Prepared runtime source evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Prepared runtime source evidence is ambiguous';
end
$function$;

alter function vortex_module.read_prepared_installation_runtime_source(uuid,bigint,jsonb)
  owner to vortex_module_owner;
revoke all on function vortex_module.read_prepared_installation_runtime_source(uuid,bigint,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.read_prepared_installation_runtime_source(uuid,bigint,jsonb)
  to vortex_request;
comment on function vortex_module.read_prepared_installation_runtime_source(uuid,bigint,jsonb) is
  'Reads exact immutable Application and complete Module source plus the current prepared Record plan inside the verified human installation transaction.';
