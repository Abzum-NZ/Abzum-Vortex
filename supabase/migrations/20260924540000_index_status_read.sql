-- #613: authorised index status and safe uniqueness conflicts.
--
-- #611 records each exact field index of a provisioned Record storage contract
-- in `vortex_record.index_catalogue` and projects live readiness through
-- `read_index_readiness`; #612 leases and records concurrent builds. Neither
-- exposes an operational status an administrator can read after (or between)
-- activations, and neither says anything about a uniqueness conflict.
--
-- This migration adds one protected, Access-checked read, additive only:
--
-- 1. `authorize_index_status_internal` is the single authority check: the
--    exact Application-management permission the Module installation
--    provisioner already requires, taken against the caller's validated
--    request context and pinned to the exact organisation and Application.
-- 2. `read_application_index_status` projects each exact field index of the
--    active installation's storage contracts as one of `pending`, `running`
--    (active build lease), `ready`, `interrupted` or `conflicting`, with
--    bounded progress counts and no physical relation name, generated SQL, raw
--    value or hidden record count.
-- 3. `read_index_conflict_references_internal` (adapter-owned) finds the
--    duplicate scope/value groups a uniqueness index would reject and resolves
--    each participating record through the existing exact record read
--    decision. If any participating record is not readable by the current
--    caller, the whole conflict collapses to one generic refusal carrying no
--    id, value, count or differentiating reason.
--
-- Nothing here builds, drops or repairs an index; it only observes readiness
-- and decides read access.

begin;

set local role vortex_record_owner;

-- The single authority check for the index-status read. It requires the exact
-- Application-management permission the installation provisioner and the
-- storage-conversion preparation already require, taken against the caller's
-- validated request context, and pins the named organisation and Application
-- to that decision. It never accepts caller-authored identity or authority.
create function vortex_record.authorize_index_status_internal(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  permission_decision record;
  checked_context jsonb;
begin
  if p_organization_id is null
    or p_organization_id = nil_uuid
    or p_application_root_id is null
    or p_application_root_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Index status command is invalid';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.index_status',
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
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Index status authority is unavailable';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '40001',
      message = 'Index status context changed';
  end if;

  -- The organisation and the Application are both the validated request
  -- context's own. The conflict search runs behind the `record_data` policies
  -- of that context, so a status for any other Application would resolve
  -- conflicts against the wrong rows.
  if permission_decision.organization_id is distinct from p_organization_id
    or (checked_context ->> 'applicationRootId') is null
    or (checked_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Index status scope is unavailable';
  end if;

  -- The named Application must be a real Application of exactly this
  -- organisation; a foreign or non-Application root is one refusal.
  if not exists (
    select 1
    from vortex_definition.roots as root
    where root.root_id = p_application_root_id
      and root.kind = 'application'
      and root.organization_id = permission_decision.organization_id
  ) then
    raise exception using errcode = '42501',
      message = 'Index status Application is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', permission_decision.organization_id,
    'accessVersion', permission_decision.access_version
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '42501',
      message = 'Index status authority is unavailable';
end
$function$;

-- The live status of every exact field index one active Application
-- installation owns. It derives the desired definition from the recorded
-- lineage, observes the physical index and records one of five states. It
-- never returns a physical relation name, a generated statement or a raw
-- value, and conflicting record references are only ever resolved behind the
-- exact record read decision.
create function vortex_record.read_application_index_status(
  p_organization_id uuid,
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
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  authority jsonb;
  target_storage_contract_ids uuid[];
  target record;
  mapping record;
  purpose text;
  scope_columns text;
  index_token text;
  definition_fingerprint text;
  observed text;
  catalogue_row vortex_record.index_catalogue%rowtype;
  index_state text;
  ready boolean;
  lease_active boolean;
  conflict_outcome jsonb;
  conflict_value jsonb;
  target_count integer := 0;
  index_count integer := 0;
  ready_count integer := 0;
  pending_count integer := 0;
  running_count integer := 0;
  interrupted_count integer := 0;
  conflicting_count integer := 0;
  indexes jsonb := '[]'::jsonb;
  uniqueness_ready boolean := true;
begin
  if p_organization_id is null
    or p_organization_id = nil_uuid
    or p_application_root_id is null
    or p_application_root_id = nil_uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Index status command is invalid';
  end if;

  authority := vortex_record.authorize_index_status_internal(
    p_organization_id, p_application_root_id
  );

  -- The same protected active-installation target fact `read_index_readiness`
  -- uses; the organisation is re-derived from the validated request context
  -- inside it and the supplied value must match it.
  select pg_catalog.array_agg(distinct targets.storage_contract_id)
    into target_storage_contract_ids
  from vortex_module.read_lifecycle_activation_targets_internal(
    p_organization_id, p_application_root_id, p_application_release_revision,
    p_expected_module_bindings
  ) as targets;

  if target_storage_contract_ids is null
    or pg_catalog.cardinality(target_storage_contract_ids) = 0 then
    raise exception using errcode = '23514',
      message = 'Index status activation targets are incomplete';
  end if;

  for target in
    select catalogue.storage_contract_id, catalogue.storage_scope,
      catalogue.physical_table_token, catalogue.record_type_id
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = any (target_storage_contract_ids)
      and catalogue.state = 'active'
    order by catalogue.storage_contract_id
  loop
    target_count := target_count + 1;

    for mapping in
      select stored.field_id, stored.physical_column_token, stored.field_definition
      from vortex_record.field_storage_mappings as stored
      where stored.storage_contract_id = target.storage_contract_id
        and stored.state = 'active'
        and (
          coalesce((stored.field_definition ->> 'unique')::boolean, false)
          or coalesce((stored.field_definition ->> 'filterable')::boolean, false)
          or coalesce((stored.field_definition ->> 'sortable')::boolean, false)
        )
      order by stored.field_id
    loop
      index_count := index_count + 1;

      purpose := case
        when coalesce((mapping.field_definition ->> 'unique')::boolean, false)
          then 'uniqueness'
        else 'performance'
      end;
      scope_columns := vortex_record.index_scope_columns(target.storage_scope);
      index_token := case purpose when 'uniqueness' then 'ux_' else 'ix_' end
        || pg_catalog.substr(mapping.physical_column_token, 3);
      definition_fingerprint := vortex_record.index_definition_fingerprint(
        purpose, target.physical_table_token, scope_columns, mapping.physical_column_token
      );
      observed := vortex_record.observe_field_index_internal(
        purpose, target.physical_table_token, scope_columns, mapping.physical_column_token
      );

      select stored_index.* into catalogue_row
      from vortex_record.index_catalogue as stored_index
      where stored_index.storage_contract_id = target.storage_contract_id
        and stored_index.field_id = mapping.field_id
      for share;

      ready := observed = 'present'
        and catalogue_row.index_contract_id is not null
        and catalogue_row.purpose = purpose
        and catalogue_row.physical_index_token = index_token
        and catalogue_row.desired_definition_fingerprint = definition_fingerprint;

      -- A lease that has not expired is an active build. An expired lease or
      -- an invalid physical index is an interrupted build awaiting a later
      -- claim. Neither is ever projected as ready.
      lease_active := catalogue_row.index_contract_id is not null
        and catalogue_row.claim_id is not null
        and catalogue_row.lease_expires_at > pg_catalog.statement_timestamp();

      -- Only a uniqueness index that is neither ready nor actively building
      -- can be blocked by its own data. The conflict search is only attempted
      -- then, and its exact outcome decides the state.
      conflict_outcome := null;
      conflict_value := null;
      if not ready and not lease_active and purpose = 'uniqueness' then
        conflict_outcome := vortex_record.read_index_conflict_references_internal(
          target.record_type_id, target.physical_table_token, scope_columns,
          mapping.physical_column_token
        );
      end if;

      if ready then
        index_state := 'ready';
        ready_count := ready_count + 1;
      elsif lease_active then
        index_state := 'running';
        running_count := running_count + 1;
      elsif conflict_outcome is not null and conflict_outcome ->> 'outcome' <> 'none' then
        index_state := 'conflicting';
        conflicting_count := conflicting_count + 1;
        conflict_value := case conflict_outcome ->> 'outcome'
          when 'unreadable' then pg_catalog.jsonb_build_object('state', 'unreadable')
          else pg_catalog.jsonb_build_object(
            'state', 'readable',
            'records', coalesce(conflict_outcome -> 'records', '[]'::jsonb)
          )
        end;
      elsif observed = 'invalid' or catalogue_row.claim_id is not null then
        index_state := 'interrupted';
        interrupted_count := interrupted_count + 1;
      else
        index_state := 'pending';
        pending_count := pending_count + 1;
      end if;

      if purpose = 'uniqueness' and not ready then
        uniqueness_ready := false;
      end if;

      indexes := indexes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'indexContractId', coalesce(
          catalogue_row.index_contract_id,
          vortex_record.index_contract_identity(
            target.storage_contract_id, mapping.field_id
          )
        ),
        'storageContractId', target.storage_contract_id,
        'fieldId', mapping.field_id,
        'purpose', purpose,
        'desiredDefinitionFingerprint', definition_fingerprint,
        'state', index_state,
        'observedState', observed,
        'recordedObservedState', catalogue_row.observed_state,
        'observedRevision', catalogue_row.observed_revision,
        'ready', ready,
        'failureCode', case index_state
          when 'interrupted' then 'build_interrupted'
          when 'conflicting' then 'uniqueness_conflict'
          else null
        end,
        'conflict', conflict_value
      ));
    end loop;
  end loop;

  -- Every installation storage contract must be an active catalogue entry; a
  -- target this read cannot account for is an incomplete installation, never
  -- an implicitly unindexed record type.
  if target_count <> pg_catalog.cardinality(target_storage_contract_ids) then
    raise exception using errcode = '23514',
      message = 'Index status activation targets are incomplete';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', authority ->> 'organizationId',
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'indexes', indexes,
    'progress', pg_catalog.jsonb_build_object(
      'total', index_count,
      'ready', ready_count,
      'pending', pending_count,
      'running', running_count,
      'interrupted', interrupted_count,
      'conflicting', conflicting_count
    ),
    'uniquenessReady', uniqueness_ready,
    'performanceAdvisory', true
  );
end
$function$;

revoke all on function vortex_record.authorize_index_status_internal(uuid, uuid),
  vortex_record.read_application_index_status(uuid, uuid, bigint, jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_record.read_application_index_status(
  uuid, uuid, bigint, jsonb
) to vortex_request;

comment on function vortex_record.authorize_index_status_internal(uuid, uuid) is
  'Private authority for the index-status read: Application-management permission, validated organisation context and the exact owned Application.';
comment on function vortex_record.read_application_index_status(
  uuid, uuid, bigint, jsonb
) is 'Protected live status of every exact field index one active Application installation owns: pending, running, ready, interrupted or conflicting, with bounded progress and no physical detail.';

-- ============================================================================
-- Conflict resolution. Duplicate record rows live behind the forced
-- `record_data` row-level security policies and only `vortex_record_adapter`
-- satisfies them, so the search and the per-record read decision run under
-- that owner. The read itself never returns a raw field value.
-- ============================================================================

reset role;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

set local role vortex_record_adapter;

-- Finds the duplicate scope/value groups of one exact uniqueness field and
-- resolves every participating record through the existing exact read
-- decision. `none` means no conflict, `readable` returns only record
-- references the current caller may read, and `unreadable` collapses the whole
-- conflict to one generic refusal with no id, value, count or reason. A
-- conflict too large to resolve within the bound fails closed as `unreadable`.
create function vortex_record.read_index_conflict_references_internal(
  p_record_type_id uuid,
  p_table_token text,
  p_scope_columns text,
  p_column_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  max_groups constant integer := 100;
  max_records constant integer := 1000;
  conflict_sql text;
  group_row record;
  record_id_value uuid;
  loaded jsonb;
  decision jsonb;
  readable_references jsonb := '[]'::jsonb;
  group_count integer := 0;
  record_count integer := 0;
begin
  if p_record_type_id is null
    or p_record_type_id = nil_uuid
    or p_table_token is null
    or p_table_token !~ '^rt_[a-f0-9]{32}$'
    or p_column_token is null
    or p_column_token !~ '^f_[a-f0-9]{32}$'
    or p_scope_columns is null
    or p_scope_columns not in ('organisation_id', 'organisation_id, application_root_id') then
    raise exception using errcode = '55000',
      message = 'Index conflict selector is invalid';
  end if;

  -- Only the participating record identities are selected; the conflicting
  -- field value is grouped on but never projected, so no raw value can leave.
  -- The search mirrors the unique index exactly: its lifecycle predicate, and
  -- no null value, because the index treats every null as distinct. The
  -- forced `record_data` policies keep it to the caller's organisation and
  -- Application.
  conflict_sql := pg_catalog.format(
    'select pg_catalog.array_agg(stored.record_id order by stored.record_id) as record_ids
     from record_data.%I as stored
     where stored.lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')
       and stored.%I is not null
     group by %s, stored.%I
     having pg_catalog.count(*) > 1
     order by 1
     limit %s',
    p_table_token, p_column_token, p_scope_columns, p_column_token, max_groups + 1
  );

  for group_row in execute conflict_sql
  loop
    group_count := group_count + 1;
    if group_count > max_groups then
      return pg_catalog.jsonb_build_object('outcome', 'unreadable');
    end if;

    for record_id_value in
      select id.value from pg_catalog.unnest(group_row.record_ids) as id(value)
    loop
      record_count := record_count + 1;
      if record_count > max_records then
        return pg_catalog.jsonb_build_object('outcome', 'unreadable');
      end if;

      begin
        loaded := vortex_record.load_record_access_facts_internal(
          p_record_type_id, 'read', record_id_value, null
        );
        if loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object'
          or pg_catalog.jsonb_typeof(loaded -> 'facts') <> 'object' then
          return pg_catalog.jsonb_build_object('outcome', 'unreadable');
        end if;

        decision := vortex_access.evaluate_organization_record_access_internal(
          loaded -> 'declaration', record_id_value, loaded -> 'facts'
        );
        -- Any unreadable participant collapses the whole conflict; a partial
        -- listing would be an existence oracle for the hidden rows.
        if decision ->> 'outcome' <> 'allowed' then
          return pg_catalog.jsonb_build_object('outcome', 'unreadable');
        end if;
      exception
        when others then
          -- Candidate-specific failures carry record detail; they collapse
          -- exactly like a refused decision.
          return pg_catalog.jsonb_build_object('outcome', 'unreadable');
      end;

      readable_references := readable_references || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'recordTypeId', p_record_type_id,
          'recordId', record_id_value
        )
      );
    end loop;
  end loop;

  if group_count = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'none');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'readable', 'records', readable_references);
end
$function$;

revoke all on function vortex_record.read_index_conflict_references_internal(
  uuid, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_record.read_index_conflict_references_internal(
  uuid, text, text, text
) to vortex_record_owner;

comment on function vortex_record.read_index_conflict_references_internal(
  uuid, text, text, text
) is 'Adapter-owned resolution of one uniqueness index conflict: duplicate record identities only, each behind the exact read decision, collapsing wholly to one generic refusal when any participant is unreadable.';

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
