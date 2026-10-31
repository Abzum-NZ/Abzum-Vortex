create or replace function vortex_record.read_application_lifecycle_policy_readiness(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  target record;
  policy_row vortex_record.record_type_lifecycle_policies%rowtype;
  limits_row vortex_record.organization_lifecycle_limits%rowtype;
  target_storage_contract_ids uuid[];
  target_count integer := 0;
  policies jsonb := '[]'::jsonb;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Lifecycle activation readiness command is invalid';
  end if;

  -- One read of the installation targets, de-duplicated once, so the
  -- completeness check below cannot disagree with the policies collected.
  -- An installation whose Modules hold no record types yet has no targets and no policies.
  select coalesce(pg_catalog.array_agg(distinct targets.storage_contract_id), array[]::uuid[])
    into target_storage_contract_ids
  from vortex_definition.read_lifecycle_activation_targets_internal(
    p_organization_id, p_application_root_id, p_application_release_revision,
    p_expected_module_bindings
  ) as targets;

  for target in
    select catalogue.storage_contract_id, catalogue.storage_scope
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = any (target_storage_contract_ids)
      and catalogue.state = 'active'
    order by catalogue.storage_contract_id
  loop
    target_count := target_count + 1;

    select stored.* into policy_row
    from vortex_record.record_type_lifecycle_policies as stored
    where stored.organization_id = p_organization_id
      and stored.storage_contract_id = target.storage_contract_id
      and stored.application_root_id is not distinct from case
        when target.storage_scope = 'application_contained' then p_application_root_id
        else null
      end
    for share;
    if not found then
      raise exception using errcode = '23514',
        message = 'Record-type lifecycle policy is unavailable';
    end if;
    policies := policies || pg_catalog.jsonb_build_array(policy_row.policy_body);
  end loop;

  -- Every installed storage contract must be an active catalogue entry with a
  -- policy. A target this read cannot account for is an incomplete
  -- installation, never an implicitly unmanaged record type.
  if target_count <> pg_catalog.cardinality(target_storage_contract_ids) then
    raise exception using errcode = '23514',
      message = 'Lifecycle activation targets are incomplete';
  end if;

  select limits.* into limits_row
  from vortex_record.organization_lifecycle_limits as limits
  where limits.organization_id = p_organization_id
  for share;
  if not found then
    raise exception using errcode = '23514',
      message = 'Organisation lifecycle limits are unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'policies', policies,
    'organizationLimits', pg_catalog.jsonb_build_object(
      'organizationId', limits_row.organization_id,
      'settingsRevision', limits_row.settings_revision,
      'maxRetentionDays', limits_row.max_retention_days,
      'maxRecordCount', limits_row.max_record_count,
      'allowUnlimitedRetentionDays', limits_row.allow_unlimited_retention_days,
      'allowUnlimitedRecordCount', limits_row.allow_unlimited_record_count,
      'allowedActions', pg_catalog.to_jsonb(limits_row.allowed_actions)
    ),
    'readinessEvidence', pg_catalog.jsonb_build_object(
      'organizationId', p_organization_id
    )
  );
end
$function$;

alter function vortex_record.read_application_lifecycle_policy_readiness(uuid, uuid, bigint, jsonb) owner to vortex_owner;

revoke all on function vortex_record.read_application_lifecycle_policy_readiness(uuid, uuid, bigint, jsonb) from public;
grant all on function vortex_record.read_application_lifecycle_policy_readiness(uuid, uuid, bigint, jsonb) to vortex_request;

comment on function vortex_record.read_application_lifecycle_policy_readiness(uuid, uuid, bigint, jsonb) is
  'Complete executable-policy snapshot for one activating Application installation: every owned record type''s current policy and the organisation ceilings. The one lifecycle action is delete, so it carries no archive readiness.';
