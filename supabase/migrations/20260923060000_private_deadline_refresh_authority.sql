-- Private deadline refresh authority, claim and attribution.
-- Consumes an organisation/record due metadata row, resolves only the
-- configured live deadline actor for the exact organisation/application scope,
-- refuses disabled/missing/mismatched actor configuration, and provides
-- stable root, effect and attribution metadata for retry-safe orchestration.

begin;

set local role vortex_record_owner;

-- Internal helper: resolves only the active live deadline actor for the scope.
-- Remains private to the Record owner and adapter; no login, activation or public grant.
create function vortex_record.resolve_configured_deadline_actor_internal(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  binding_row vortex_record.deadline_actor_bindings%rowtype;
  actor_row vortex_record.deadline_actors%rowtype;
begin
  if p_organization_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'actor_configuration_missing'
    );
  end if;

  select binding.* into binding_row
  from vortex_record.deadline_actor_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id is not distinct from p_application_root_id
    and binding.operation = 'refresh_record_deadline';

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'actor_configuration_missing',
      'organizationId', p_organization_id,
      'applicationRootId', p_application_root_id
    );
  end if;

  if binding_row.state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', case binding_row.state
        when 'revoked' then 'actor_configuration_revoked'
        else 'actor_configuration_disabled'
      end,
      'bindingId', binding_row.binding_id,
      'state', binding_row.state,
      'organizationId', p_organization_id,
      'applicationRootId', p_application_root_id
    );
  end if;

  if binding_row.current_actor_id is null or binding_row.execution_session_role_oid is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'actor_configuration_mismatched',
      'bindingId', binding_row.binding_id,
      'organizationId', p_organization_id,
      'applicationRootId', p_application_root_id
    );
  end if;

  select actor.* into actor_row
  from vortex_record.deadline_actors as actor
  where actor.actor_id = binding_row.current_actor_id
    and actor.binding_id = binding_row.binding_id
    and actor.organization_id = p_organization_id
    and actor.application_root_id is not distinct from p_application_root_id
    and actor.operation = 'refresh_record_deadline'
    and actor.generation = binding_row.generation
    and actor.revoked_at is null;

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'actor_configuration_mismatched',
      'bindingId', binding_row.binding_id,
      'organizationId', p_organization_id,
      'applicationRootId', p_application_root_id
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'resolved',
    'bindingId', binding_row.binding_id,
    'actorId', actor_row.actor_id,
    'generation', binding_row.generation,
    'operation', 'refresh_record_deadline',
    'systemActorId', actor_row.actor_id,
    'executionSessionRoleOid', binding_row.execution_session_role_oid
  );
end
$function$;

alter function vortex_record.resolve_configured_deadline_actor_internal(uuid, uuid)
  owner to vortex_record_owner;

revoke all on function vortex_record.resolve_configured_deadline_actor_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.resolve_configured_deadline_actor_internal(uuid, uuid)
  to vortex_record_adapter;

reset role;

-- Internal helper: establishes trusted system context and resolves time zone.
-- Owned by postgres; granted only to vortex_record_adapter.
create function vortex_record.establish_deadline_system_context_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_actor_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  org_tenant_id uuid;
  org_access_version bigint;
  org_time_zone text := 'UTC';
  established_context jsonb;
begin
  select org.tenant_id into org_tenant_id
  from vortex_identity.organizations as org
  where org.organization_id = p_organization_id;

  select version.current_version into org_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id;

  select settings.time_zone into org_time_zone
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id;

  begin
    established_context := vortex_context.current_context();
    if (established_context ->> 'organizationId')::uuid is distinct from p_organization_id
      or (p_application_root_id is not null
          and (established_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id) then
      return null;
    end if;
  exception when others then
    perform vortex_context.initialize(pg_catalog.jsonb_build_object(
      'callerKind', 'system',
      'tenantId', org_tenant_id,
      'organizationId', p_organization_id,
      'applicationRootId', p_application_root_id,
      'systemActorId', p_actor_id,
      'sessionId', pg_catalog.gen_random_uuid(),
      'authenticationStrength', 'service',
      'issuedAt', pg_catalog.statement_timestamp(),
      'expiresAt', pg_catalog.statement_timestamp() + interval '1 hour',
      'accessVersion', coalesce(org_access_version, 1),
      'correlationId', pg_catalog.gen_random_uuid()
    ));
  end;

  return coalesce(org_time_zone, 'UTC');
end
$function$;

alter function vortex_record.establish_deadline_system_context_internal(uuid, uuid, uuid)
  owner to postgres;

revoke all on function vortex_record.establish_deadline_system_context_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.establish_deadline_system_context_internal(uuid, uuid, uuid)
  to vortex_record_adapter;

-- Enable the private adapter to claim and update due metadata.
set local role vortex_record_adapter;

create policy record_deadline_due_metadata_claim_select
  on vortex_record.record_deadline_due_metadata
  for select
  to vortex_record_adapter
  using (true);

create policy record_deadline_due_metadata_claim_update
  on vortex_record.record_deadline_due_metadata
  for update
  to vortex_record_adapter
  using (true)
  with check (true);

create policy record_deadline_due_metadata_claim_delete
  on vortex_record.record_deadline_due_metadata
  for delete
  to vortex_record_adapter
  using (true);

-- The private claiming / recalculation operation.
create function vortex_record.claim_record_deadline_refresh(
  p_organization_id uuid default null,
  p_record_id uuid default null,
  p_application_root_id uuid default null,
  p_due_before timestamptz default null,
  p_recalculated_transition jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  due_row vortex_record.record_deadline_due_metadata%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  actor_resolution jsonb;
  record_row record;
  field_item jsonb;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  columns_value jsonb := '{}'::jsonb;
  column_entry record;
  value_expression text;
  existing_field_values jsonb := '{}'::jsonb;
  org_time_zone text;
  transition_field_id uuid;
  transition_at_value timestamptz;
  effect_identity text;
  effect_id uuid;
begin
  if p_organization_id is not null and p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  if p_record_id is not null and p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  -- 1. Safely claim one due row under exclusive row lock, skipping locked candidates
  select metadata.* into due_row
  from vortex_record.record_deadline_due_metadata as metadata
  where (p_organization_id is null or metadata.organization_id = p_organization_id)
    and (p_record_id is null or metadata.record_id = p_record_id)
    and (p_application_root_id is null or metadata.application_root_id is not distinct from p_application_root_id)
    and metadata.transition_at <= coalesce(p_due_before, pg_catalog.statement_timestamp())
  order by metadata.transition_at asc, metadata.changed_at asc
  limit 1
  for update skip locked;

  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'none');
  end if;

  -- 2. Resolve only the configured live deadline actor for the exact organisation/application scope
  actor_resolution := vortex_record.resolve_configured_deadline_actor_internal(
    due_row.organization_id, due_row.application_root_id
  );
  if actor_resolution ->> 'outcome' <> 'resolved' then
    return actor_resolution;
  end if;

  -- 3. Lock and recheck current storage catalogue
  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = due_row.storage_contract_id;

  if not found or catalogue_row.state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'storage_contract_unavailable'
    );
  end if;

  -- 4. Establish or verify system execution context
  org_time_zone := vortex_record.establish_deadline_system_context_internal(
    due_row.organization_id,
    due_row.application_root_id,
    (actor_resolution ->> 'actorId')::uuid
  );
  if org_time_zone is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'reasonCode', 'context_scope_mismatch'
    );
  end if;

  -- 5. Lock and recheck record in physical table
  execute pg_catalog.format(
    'select concurrency_number, lifecycle_state from record_data.%I where record_id = %L and organisation_id = %L and (%s) for update',
    catalogue_row.physical_table_token,
    due_row.record_id,
    due_row.organization_id,
    case when due_row.application_root_id is null then 'application_root_id is null'
      else pg_catalog.format('application_root_id = %L', due_row.application_root_id) end
  ) into record_row;

  if not found or record_row.lifecycle_state <> 'active' then
    delete from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = due_row.organization_id
      and metadata.storage_contract_id = due_row.storage_contract_id
      and metadata.record_id = due_row.record_id
      and metadata.application_root_id is not distinct from due_row.application_root_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'reasonCode', 'record_unavailable'
    );
  end if;

  if record_row.concurrency_number <> due_row.record_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'reasonCode', 'concurrency_mismatch',
      'expectedConcurrencyNumber', due_row.record_concurrency_number,
      'currentConcurrencyNumber', record_row.concurrency_number
    );
  end if;

  -- 6. Read authoritative field values from physical table
  for field_item in
    select item.value
    from pg_catalog.jsonb_array_elements(catalogue_row.record_type_definition -> 'fields') as item(value)
  loop
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = catalogue_row.storage_contract_id
      and mapping.field_id = (field_item ->> 'fieldId')::uuid;
    if found and mapping_row.state = 'active' then
      columns_value := columns_value || pg_catalog.jsonb_build_object(
        pg_catalog.lower(field_item ->> 'fieldId'), pg_catalog.jsonb_build_object(
          'token', mapping_row.physical_column_token,
          'databaseValueType', mapping_row.database_value_type
        )
      );
    end if;
  end loop;

  select pg_catalog.string_agg(
    pg_catalog.format(
      '%L, %s',
      column_entry.key,
      case column_entry.value ->> 'databaseValueType'
        when 'decimal' then
          pg_catalog.format('pg_catalog.to_jsonb(%I::text)', column_entry.value ->> 'token')
        when 'timestamp_with_time_zone' then
          pg_catalog.format(
            'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', %I), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))',
            column_entry.value ->> 'token'
          )
        when 'date' then
          pg_catalog.format(
            'pg_catalog.to_jsonb(pg_catalog.to_char(%I, ''YYYY-MM-DD''))',
            column_entry.value ->> 'token'
          )
        else pg_catalog.format('pg_catalog.to_jsonb(%I)', column_entry.value ->> 'token')
      end
    ),
    ', ' order by column_entry.key collate "C"
  )
  into value_expression
  from pg_catalog.jsonb_each(columns_value) as column_entry(key, value);

  if value_expression is not null then
    execute pg_catalog.format(
      'select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%s)) from record_data.%I where record_id = %L',
      value_expression,
      catalogue_row.physical_table_token,
      due_row.record_id
    ) into existing_field_values;
  else
    existing_field_values := '{}'::jsonb;
  end if;

  -- 7. Compute stable effect identity and effect ID
  effect_identity := pg_catalog.format(
    'deadline:%s:%s:%s',
    due_row.record_id,
    due_row.deadline_calculation_field_id,
    to_char(due_row.transition_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
  effect_id := pg_catalog.md5(effect_identity)::uuid;

  -- 8. Consume/apply recalculated transition if provided
  if p_recalculated_transition is not null then
    if pg_catalog.jsonb_typeof(p_recalculated_transition) = 'null' then
      delete from vortex_record.record_deadline_due_metadata as metadata
      where metadata.organization_id = due_row.organization_id
        and metadata.storage_contract_id = due_row.storage_contract_id
        and metadata.record_id = due_row.record_id
        and metadata.application_root_id is not distinct from due_row.application_root_id;
    else
      if pg_catalog.jsonb_typeof(p_recalculated_transition) <> 'object'
        or p_recalculated_transition - array['calculationFieldId', 'transitionAt'] <> '{}'::jsonb
        or not (p_recalculated_transition ?& array['calculationFieldId', 'transitionAt'])
        or pg_catalog.jsonb_typeof(p_recalculated_transition -> 'calculationFieldId') <> 'string'
        or pg_catalog.jsonb_typeof(p_recalculated_transition -> 'transitionAt') <> 'string'
        or not pg_catalog.pg_input_is_valid(
          p_recalculated_transition ->> 'calculationFieldId', 'uuid'
        )
        or (p_recalculated_transition ->> 'calculationFieldId')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
        or not (p_recalculated_transition ->> 'transitionAt') ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
        or not pg_catalog.pg_input_is_valid(
          p_recalculated_transition ->> 'transitionAt', 'timestamp with time zone'
        ) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
      transition_field_id := (p_recalculated_transition ->> 'calculationFieldId')::uuid;
      transition_at_value := (p_recalculated_transition ->> 'transitionAt')::timestamptz;

      update vortex_record.record_deadline_due_metadata as metadata
      set deadline_calculation_field_id = transition_field_id,
          transition_at = transition_at_value,
          changed_at = pg_catalog.statement_timestamp()
      where metadata.organization_id = due_row.organization_id
        and metadata.storage_contract_id = due_row.storage_contract_id
        and metadata.record_id = due_row.record_id
        and metadata.application_root_id is not distinct from due_row.application_root_id;
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'claimed',
    'root', pg_catalog.jsonb_build_object(
      'organizationId', due_row.organization_id,
      'applicationRootId', due_row.application_root_id,
      'storageContractId', due_row.storage_contract_id,
      'storageScope', due_row.storage_scope,
      'recordId', due_row.record_id,
      'recordTypeId', due_row.record_type_id,
      'concurrencyNumber', due_row.record_concurrency_number
    ),
    'attribution', pg_catalog.jsonb_build_object(
      'bindingId', actor_resolution -> 'bindingId',
      'actorId', actor_resolution -> 'actorId',
      'generation', actor_resolution -> 'generation',
      'operation', 'refresh_record_deadline',
      'systemActorId', actor_resolution -> 'actorId'
    ),
    'effect', pg_catalog.jsonb_build_object(
      'effectId', effect_id,
      'effectIdentity', effect_identity,
      'calculationFieldId', due_row.deadline_calculation_field_id,
      'transitionAt', due_row.transition_at
    ),
    'recordType', catalogue_row.record_type_definition,
    'existingValues', coalesce(existing_field_values, '{}'::jsonb),
    'timeZone', coalesce(org_time_zone, 'UTC')
  );
end
$function$;

alter function vortex_record.claim_record_deadline_refresh(uuid, uuid, uuid, timestamptz, jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.claim_record_deadline_refresh(uuid, uuid, uuid, timestamptz, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.claim_record_deadline_refresh(uuid, uuid, uuid, timestamptz, jsonb)
  to vortex_runtime;

-- Exact consumer entry that consumes an organisation/record due row.
create function vortex_record.consume_record_deadline_due_row(
  p_organization_id uuid default null,
  p_record_id uuid default null,
  p_application_root_id uuid default null,
  p_due_before timestamptz default null,
  p_recalculated_transition jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  return vortex_record.claim_record_deadline_refresh(
    p_organization_id, p_record_id, p_application_root_id, p_due_before, p_recalculated_transition
  );
end
$function$;

alter function vortex_record.consume_record_deadline_due_row(uuid, uuid, uuid, timestamptz, jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.consume_record_deadline_due_row(uuid, uuid, uuid, timestamptz, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.consume_record_deadline_due_row(uuid, uuid, uuid, timestamptz, jsonb)
  to vortex_runtime;

comment on function vortex_record.resolve_configured_deadline_actor_internal(uuid, uuid) is
  'Private owner-only check resolving only the active live deadline actor for the exact organisation/application scope.';
comment on function vortex_record.establish_deadline_system_context_internal(uuid, uuid, uuid) is
  'Private helper establishing or verifying system context and time zone for deadline recalculation.';
comment on function vortex_record.claim_record_deadline_refresh(uuid, uuid, uuid, timestamptz, jsonb) is
  'Private adapter-owned atomic claim, recheck, live actor resolution and deadline metadata return for retry-safe orchestration.';
comment on function vortex_record.consume_record_deadline_due_row(uuid, uuid, uuid, timestamptz, jsonb) is
  'Private adapter-owned entry that consumes an organisation/record due row and attributes the configured system actor.';

reset role;

commit;
