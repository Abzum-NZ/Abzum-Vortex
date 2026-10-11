create or replace function vortex_record.resolve_prepared_record_access_plan_internal(
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
  organization_id_value uuid;
  application_root_id_value uuid;
  application_release_revision_value bigint;
  pin_fingerprint_value text;
  current_mapping jsonb;
  current_bindings jsonb;
  resolved_plan jsonb;
  mapping_fingerprint_value text;
  plan_key_value text;
  prepared_plan jsonb;
  stored_plan vortex_record.installation_access_plans%rowtype;
  inserted_rows bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) < 1 then
    raise exception using errcode = '22023',
      message = 'Prepared Record access plan command is invalid';
  end if;

  select locked.* into current_mapping
  from vortex_module.lock_prepared_installation_runtime_mapping_internal(
    p_application_root_id,
    p_application_release_revision,
    p_expected_module_bindings
  ) as locked;
  organization_id_value := (current_mapping ->> 'organizationId')::uuid;
  application_root_id_value := (current_mapping ->> 'applicationRootId')::uuid;
  application_release_revision_value :=
    (current_mapping ->> 'applicationReleaseRevision')::bigint;
  pin_fingerprint_value := current_mapping ->> 'pinFingerprint';
  if current_mapping is null
    or application_root_id_value is distinct from p_application_root_id
    or application_release_revision_value is distinct from p_application_release_revision
    or pin_fingerprint_value is null
    or pin_fingerprint_value !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '40001',
      message = 'Prepared Record access plan mapping changed';
  end if;
  current_bindings := current_mapping -> 'moduleBindings';
  resolved_plan := vortex_record.resolve_installation_access_plan_internal(
    pg_catalog.jsonb_build_object(
      'organizationId', organization_id_value,
      'applicationRootId', application_root_id_value,
      'applicationReleaseRevision', application_release_revision_value,
      'moduleBindings', current_bindings
    )
  );
  if resolved_plan is null
    or (resolved_plan ->> 'organizationId')::uuid is distinct from organization_id_value
    or (resolved_plan ->> 'applicationRootId')::uuid is distinct from application_root_id_value
    or (resolved_plan ->> 'applicationReleaseRevision')::bigint
      is distinct from application_release_revision_value then
    raise exception using errcode = '55000',
      message = 'Prepared Record access plan is unavailable';
  end if;

  mapping_fingerprint_value := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      (pg_catalog.jsonb_build_object(
        'recordTypes', resolved_plan -> 'recordTypes',
        'relationships', resolved_plan -> 'relationships',
        'sharingConditions', resolved_plan -> 'sharingConditions',
        'permissions', resolved_plan -> 'permissions'
      ))::text,
      'UTF8'
    )),
    'hex'
  );
  plan_key_value := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'vortex.installation-runtime-bundle.prepared-record-access-plan.v2|' ||
        organization_id_value::text || '|' || application_root_id_value::text || '|' ||
        application_release_revision_value::text || '|2|' || pin_fingerprint_value,
      'UTF8'
    )),
    'hex'
  );
  prepared_plan := pg_catalog.jsonb_build_object(
    'planKey', plan_key_value,
    'mappingFingerprint', mapping_fingerprint_value,
    'plan', resolved_plan
  );

  insert into vortex_record.installation_access_plans (
    plan_key, organization_id, application_root_id, application_release_revision, plan
  ) values (
    plan_key_value, organization_id_value, application_root_id_value,
    application_release_revision_value, prepared_plan
  ) on conflict (plan_key) do nothing;
  get diagnostics inserted_rows = row_count;
  if inserted_rows = 0 then
    select stored.* into strict stored_plan
    from vortex_record.installation_access_plans as stored
    where stored.plan_key = plan_key_value
    for update;
    if stored_plan.organization_id is distinct from organization_id_value
      or stored_plan.application_root_id is distinct from application_root_id_value
      or stored_plan.application_release_revision is distinct from application_release_revision_value
      or stored_plan.plan is distinct from prepared_plan then
      raise exception using errcode = '23505',
        message = 'Prepared Record access plan immutable identity differs';
    end if;
    prepared_plan := stored_plan.plan;
  end if;
  return prepared_plan;
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Prepared Record access plan evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Prepared Record access plan evidence is ambiguous';
end
$function$;

alter function vortex_record.resolve_prepared_record_access_plan_internal(uuid,bigint,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.resolve_prepared_record_access_plan_internal(uuid,bigint,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.resolve_prepared_record_access_plan_internal(uuid,bigint,jsonb)
  to vortex_module_owner;
comment on function vortex_record.resolve_prepared_record_access_plan_internal(uuid,bigint,jsonb) is
  'Resolves and immutably stores the exact prepared Record access plan for a first-install provisioned Module mapping.';
