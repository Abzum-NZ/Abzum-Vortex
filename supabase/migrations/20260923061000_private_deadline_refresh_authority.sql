-- Private deadline refresh authority, claim and attribution.
-- Claims one due row only for the configured execution session, establishes
-- the matching System context once, and returns locked facts for the Record
-- runtime to derive the next transition. Record/effect mutation remains #558.

begin;

set local role vortex_record_owner;

-- Resolve and lock the exact binding and actor. The immutable session-user
-- check is deliberate: SET LOCAL ROLE may select the runtime capability, but
-- cannot turn an ordinary runtime connection into this configured worker.
create function vortex_record.resolve_configured_deadline_actor_internal(
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
  binding_row vortex_record.deadline_actor_bindings%rowtype;
  actor_row vortex_record.deadline_actors%rowtype;
  execution_session_role_oid oid := pg_catalog.to_regrole(session_user)::oid;
begin
  if p_organization_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'actor_configuration_missing'
    );
  end if;

  select binding.* into binding_row
  from vortex_record.deadline_actor_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id is not distinct from p_application_root_id
    and binding.operation = 'refresh_record_deadline'
  for share;

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'actor_configuration_missing'
    );
  end if;
  if binding_row.state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', case binding_row.state
        when 'revoked' then 'actor_configuration_revoked'
        else 'actor_configuration_disabled'
      end,
      'state', binding_row.state
    );
  end if;
  if binding_row.current_actor_id is null
    or binding_row.execution_session_role_oid is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'actor_configuration_mismatched'
    );
  end if;
  if binding_row.execution_session_role_oid <> execution_session_role_oid then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'actor_session_unauthorized'
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
    and actor.revoked_at is null
  for share;

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'actor_configuration_mismatched'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'resolved',
    'bindingId', binding_row.binding_id,
    'actorId', actor_row.actor_id,
    'generation', binding_row.generation,
    'operation', 'refresh_record_deadline',
    'systemActorId', actor_row.actor_id
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

-- PostgreSQL owns this one narrow cross-owner bridge because only the trusted
-- runtime role may initialize context, while the Record adapter must retain its
-- forced-RLS identity. It independently re-resolves the configured actor and
-- refuses context replacement; it never accepts caller-supplied attribution.
create function vortex_record.establish_deadline_system_context_internal(
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
  actor_resolution jsonb;
  org_tenant_id uuid;
  org_access_version bigint;
  org_time_zone text;
  context_value jsonb;
  issued_at_text text;
  expires_at_text text;
begin
  actor_resolution := vortex_record.resolve_configured_deadline_actor_internal(
    p_organization_id, p_application_root_id
  );
  if actor_resolution ->> 'outcome' <> 'resolved' then
    return actor_resolution;
  end if;

  select org.tenant_id, version.current_version, settings.time_zone
  into org_tenant_id, org_access_version, org_time_zone
  from vortex_identity.organizations as org
  join vortex_identity.tenants as tenant on tenant.tenant_id = org.tenant_id
  join vortex_access.organization_access_versions as version
    on version.organization_id = org.organization_id
  join vortex_identity.organization_runtime_settings as settings
    on settings.organization_id = org.organization_id
  where org.organization_id = p_organization_id
    and org.state = 'active'
    and tenant.state = 'active';

  if not found or org_tenant_id is null or org_access_version is null or org_time_zone is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'scope_configuration_unavailable'
    );
  end if;

  issued_at_text := pg_catalog.to_char(
    pg_catalog.timezone('UTC', pg_catalog.statement_timestamp()),
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
  expires_at_text := pg_catalog.to_char(
    pg_catalog.timezone(
      'UTC', pg_catalog.statement_timestamp() + interval '1 hour'
    ),
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
  context_value := pg_catalog.jsonb_build_object(
    'callerKind', 'system',
    'tenantId', org_tenant_id,
    'organizationId', p_organization_id,
    'systemActorId', actor_resolution -> 'actorId',
    'sessionId', pg_catalog.gen_random_uuid(),
    'authenticationStrength', 'service',
    'issuedAt', issued_at_text,
    'expiresAt', expires_at_text,
    'accessVersion', org_access_version,
    'correlationId', pg_catalog.gen_random_uuid()
  ) || case when p_application_root_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('applicationRootId', p_application_root_id) end;

  begin
    perform vortex_context.initialize(context_value);
  exception when object_not_in_prerequisite_state then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'context_already_established'
    );
  end;

  return actor_resolution || pg_catalog.jsonb_build_object('timeZone', org_time_zone);
end
$function$;

alter function vortex_record.establish_deadline_system_context_internal(uuid, uuid)
  owner to postgres;
revoke all on function vortex_record.establish_deadline_system_context_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.establish_deadline_system_context_internal(uuid, uuid)
  to vortex_record_adapter;

-- The due row must be found before its tenant context can be established. Keep
-- that unavoidable cross-scope read in one postgres-owned helper: it binds the
-- session role, locks one exact due row, establishes that row's context, and
-- returns no row data unless all three steps succeed.
create function vortex_record.claim_configured_deadline_due_row_internal(
  p_organization_id uuid,
  p_record_id uuid,
  p_application_root_id uuid,
  p_due_before timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  due_row vortex_record.record_deadline_due_metadata%rowtype;
  actor_resolution jsonb;
begin
  if (p_organization_id is not null and p_organization_id =
        '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_record_id is not null and p_record_id =
        '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_application_root_id is not null and p_application_root_id =
        '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_organization_id is null
        and (p_record_id is not null or p_application_root_id is not null))
    or (p_due_before is not null and not pg_catalog.isfinite(p_due_before)) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  -- A scoped claim reports missing/disabled configuration even when no due row
  -- exists. An unscoped batch claim considers only rows assigned to this exact
  -- login role, so one tenant's configuration cannot starve another tenant.
  if p_organization_id is not null then
    actor_resolution := vortex_record.resolve_configured_deadline_actor_internal(
      p_organization_id, p_application_root_id
    );
    if actor_resolution ->> 'outcome' <> 'resolved' then
      return actor_resolution;
    end if;

    select metadata.* into due_row
    from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = p_organization_id
      and metadata.application_root_id is not distinct from p_application_root_id
      and (p_record_id is null or metadata.record_id = p_record_id)
      and metadata.transition_at <= pg_catalog.coalesce(
        p_due_before, pg_catalog.statement_timestamp()
      )
    order by metadata.transition_at asc, metadata.changed_at asc,
      metadata.storage_contract_id asc, metadata.record_id asc
    limit 1
    for update skip locked;
  else
    select metadata.* into due_row
    from vortex_record.record_deadline_due_metadata as metadata
    join vortex_record.deadline_actor_bindings as binding
      on binding.organization_id = metadata.organization_id
      and binding.application_root_id is not distinct from metadata.application_root_id
      and binding.operation = 'refresh_record_deadline'
      and binding.execution_session_role_oid = pg_catalog.to_regrole(session_user)::oid
    where metadata.transition_at <= pg_catalog.coalesce(
      p_due_before, pg_catalog.statement_timestamp()
    )
    order by metadata.transition_at asc, metadata.changed_at asc,
      metadata.organization_id asc, metadata.storage_contract_id asc,
      metadata.record_id asc
    limit 1
    for update of metadata skip locked;
  end if;

  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'none');
  end if;

  actor_resolution := vortex_record.establish_deadline_system_context_internal(
    due_row.organization_id, due_row.application_root_id
  );
  if actor_resolution ->> 'outcome' <> 'resolved' then
    return actor_resolution;
  end if;

  return actor_resolution || pg_catalog.jsonb_build_object(
    'due', pg_catalog.to_jsonb(due_row)
  );
end
$function$;

alter function vortex_record.claim_configured_deadline_due_row_internal(
  uuid, uuid, uuid, timestamptz
) owner to postgres;
revoke all on function vortex_record.claim_configured_deadline_due_row_internal(
  uuid, uuid, uuid, timestamptz
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.claim_configured_deadline_due_row_internal(
  uuid, uuid, uuid, timestamptz
) to vortex_record_adapter;

set local role vortex_record_adapter;

create function vortex_record.claim_record_deadline_refresh(
  p_organization_id uuid default null,
  p_record_id uuid default null,
  p_application_root_id uuid default null,
  p_due_before timestamptz default null
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
  transition_time_text text;
  effect_identity text;
  effect_hash text;
  effect_id uuid;
  root_value jsonb;
begin
  if (p_organization_id is not null and p_organization_id =
        '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_record_id is not null and p_record_id =
        '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_application_root_id is not null and p_application_root_id =
        '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_organization_id is null
        and (p_record_id is not null or p_application_root_id is not null))
    or (p_due_before is not null and not pg_catalog.isfinite(p_due_before)) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  actor_resolution := vortex_record.claim_configured_deadline_due_row_internal(
    p_organization_id, p_record_id, p_application_root_id, p_due_before
  );
  if actor_resolution ->> 'outcome' <> 'resolved' then
    return actor_resolution;
  end if;
  due_row := pg_catalog.jsonb_populate_record(
    null::vortex_record.record_deadline_due_metadata,
    actor_resolution -> 'due'
  );

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = due_row.storage_contract_id
  for share;
  if not found
    or catalogue_row.state <> 'active'
    or catalogue_row.physical_schema_token <> 'record_data'
    or catalogue_row.record_type_id <> due_row.record_type_id
    or catalogue_row.storage_scope <> due_row.storage_scope then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'storage_contract_unavailable'
    );
  end if;

  -- Ordinary saves lock the record before updating due metadata. NOWAIT keeps
  -- this inverse claim order bounded: the save wins, and this claim retries.
  begin
    if due_row.application_root_id is null then
      execute pg_catalog.format(
        'select stored.storage_contract_id, stored.record_type_id,
           stored.application_root_id, stored.definition_revision,
           stored.concurrency_number, stored.lifecycle_state
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.application_root_id is null
         for update nowait',
        catalogue_row.physical_table_token
      ) into record_row using due_row.organization_id, due_row.record_id;
    else
      execute pg_catalog.format(
        'select stored.storage_contract_id, stored.record_type_id,
           stored.application_root_id, stored.definition_revision,
           stored.concurrency_number, stored.lifecycle_state
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.application_root_id = $3
         for update nowait',
        catalogue_row.physical_table_token
      ) into record_row using due_row.organization_id, due_row.record_id,
        due_row.application_root_id;
    end if;
  exception when lock_not_available then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'record_busy'
    );
  end;

  if not found or record_row.lifecycle_state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'record_unavailable'
    );
  end if;
  if record_row.storage_contract_id <> due_row.storage_contract_id
    or record_row.record_type_id <> due_row.record_type_id
    or record_row.application_root_id is distinct from due_row.application_root_id
    or record_row.definition_revision < catalogue_row.first_compatible_release_revision
    or (catalogue_row.last_compatible_release_revision is not null
        and record_row.definition_revision > catalogue_row.last_compatible_release_revision) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_storage_incompatible'
    );
  end if;
  if record_row.concurrency_number <> due_row.record_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'concurrency_mismatch'
    );
  end if;

  for field_item in
    select item.value
    from pg_catalog.jsonb_array_elements(
      catalogue_row.record_type_definition -> 'fields'
    ) as item(value)
  loop
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = catalogue_row.storage_contract_id
      and mapping.field_id = (field_item ->> 'fieldId')::uuid
    for share;
    if not found or mapping_row.state <> 'active' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_storage_incompatible'
      );
    end if;
    columns_value := columns_value || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), pg_catalog.jsonb_build_object(
        'token', mapping_row.physical_column_token,
        'databaseValueType', mapping_row.database_value_type
      )
    );
  end loop;

  select pg_catalog.string_agg(
    pg_catalog.format(
      '%L, %s', column_entry.key,
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
  ) into value_expression
  from pg_catalog.jsonb_each(columns_value) as column_entry(key, value);

  if value_expression is not null then
    if due_row.application_root_id is null then
      execute pg_catalog.format(
        'select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%s))
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.application_root_id is null',
        value_expression, catalogue_row.physical_table_token
      ) into existing_field_values using due_row.organization_id, due_row.record_id;
    else
      execute pg_catalog.format(
        'select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%s))
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.application_root_id = $3',
        value_expression, catalogue_row.physical_table_token
      ) into existing_field_values using due_row.organization_id, due_row.record_id,
        due_row.application_root_id;
    end if;
  end if;
  if existing_field_values is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'record_unavailable'
    );
  end if;

  transition_time_text := pg_catalog.to_char(
    pg_catalog.timezone('UTC', due_row.transition_at),
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
  effect_identity := pg_catalog.format(
    'deadline:%s:%s:%s:%s:%s:%s:%s',
    due_row.organization_id,
    due_row.storage_contract_id,
    pg_catalog.coalesce(due_row.application_root_id::text, 'organization_shared'),
    due_row.record_id,
    due_row.record_concurrency_number,
    due_row.deadline_calculation_field_id,
    transition_time_text
  );
  effect_hash := pg_catalog.md5(effect_identity);
  effect_id := (
    pg_catalog.substr(effect_hash, 1, 8) || '-' ||
    pg_catalog.substr(effect_hash, 9, 4) || '-5' ||
    pg_catalog.substr(effect_hash, 14, 3) || '-a' ||
    pg_catalog.substr(effect_hash, 18, 3) || '-' ||
    pg_catalog.substr(effect_hash, 21, 12)
  )::uuid;
  root_value := pg_catalog.jsonb_build_object(
    'organizationId', due_row.organization_id,
    'storageContractId', due_row.storage_contract_id,
    'storageScope', due_row.storage_scope,
    'recordId', due_row.record_id,
    'recordTypeId', due_row.record_type_id,
    'concurrencyNumber', due_row.record_concurrency_number
  ) || case when due_row.application_root_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object(
      'applicationRootId', due_row.application_root_id
    ) end;

  return pg_catalog.jsonb_build_object(
    'outcome', 'claimed',
    'root', root_value,
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
      'transitionAt', transition_time_text
    ),
    'recordType', catalogue_row.record_type_definition,
    'existingValues', existing_field_values,
    'timeZone', actor_resolution -> 'timeZone'
  );
end
$function$;

alter function vortex_record.claim_record_deadline_refresh(uuid, uuid, uuid, timestamptz)
  owner to vortex_record_adapter;
revoke all on function vortex_record.claim_record_deadline_refresh(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.claim_record_deadline_refresh(uuid, uuid, uuid, timestamptz)
  to vortex_runtime;

comment on function vortex_record.resolve_configured_deadline_actor_internal(uuid, uuid) is
  'Private adapter helper locking the active actor and binding it to the configured execution session role.';
comment on function vortex_record.establish_deadline_system_context_internal(uuid, uuid) is
  'Private fixed-purpose bridge that revalidates deadline authority and establishes one exact System context.';
comment on function vortex_record.claim_configured_deadline_due_row_internal(
  uuid, uuid, uuid, timestamptz
) is
  'Private fixed-purpose bridge that role-binds and locks one due row before establishing its exact System context.';
comment on function vortex_record.claim_record_deadline_refresh(uuid, uuid, uuid, timestamptz) is
  'Private atomic due-row claim returning locked root, attribution, effect identity and calculation inputs; mutation follows in #558.';

reset role;

commit;
