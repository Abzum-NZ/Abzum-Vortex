create or replace function vortex_record.ensure_application_lifecycle_policies(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  permission_decision record;
  target record;
  limits_row vortex_record.organization_lifecycle_limits%rowtype;
  target_storage_contract_ids uuid[];
  policy_scope uuid;
  next_policy_id uuid;
  full_policy jsonb;
  inserted_count integer;
  stored_count integer := 0;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Lifecycle policy installation command is invalid';
  end if;

  -- The installer authority that provisioned this release's storage in the same transaction.
  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission',
        vortex_access.required_platform_permission('platform.organization.applications.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible'
    or permission_decision.organization_id is distinct from p_organization_id then
    raise exception using errcode = '42501',
      message = 'Lifecycle policy installation authority is unavailable';
  end if;

  -- The storage contracts of the binding set the activation just switched on, read once.
  -- Modules that hold no record types yet have no targets: zero record types, zero policies.
  select coalesce(pg_catalog.array_agg(distinct targets.storage_contract_id), array[]::uuid[])
    into target_storage_contract_ids
  from vortex_definition.read_lifecycle_activation_targets_internal(
    p_organization_id, p_application_root_id, p_application_release_revision,
    p_expected_module_bindings
  ) as targets;

  select limits.* into limits_row
  from vortex_record.organization_lifecycle_limits as limits
  where limits.organization_id = p_organization_id
  for share;
  if not found then
    raise exception using errcode = '23514',
      message = 'Organisation lifecycle limits are unavailable';
  end if;

  for target in
    select catalogue.storage_contract_id, catalogue.storage_scope
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = any (target_storage_contract_ids)
      and catalogue.state = 'active'
    order by catalogue.storage_contract_id
  loop
    policy_scope := case
      when target.storage_scope = 'application_contained' then p_application_root_id
      else null
    end;
    -- A stored policy is the organisation's current choice and is never replaced here.
    continue when exists (
      select 1
      from vortex_record.record_type_lifecycle_policies as stored
      where stored.organization_id = p_organization_id
        and stored.storage_contract_id = target.storage_contract_id
        and stored.application_root_id is not distinct from policy_scope
    );

    if limits_row.initial_policy is null then
      raise exception using errcode = '23514',
        message = 'Configure an initial record lifecycle policy before installing applications';
    end if;

    next_policy_id := pg_catalog.gen_random_uuid();
    full_policy := limits_row.initial_policy || pg_catalog.jsonb_build_object(
      'policyId', next_policy_id,
      'organizationId', p_organization_id,
      'storageContractId', target.storage_contract_id,
      'applicationRootId', policy_scope,
      'policyRevision', 1
    );
    if not vortex_record.is_record_type_lifecycle_policy(full_policy) then
      raise exception using errcode = '22023',
        message = 'Configured initial record lifecycle policy is invalid',
        detail = 'storage contract ' || target.storage_contract_id::text;
    end if;

    -- A concurrent installation sharing this organisation-shared record type may store it first.
    insert into vortex_record.record_type_lifecycle_policies (
      policy_id, organization_id, storage_contract_id, application_root_id,
      policy_revision, action, policy_body
    ) values (
      next_policy_id, p_organization_id, target.storage_contract_id,
      policy_scope, 1, full_policy ->> 'action', full_policy
    )
    on conflict on constraint record_type_lifecycle_policies_scope_unique do nothing;
    get diagnostics inserted_count = row_count;
    if inserted_count = 1 then
      perform vortex_record.append_lifecycle_policy_activity_internal(
        pg_catalog.gen_random_uuid(), next_policy_id
      );
      stored_count := stored_count + 1;
    end if;
  end loop;

  return stored_count;
end
$function$;

alter function vortex_record.ensure_application_lifecycle_policies(uuid, uuid, bigint, jsonb) owner to vortex_owner;

revoke all on function vortex_record.ensure_application_lifecycle_policies(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_record.ensure_application_lifecycle_policies(uuid, uuid, bigint, jsonb)
  to vortex_request;

comment on function vortex_record.ensure_application_lifecycle_policies(uuid, uuid, bigint, jsonb) is
  'The one installation step that gives every record type of an activating Application release its lifecycle policy: a record type without one gets the explicit organisation setup policy at revision 1, within the organisation limits. A stored policy is never changed. Returns the number stored.';
