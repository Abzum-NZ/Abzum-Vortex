-- Record lifecycle preview and #117 handoff preparation (#568).
--
-- Provides a protected read-only preview of an installed record type's
-- current stored lifecycle policy and deterministic candidate records
-- for the #117 handoff without mutating or deleting records.
--
-- 1. `vortex_access.check_record_lifecycle_preview_authority()` verifies
--    the caller holds `platform.organization.applications.manage` authority
--    under a shared access-version lock.
--
-- 2. `vortex_record.preview_record_lifecycle_candidates()` projects the
--    stored policy (or reports safely if unconfigured), counts retained records,
--    and fetches a deterministic bounded page of candidate records ordered by
--    (created_at asc, record_id asc) with keyset continuation.

begin;

reset role;

create function vortex_access.check_record_lifecycle_preview_authority()
returns table (
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint,
  correlation_id uuid,
  application_root_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  decision record;
  current_version bigint;
begin
  context_value := vortex_access.validated_human_request_context();

  select version.current_version into current_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = (context_value ->> 'organizationId')::uuid
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record lifecycle policy administration is unavailable';
  end if;
  if current_version <> (context_value ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001',
      message = 'Record lifecycle policy authority changed';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.record_lifecycle.manage_policy',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.record_lifecycle.manage_policy'
    or decision.organization_id is distinct from (context_value ->> 'organizationId')::uuid
    or decision.organization_account_id is distinct from
      (context_value ->> 'organizationAccountId')::uuid
    or decision.access_version is distinct from (context_value ->> 'accessVersion')::bigint
    or decision.correlation_id is distinct from (context_value ->> 'correlationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Record lifecycle policy administration is unavailable';
  end if;

  return query select decision.organization_id, decision.organization_account_id,
    decision.access_version, decision.correlation_id,
    case
      when context_value ? 'applicationRootId'
        then (context_value ->> 'applicationRootId')::uuid
      else null
    end;
end
$function$;

revoke all on function vortex_access.check_record_lifecycle_preview_authority()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.check_record_lifecycle_preview_authority()
  to vortex_record_owner;
comment on function vortex_access.check_record_lifecycle_preview_authority() is
  'Access-owned authority check for one protected record-type lifecycle policy preview transaction.';

set local role vortex_record_owner;

create function vortex_record.preview_record_lifecycle_candidates(
  p_storage_contract_id uuid,
  p_application_root_id uuid,
  p_after_created_at timestamptz default null,
  p_after_record_id uuid default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  policy_row vortex_record.record_type_lifecycle_policies%rowtype;
  total_count bigint := 0;
  has_more boolean := false;
  records_json jsonb := '[]'::jsonb;
  candidate_rec record;
  last_created_at timestamptz;
  last_record_id uuid;
  row_num integer := 0;
  query_sql text;
begin
  if p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_application_root_id is not null
      and p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or p_limit is null
    or p_limit not between 1 and 500
    or ((p_after_created_at is null) <> (p_after_record_id is null))
    or (p_after_record_id is not null
      and p_after_record_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception using errcode = '22023',
      message = 'Record lifecycle preview command is invalid';
  end if;

  select checked.* into strict authority
  from vortex_access.check_record_lifecycle_preview_authority() as checked;

  -- The resolved request scope must be application-bound exactly when the
  -- target is application-contained, and bound to the exact same application.
  if (p_application_root_id is null) <> (authority.application_root_id is null)
    or (p_application_root_id is not null
      and authority.application_root_id <> p_application_root_id) then
    raise exception using errcode = '42501',
      message = 'Record lifecycle preview is unavailable';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.state = 'active'
  for share;
  if not found
    or (catalogue_row.storage_scope = 'organization_shared')
      <> (p_application_root_id is null) then
    raise exception using errcode = '42501',
      message = 'Record lifecycle preview target is unavailable';
  end if;

  if not vortex_module.record_lifecycle_target_is_installed_internal(
    authority.organization_id, p_application_root_id, p_storage_contract_id
  ) then
    raise exception using errcode = '42501',
      message = 'Record lifecycle preview target is unavailable';
  end if;

  select stored.* into policy_row
  from vortex_record.record_type_lifecycle_policies as stored
  where stored.organization_id = authority.organization_id
    and stored.storage_contract_id = p_storage_contract_id
    and stored.application_root_id is not distinct from p_application_root_id
  for share;

  if not found then
    return pg_catalog.jsonb_build_object(
      'policyStatus', 'unavailable',
      'policy', null,
      'totalRetainedCount', 0,
      'records', '[]'::jsonb,
      'hasMore', false
    );
  end if;

  execute pg_catalog.format(
    'select count(*)::bigint
     from record_data.%I as stored
     where stored.organisation_id = $1
       and stored.storage_contract_id = $2
       and stored.application_root_id is not distinct from $3
       and stored.lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
    catalogue_row.physical_table_token
  ) into total_count using authority.organization_id, p_storage_contract_id, p_application_root_id;

  query_sql := pg_catalog.format(
    'select stored.record_id, stored.concurrency_number, stored.created_at,
            stored.lifecycle_state, stored.deleted_at
     from record_data.%I as stored
     where stored.organisation_id = $1
       and stored.storage_contract_id = $2
       and stored.application_root_id is not distinct from $3
       and stored.lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')
       %s
     order by stored.created_at asc, stored.record_id asc
     limit $4',
    catalogue_row.physical_table_token,
    case
      when p_after_created_at is not null and p_after_record_id is not null then
        'and (stored.created_at > $5 or (stored.created_at = $5 and stored.record_id > $6))'
      else ''
    end
  );

  if p_after_created_at is not null and p_after_record_id is not null then
    for candidate_rec in execute query_sql
      using authority.organization_id, p_storage_contract_id, p_application_root_id,
        p_limit + 1, p_after_created_at, p_after_record_id
    loop
      row_num := row_num + 1;
      if row_num <= p_limit then
        records_json := records_json || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'recordId', candidate_rec.record_id,
            'expectedRecordRevision', candidate_rec.concurrency_number,
            'createdAt', pg_catalog.to_jsonb(candidate_rec.created_at),
            'lifecycleState', candidate_rec.lifecycle_state,
            'deletedAt', pg_catalog.to_jsonb(candidate_rec.deleted_at)
          )
        );
        last_created_at := candidate_rec.created_at;
        last_record_id := candidate_rec.record_id;
      else
        has_more := true;
      end if;
    end loop;
  else
    for candidate_rec in execute query_sql
      using authority.organization_id, p_storage_contract_id, p_application_root_id,
        p_limit + 1
    loop
      row_num := row_num + 1;
      if row_num <= p_limit then
        records_json := records_json || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'recordId', candidate_rec.record_id,
            'expectedRecordRevision', candidate_rec.concurrency_number,
            'createdAt', pg_catalog.to_jsonb(candidate_rec.created_at),
            'lifecycleState', candidate_rec.lifecycle_state,
            'deletedAt', pg_catalog.to_jsonb(candidate_rec.deleted_at)
          )
        );
        last_created_at := candidate_rec.created_at;
        last_record_id := candidate_rec.record_id;
      else
        has_more := true;
      end if;
    end loop;
  end if;

  return pg_catalog.jsonb_build_object(
    'policyStatus', 'available',
    'policy', policy_row.policy_body,
    'totalRetainedCount', total_count,
    'records', records_json,
    'hasMore', has_more
  ) || case when has_more then pg_catalog.jsonb_build_object(
    'nextAfterCreatedAt', pg_catalog.to_jsonb(last_created_at),
    'nextAfterRecordId', last_record_id
  ) else '{}'::jsonb end;
end
$function$;

revoke all on function vortex_record.preview_record_lifecycle_candidates(
  uuid, uuid, timestamptz, uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_record.preview_record_lifecycle_candidates(
  uuid, uuid, timestamptz, uuid, integer
) to vortex_request, vortex_runtime;

comment on function vortex_record.preview_record_lifecycle_candidates(
  uuid, uuid, timestamptz, uuid, integer
) is 'Protected read-only preview of record lifecycle policy and deterministic candidate records for #117 handoff; performs no mutation or deletion.';

reset role;

commit;
