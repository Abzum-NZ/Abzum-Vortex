-- Protected Record relationship locks for registered People and Group projections (#1726).

-- The canonical Access lock protects the underlying account or group row; the Record

-- lock dispatches by the active storage catalogue and preserves the existing Access

-- decision after the lock. Every changed function is installed from its canonical file.

begin;

create or replace function vortex_access.lock_system_projection_link_target_internal(
  p_protected_read_model_key text,
  p_target_record_id uuid,
  p_organization_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  matched boolean;
begin
  if p_protected_read_model_key is null
    or p_protected_read_model_key not in ('organization_accounts', 'groups')
    or p_target_record_id is null
    or p_target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'organizationId')::uuid is distinct from p_organization_id
    or not exists (
      select 1
      from vortex_record.protected_read_model_views as registered
      where registered.protected_read_model_key = p_protected_read_model_key
        and (
          (p_protected_read_model_key = 'organization_accounts'
            and registered.reader_schema = 'vortex_access'
            and registered.reader_function = 'list_organization_accounts_projection')
          or (p_protected_read_model_key = 'groups'
            and registered.reader_schema = 'vortex_access'
            and registered.reader_function = 'list_organization_groups_projection')
        )
    ) then
    return false;
  end if;

  if p_protected_read_model_key = 'organization_accounts' then
    select true into matched
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as projection
      on projection.identity_id = account.identity_id
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_target_record_id
      and account.state = 'active'
      and projection.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
    for share of account, projection;
  else
    select true into matched
    from vortex_access.organization_groups as organization_group
    join vortex_identity.organizations as organization
      on organization.organization_id = organization_group.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where organization_group.organization_id = p_organization_id
      and organization_group.group_id = p_target_record_id
      and organization_group.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
    for share of organization_group;
  end if;

  return coalesce(matched, false);
end
$function$;

revoke all on function vortex_access.lock_system_projection_link_target_internal(text, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

grant execute on function vortex_access.lock_system_projection_link_target_internal(text, uuid, uuid)
  to vortex_record_adapter, vortex_record_owner;

comment on function vortex_access.lock_system_projection_link_target_internal(text, uuid, uuid) is
  'Private protected system-projection link lock: share-locks only an active same-organisation People account and its active identity projection, or an active Group, after confirming the registered reader and current organisation; read authority remains with the Record access decision.';

set local role vortex_record_owner;

grant create on schema vortex_record to vortex_record_adapter;

reset role;

set local role vortex_record_adapter;

create or replace function vortex_record.lock_relationship_target_row_internal(
  p_target_record_type_id uuid,
  p_target_record_id uuid,
  p_organization_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  target_meta jsonb;
  target_schema text;
  target_protected_read_model_key text;
  target_locked boolean;
begin
  if p_target_record_type_id is null or p_target_record_id is null
    or p_organization_id is null
    or p_target_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Relationship target is invalid';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(
    p_target_record_type_id, 'read'
  );
  select catalogue.physical_schema_token, catalogue.protected_read_model_key
    into target_schema, target_protected_read_model_key
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = (target_meta ->> 'storageContractId')::uuid
    and catalogue.record_type_id = p_target_record_type_id
    and catalogue.state = 'active';
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Relationship target is unavailable';
  end if;

  if target_schema = 'record_data'
    and pg_catalog.jsonb_typeof(target_meta -> 'table') = 'string' then
    target_locked := false;
    execute pg_catalog.format(
      'select true from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active'' for share',
      target_meta ->> 'table'
    ) into target_locked using p_organization_id, p_target_record_id;
  elsif target_schema = 'system_projection' then
    target_locked := vortex_access.lock_system_projection_link_target_internal(
      target_protected_read_model_key, p_target_record_id, p_organization_id
    );
  else
    target_locked := false;
  end if;

  if not coalesce(target_locked, false) then
    raise exception using errcode = 'P0002',
      message = 'Relationship target is unavailable';
  end if;
end
$function$;

alter function vortex_record.lock_relationship_target_row_internal(uuid, uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.lock_relationship_target_row_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

grant execute on function vortex_record.lock_relationship_target_row_internal(uuid, uuid, uuid)
  to vortex_record_adapter, vortex_record_owner;

comment on function vortex_record.lock_relationship_target_row_internal(uuid, uuid, uuid) is
  'One canonical protected target lock for relationship changes: share-locks an active record_data row or delegates registered People and Group projections to Access for an active same-organisation protected-row lock before the link edge is installed.';

create or replace function vortex_record.share_lock_named_action_target_internal(
  p_catalogue jsonb,
  p_record_type_id uuid,
  p_record_id uuid
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type jsonb;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;

  select item.value into record_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') =
    pg_catalog.lower(p_record_type_id::text);
  if record_type is null or not exists (
    select 1
    from vortex_record.storage_catalogue as stored
    where stored.storage_contract_id = (record_type ->> 'storageContractId')::uuid
      and stored.record_type_id = p_record_type_id
      and stored.state = 'active'
  ) then
    return false;
  end if;

  context_value := vortex_access.validated_human_request_context();
  begin
    perform vortex_record.lock_relationship_target_row_internal(
      p_record_type_id, p_record_id,
      (context_value ->> 'organizationId')::uuid
    );
    return true;
  exception when no_data_found then
    return false;
  end;
end
$function$;

alter function vortex_record.share_lock_named_action_target_internal(jsonb, uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.share_lock_named_action_target_internal(jsonb, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

grant execute on function vortex_record.share_lock_named_action_target_internal(jsonb, uuid, uuid)
  to vortex_record_adapter;

comment on function vortex_record.share_lock_named_action_target_internal(jsonb, uuid, uuid) is
  'Private named-action preflight target lock: checks the installed target contract, then takes the canonical active same-organisation record or protected projection lock before later command locks.';

create or replace function vortex_record.write_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_increment_source_revision boolean
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  source_meta jsonb;
  source_context jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_value jsonb;
  field_column jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  source_application_root_id uuid;
  target_application_root_id uuid;
  mapping_row vortex_record.relationship_storage_mappings%rowtype;
  existing_other boolean;
  update_sql text;
  changed_rows integer;
begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null or p_increment_source_revision is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
  end if;
  source_meta := vortex_record.resolve_record_action_context_internal(
    p_source_record_type_id, 'read'
  );
  source_context := source_meta -> 'context';
  source_type := source_meta -> 'recordType';
  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(source_type -> 'relationships') as item(value)
  where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
  if not found then
    raise exception using errcode = '23514',
      message = 'Relationship is not declared by the active record type';
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(source_type -> 'fields') as item(value)
  where (item.value ->> 'fieldId')::uuid = (relationship_value ->> 'fromFieldId')::uuid;
  if not found or field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
    raise exception using errcode = '55000',
      message = 'Relationship field definition is unavailable';
  end if;
  field_column := source_meta -> 'columns' -> pg_catalog.lower(field_value ->> 'fieldId');

  select mapping.* into mapping_row
  from vortex_record.relationship_storage_mappings as mapping
  where mapping.relationship_id = p_relationship_id
    and mapping.source_storage_contract_id =
      (source_meta ->> 'storageContractId')::uuid
    and mapping.source_field_id = (field_value ->> 'fieldId')::uuid
    and mapping.release_revision <= (source_meta ->> 'moduleReleaseRevision')::bigint;
  if not found
    or mapping_row.cardinality is distinct from (relationship_value ->> 'cardinality')
    or mapping_row.on_parent_delete is distinct from (relationship_value ->> 'onParentDelete') then
    raise exception using errcode = '55000',
      message = 'Relationship storage disagrees with the active definition';
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    if p_increment_source_revision then
      perform vortex_record.bump_record_data_version_internal(
        (source_context ->> 'organizationId')::uuid,
        (source_meta ->> 'storageContractId')::uuid,
        case when source_meta ->> 'storageScope' = 'application_contained'
          then (source_context ->> 'applicationRootId')::uuid else null end
      );
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    delete from vortex_record.relationship_edges as edge
    where edge.relationship_id = p_relationship_id
      and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
      and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
      and edge.from_record_id = p_source_record_id;
    update_sql := pg_catalog.format(
      'update record_data.%I as stored set %I = null%s
       where stored.organisation_id = $1 and stored.record_id = $2',
      source_meta ->> 'table', field_column ->> 'token',
      case when p_increment_source_revision then
        ', concurrency_number = concurrency_number + 1, updated_at = pg_catalog.statement_timestamp(), updated_by = $3'
      else '' end
    );
    if p_increment_source_revision then
      execute update_sql using (source_context ->> 'organizationId')::uuid,
        p_source_record_id, (source_context ->> 'organizationAccountId')::uuid;
    else
      execute update_sql using (source_context ->> 'organizationId')::uuid,
        p_source_record_id;
    end if;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001',
        message = 'Relationship source record changed';
    end if;
    return;
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) <> 'object'
    or not (p_target_value ?& array['recordTypeId', 'recordId'])
    or p_target_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end if;
  begin
    target_type_id := (p_target_value ->> 'recordTypeId')::uuid;
    target_record_id := (p_target_value ->> 'recordId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end;
  if target_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_type_id <> all (mapping_row.target_record_type_ids) then
    raise exception using errcode = '23514', message = 'Relationship target is unavailable';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  source_application_root_id := case when source_meta ->> 'storageScope' = 'application_contained'
    then (source_context ->> 'applicationRootId')::uuid else null end;

  -- Lock the protected row behind either ordinary record storage or a
  -- registered system projection before rebuilding eligibility from current
  -- facts. The lock is held until commit, so the target cannot disappear while
  -- the unconstrainted relationship edge is installed.
  perform vortex_record.lock_relationship_target_row_internal(
    target_type_id, target_record_id,
    (source_context ->> 'organizationId')::uuid
  );

  target_loaded := vortex_record.load_record_access_facts_internal(
    target_type_id, 'read', target_record_id, null
  );
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  target_decision := vortex_access.evaluate_organization_record_access_internal(
    target_loaded -> 'declaration', target_record_id, target_loaded -> 'facts'
  );
  if target_decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  select item.value into target_record
  from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = target_record_id;
  target_scope := target_record -> 'recordScope';
  target_application_root_id := case when target_meta ->> 'storageScope' = 'application_contained'
    then (target_scope ->> 'applicationRootId')::uuid else null end;
  if target_record is null or target_record ->> 'lifecycleState' <> 'active'
    or (target_scope ->> 'organizationId')::uuid <>
      (source_context ->> 'organizationId')::uuid
    or (source_application_root_id is not null and target_application_root_id is not null
      and source_application_root_id <> target_application_root_id) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- The target row is share-locked and eligible. The source data version is
  -- taken next, then the shared edge identities last.
  if p_increment_source_revision then
    perform vortex_record.bump_record_data_version_internal(
      (source_context ->> 'organizationId')::uuid,
      (source_meta ->> 'storageContractId')::uuid,
      source_application_root_id
    );
  end if;
  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );
  if mapping_row.cardinality = 'one_to_one' then
    select exists (
      select 1 from vortex_record.relationship_edges as edge
      where edge.relationship_id = p_relationship_id
        and edge.to_organisation_id = (source_context ->> 'organizationId')::uuid
        and edge.to_storage_contract_id = (target_meta ->> 'storageContractId')::uuid
        and edge.to_record_id = target_record_id
        and edge.from_record_id <> p_source_record_id
    ) into existing_other;
    if existing_other then
      raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
    end if;
  end if;

  delete from vortex_record.relationship_edges as edge
  where edge.relationship_id = p_relationship_id
    and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
    and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and edge.from_record_id = p_source_record_id;
  insert into vortex_record.relationship_edges (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    p_relationship_id,
    (source_context ->> 'organizationId')::uuid,
    (source_context ->> 'organizationId')::uuid,
    source_application_root_id, target_application_root_id,
    (source_meta ->> 'storageContractId')::uuid, p_source_record_id,
    (target_meta ->> 'storageContractId')::uuid, target_record_id
  );

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %I = $3::jsonb%s
     where stored.organisation_id = $1 and stored.record_id = $2',
    source_meta ->> 'table', field_column ->> 'token',
    case when p_increment_source_revision then
      ', concurrency_number = concurrency_number + 1, updated_at = pg_catalog.statement_timestamp(), updated_by = $4'
    else '' end
  );
  if p_increment_source_revision then
    execute update_sql using (source_context ->> 'organizationId')::uuid,
      p_source_record_id, p_target_value,
      (source_context ->> 'organizationAccountId')::uuid;
  else
    execute update_sql using (source_context ->> 'organizationId')::uuid,
      p_source_record_id, p_target_value;
  end if;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Relationship source record changed';
  end if;
end
$function$;

alter function vortex_record.write_relationship_value_internal(uuid,uuid,uuid,jsonb,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean) is
  'Private relationship writer: validates the declared relationship and target eligibility, share-locks the record or protected projection target, then takes the source data version and the shared edge identities before replacing the source link edge and typed value atomically. Owner-only.';

create or replace function vortex_record.write_named_action_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_subject_record_type_id uuid,
  p_subject_record_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  source_meta jsonb;
  source_context jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_value jsonb;
  field_column jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  source_application_root_id uuid;
  target_application_root_id uuid;
  mapping_row vortex_record.relationship_storage_mappings%rowtype;
  existing_other boolean;
  update_sql text;
  changed_rows integer;
begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_subject_record_type_id is null or p_subject_record_id is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
  end if;
  source_meta := vortex_record.resolve_record_action_context_internal(
    p_source_record_type_id, 'read'
  );
  source_context := source_meta -> 'context';
  source_type := source_meta -> 'recordType';
  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(source_type -> 'relationships') as item(value)
  where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
  if not found then
    raise exception using errcode = '23514',
      message = 'Relationship is not declared by the active record type';
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(source_type -> 'fields') as item(value)
  where (item.value ->> 'fieldId')::uuid = (relationship_value ->> 'fromFieldId')::uuid;
  if not found or field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
    raise exception using errcode = '55000',
      message = 'Relationship field definition is unavailable';
  end if;
  field_column := source_meta -> 'columns' -> pg_catalog.lower(field_value ->> 'fieldId');

  select mapping.* into mapping_row
  from vortex_record.relationship_storage_mappings as mapping
  where mapping.relationship_id = p_relationship_id
    and mapping.source_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and mapping.source_field_id = (field_value ->> 'fieldId')::uuid
    and mapping.release_revision <= (source_meta ->> 'moduleReleaseRevision')::bigint;
  if not found
    or mapping_row.cardinality is distinct from (relationship_value ->> 'cardinality')
    or mapping_row.on_parent_delete is distinct from (relationship_value ->> 'onParentDelete') then
    raise exception using errcode = '55000',
      message = 'Relationship storage disagrees with the active definition';
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    delete from vortex_record.relationship_edges as edge
    where edge.relationship_id = p_relationship_id
      and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
      and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
      and edge.from_record_id = p_source_record_id;
    update_sql := pg_catalog.format(
      'update record_data.%I as stored set %I = null
       where stored.organisation_id = $1 and stored.record_id = $2',
      source_meta ->> 'table', field_column ->> 'token'
    );
    execute update_sql using (source_context ->> 'organizationId')::uuid, p_source_record_id;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Relationship source record changed';
    end if;
    return;
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) <> 'object'
    or not (p_target_value ?& array['recordTypeId', 'recordId'])
    or p_target_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end if;
  begin
    target_type_id := (p_target_value ->> 'recordTypeId')::uuid;
    target_record_id := (p_target_value ->> 'recordId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end;
  if target_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_type_id <> all (mapping_row.target_record_type_ids) then
    raise exception using errcode = '23514', message = 'Relationship target is unavailable';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  source_application_root_id := case when source_meta ->> 'storageScope' = 'application_contained'
    then (source_context ->> 'applicationRootId')::uuid else null end;

  perform vortex_record.lock_relationship_target_row_internal(
    target_type_id, target_record_id,
    (source_context ->> 'organizationId')::uuid
  );

  -- The one substitution. Executing a permitted named action must not require
  -- ordinary read authority on its own subject (#50 section 4), so when the
  -- selected target is exactly this command's subject the decision is taken on
  -- the installed named declaration instead. The loader re-resolves the active
  -- installation, the owner kind/id/release revision, the action id and the
  -- action's declared subject record type, and the Access evaluation binds the
  -- organization, application, record type, record and the actor's current
  -- authority. Every other target keeps the ordinary read check unchanged.
  if target_type_id = p_subject_record_type_id and target_record_id = p_subject_record_id then
    target_loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, target_type_id, target_record_id, null
    );
  else
    target_loaded := vortex_record.load_record_access_facts_internal(
      target_type_id, 'read', target_record_id, null
    );
  end if;
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  target_decision := vortex_access.evaluate_organization_record_access_internal(
    target_loaded -> 'declaration', target_record_id, target_loaded -> 'facts'
  );
  if target_decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  select item.value into target_record
  from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = target_record_id;
  target_scope := target_record -> 'recordScope';
  target_application_root_id := case when target_meta ->> 'storageScope' = 'application_contained'
    then (target_scope ->> 'applicationRootId')::uuid else null end;
  if target_record is null or target_record ->> 'lifecycleState' <> 'active'
    or (target_scope ->> 'organizationId')::uuid <>
      (source_context ->> 'organizationId')::uuid
    or (source_application_root_id is not null and target_application_root_id is not null
      and source_application_root_id <> target_application_root_id) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- The target row is share-locked (the command preflight already holds every
  -- link target) and eligible; the shared edge identities are taken last,
  -- exactly as `write_relationship_value_internal` takes them.
  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );
  if mapping_row.cardinality = 'one_to_one' then
    select exists (
      select 1 from vortex_record.relationship_edges as edge
      where edge.relationship_id = p_relationship_id
        and edge.to_organisation_id = (source_context ->> 'organizationId')::uuid
        and edge.to_storage_contract_id = (target_meta ->> 'storageContractId')::uuid
        and edge.to_record_id = target_record_id
        and edge.from_record_id <> p_source_record_id
    ) into existing_other;
    if existing_other then
      raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
    end if;
  end if;

  delete from vortex_record.relationship_edges as edge
  where edge.relationship_id = p_relationship_id
    and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
    and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and edge.from_record_id = p_source_record_id;
  insert into vortex_record.relationship_edges (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    p_relationship_id,
    (source_context ->> 'organizationId')::uuid,
    (source_context ->> 'organizationId')::uuid,
    source_application_root_id, target_application_root_id,
    (source_meta ->> 'storageContractId')::uuid, p_source_record_id,
    (target_meta ->> 'storageContractId')::uuid, target_record_id
  );

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %I = $3::jsonb
     where stored.organisation_id = $1 and stored.record_id = $2',
    source_meta ->> 'table', field_column ->> 'token'
  );
  execute update_sql using (source_context ->> 'organizationId')::uuid,
    p_source_record_id, p_target_value;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Relationship source record changed';
  end if;
end
$function$;

alter function vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) owner to vortex_record_adapter;

revoke all on function
  vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

grant execute on function
  vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) to vortex_record_adapter;

comment on function vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) is
  'Private named-action edge writer: uses the ordinary or protected projection target lock and edge flow, except that the command subject is authorised by re-evaluating the exact installed named action rather than ordinary read.';

reset role;

set local role vortex_record_adapter;

create or replace function vortex_record.restore_record_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  context_value jsonb;
  loaded jsonb;
  facts jsonb;
  record_fact jsonb;
  decision jsonb;
  field_item jsonb;
  relationship_value jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  target_catalogue vortex_record.storage_catalogue%rowtype;
  retained_value jsonb;
  retained_target_type_id uuid;
  retained_target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  changed_rows integer;
  app_scope uuid;
begin
  if p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  begin
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'restore');
    context_value := meta -> 'context';
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'restore', p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
      raise exception using errcode = 'P0002', message = 'Record is unavailable';
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
    if record_fact ->> 'lifecycleState' <> 'soft_deleted' then
      raise exception using errcode = 'P0002', message = 'Record is unavailable';
    end if;

    -- Restore access is decided over the retained row projected as the active
    -- candidate it would become.  The retained values/owner are unchanged.
    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta -> 'declaration' -> 'recordBinding',
      'records', (
        select pg_catalog.jsonb_agg(
          case when (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id
            then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active')
            else item.value end order by item.ordinality
        )
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
          with ordinality as item(value, ordinality)
      )
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', p_record_id, facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = 'P0002', message = 'Record is unavailable';
    end if;

    -- A restore keeps the retained values. Validate the narrow invariants this
    -- primitive owns: every currently required non-link value is present,
    -- non-null and has its canonical storage shape; every required link agrees
    -- with exactly one retained edge to a locked, active, currently readable
    -- target. Full final-value settings validation remains owned by #47.
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
      where (item.value ->> 'required')::boolean
    loop
      retained_value := record_fact -> 'fieldValues'
        -> pg_catalog.lower(field_item ->> 'fieldId');
      if not ((record_fact -> 'fieldValues') ? pg_catalog.lower(field_item ->> 'fieldId'))
        or pg_catalog.jsonb_typeof(retained_value) = 'null' then
        raise exception using errcode = '23514', message = 'Required retained value is unavailable';
      end if;

      if field_item ->> 'type' not in ('link', 'link_to_one_of_several') then
        if not vortex_record.canonical_record_value_matches(
          retained_value,
          field_item ->> 'type',
          meta -> 'columns' -> pg_catalog.lower(field_item ->> 'fieldId')
            ->> 'databaseValueType'
        ) then
          raise exception using errcode = '23514', message = 'Required retained value is invalid';
        end if;
        continue;
      end if;

      select item.value into strict relationship_value
      from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
      where (item.value ->> 'fromFieldId')::uuid = (field_item ->> 'fieldId')::uuid;

      -- #402 supports the existing fixed-target to-one relationship contract.
      -- A polymorphic declaration is not inferred here.
      if relationship_value -> 'toRecordType' ->> 'state' <> 'resolved'
        or not (relationship_value -> 'toRecordType' ? 'recordTypeId')
        or pg_catalog.jsonb_typeof(retained_value) <> 'object'
        or not (retained_value ?& array['recordTypeId', 'recordId'])
        or retained_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      begin
        retained_target_type_id := (retained_value ->> 'recordTypeId')::uuid;
        retained_target_record_id := (retained_value ->> 'recordId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end;
      if retained_target_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      if retained_target_type_id <>
          (relationship_value -> 'toRecordType' ->> 'recordTypeId')::uuid then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;

      select edge.* into strict edge_row
      from vortex_record.relationship_edges as edge
      where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
        and edge.from_organisation_id = (context_value ->> 'organizationId')::uuid
        and edge.from_storage_contract_id = (meta ->> 'storageContractId')::uuid
        and edge.from_record_id = p_record_id;
      if edge_row.to_organisation_id <> (context_value ->> 'organizationId')::uuid
        or edge_row.to_record_id <> retained_target_record_id then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      select catalogue.* into strict target_catalogue
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = edge_row.to_storage_contract_id
        and catalogue.record_type_id = retained_target_type_id
        and catalogue.physical_schema_token in ('record_data', 'system_projection')
        and catalogue.state = 'active';

      perform vortex_record.lock_relationship_target_row_internal(
        retained_target_type_id, retained_target_record_id,
        (context_value ->> 'organizationId')::uuid
      );

      target_loaded := vortex_record.load_record_access_facts_internal(
        retained_target_type_id, 'read', retained_target_record_id, null
      );
      if target_loaded ->> 'outcome' <> 'loaded'
        or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      target_decision := vortex_access.evaluate_organization_record_access_internal(
        target_loaded -> 'declaration', retained_target_record_id, target_loaded -> 'facts'
      );
      if target_decision ->> 'outcome' <> 'allowed' then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      select item.value into target_record
      from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
      where (item.value -> 'recordScope' ->> 'recordId')::uuid = retained_target_record_id;
      target_scope := target_record -> 'recordScope';
      if target_record is null or target_record ->> 'lifecycleState' <> 'active'
        or (target_scope ->> 'organizationId')::uuid <>
          (context_value ->> 'organizationId')::uuid
        or edge_row.to_application_root_id is distinct from (
          case when target_scope ->> 'storageScope' = 'application_contained'
            then (target_scope ->> 'applicationRootId')::uuid else null end
        ) then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
    end loop;

    execute pg_catalog.format(
      'update record_data.%I as stored
       set lifecycle_state = ''active'', concurrency_number = concurrency_number + 1,
         updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
         deleted_at = null, deleted_by = null, removal_due_at = null,
         definition_revision = $4
       where organisation_id = $1 and record_id = $2
         and lifecycle_state = ''soft_deleted'' and concurrency_number = $5',
      meta ->> 'table'
    ) using (context_value ->> 'organizationId')::uuid, p_record_id,
      (context_value ->> 'organizationAccountId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Record restore revision changed';
    end if;
    app_scope := case when meta ->> 'storageScope' = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end;
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid, app_scope
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', p_record_id,
      'concurrencyNumber', p_expected_concurrency_number + 1
    );
  exception
    when serialization_failure or deadlock_detected then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    when no_data_found or too_many_rows or insufficient_privilege or check_violation
      or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end;
end
$function$;

alter function vortex_record.restore_record_internal(uuid, uuid, bigint)
  owner to vortex_record_adapter;

revoke all on function vortex_record.restore_record_internal(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.restore_record_internal(uuid, uuid, bigint) is
  'Private revision-checked restore primitive over retained facts, current Access, current definition and required relationships; it locks record or protected projection targets through the canonical relationship lock and enforces no recovery window.';

reset role;

set local role vortex_record_owner;

revoke create on schema vortex_record from vortex_record_adapter;

reset role;

commit;
