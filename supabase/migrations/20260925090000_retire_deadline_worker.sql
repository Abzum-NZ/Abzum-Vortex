-- #1067: retire the deadline refresh worker, actor registry and due metadata.
--
-- Deadlines are worked out when a record is read (#994, #995), so nothing
-- maintains a stored "next due" row any more. This migration removes the whole
-- subsystem in one transaction:
--
--   * the due-metadata and closure-ledger tables, and the private actor
--     registry and its provisioning, rotation and revocation functions;
--   * the claim, closure and refresh authority (including the System context
--     bridges), the installation and time-zone reselection triggers, and the
--     next-due reader;
--   * the ordinary-save, named-action and lifecycle writers' due-metadata
--     upkeep.
--
-- The shared relationship-total catalogue and snapshot, the common Event
-- writer and the protected delete/restore writers keep one implementation;
-- each is re-installed here with its complete body minus the deadline
-- alternative. The base ordinary-save and named-action writers become the only
-- runtime entry points again, so the runtime grants move back onto them.
--
-- Nothing on the read path depends on the removed metadata: deadline-passed
-- values are evaluated at read time.

begin;

reset role;
set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
grant create on schema vortex_record to postgres;
reset role;

-- Every object below is dropped by its owner: postgres holds the Record and
-- Module owner roles with SET but without INHERIT, so it cannot drop what they
-- own directly.
--
-- 1. The installation and organisation-settings triggers go first, so the
--    functions they call can be dropped without CASCADE. Each is dropped by
--    its table's owner.
set local role vortex_module_owner;
drop trigger if exists installation_bindings_maintain_deadline_due_metadata
  on vortex_module.installation_bindings;
reset role;
drop trigger if exists organization_runtime_settings_reselect_deadline_due_metadata
  on vortex_identity.organization_runtime_settings;

-- 2. The deadline tables. Dropping the actor registry also drops the triggers
--    that call its protection and integrity functions. The actor bindings and
--    actors reference each other, so both are dropped in one statement.
set local role vortex_record_adapter;
drop table if exists vortex_record.deadline_transition_effects;
drop table if exists vortex_record.record_deadline_due_metadata;
reset role;
set local role vortex_record_owner;
drop table if exists vortex_record.deadline_actors, vortex_record.deadline_actor_bindings;

-- 3. Every deadline-only function, grouped by owner.
drop function if exists vortex_record.validate_deadline_actor_binding_scope_internal();
drop function if exists vortex_record.protect_deadline_actor_binding_internal();
drop function if exists vortex_record.protect_deadline_actor_internal();
drop function if exists vortex_record.check_deadline_actor_binding_integrity_internal();
drop function if exists vortex_record.create_deadline_actor_binding_internal(uuid, uuid);
drop function if exists vortex_record.rotate_deadline_actor_binding_internal(uuid, bigint);
drop function if exists vortex_record.revoke_deadline_actor_binding_internal(uuid, bigint);
drop function if exists vortex_record.resolve_configured_deadline_actor_internal(uuid, uuid);
reset role;

drop function if exists vortex_record.establish_deadline_system_context_internal(uuid, uuid);
drop function if exists vortex_record.claim_configured_deadline_due_row_internal(uuid, uuid, uuid, timestamptz);
drop function if exists vortex_record.read_deadline_active_installation_internal();
drop function if exists vortex_record.read_deadline_organization_currency_internal();
drop function if exists vortex_record.append_deadline_closure_activity_internal(uuid, uuid, uuid[]);
drop function if exists vortex_record.maintain_installation_deadline_due_metadata_internal();
drop function if exists vortex_record.reselect_organization_deadline_due_metadata_internal();
drop function if exists vortex_record.next_deadline_refresh_due_at();

set local role vortex_record_adapter;
drop function if exists vortex_record.claim_record_deadline_refresh(uuid, uuid, uuid, timestamptz);
drop function if exists vortex_record.validated_deadline_system_context_internal();
drop function if exists vortex_record.deadline_due_transition_is_valid_internal(jsonb);
drop function if exists vortex_record.write_deadline_closure_due_metadata_internal(uuid, uuid, jsonb, bigint, jsonb);
drop function if exists vortex_record.apply_deadline_closure_record_internal(jsonb, jsonb, uuid, uuid, jsonb);
drop function if exists vortex_record.prepare_record_deadline_closure(uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, timestamptz);
drop function if exists vortex_record.finalize_record_deadline_refresh(uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, timestamptz, jsonb, jsonb, jsonb, uuid, uuid);
drop function if exists vortex_record.deadline_due_record_internal(uuid, uuid, uuid, uuid, uuid);
drop function if exists vortex_record.parent_deadline_due_transitions_are_valid_internal(jsonb, jsonb);
drop function if exists vortex_record.write_parent_deadline_due_metadata_internal(uuid, uuid, jsonb);
drop function if exists vortex_record.creation_deadline_due_transitions_are_valid_internal(jsonb, jsonb);
drop function if exists vortex_record.write_created_deadline_due_metadata_internal(uuid, uuid, jsonb, jsonb, jsonb);
drop function if exists vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, jsonb, jsonb, jsonb);
drop function if exists vortex_record.save_named_action_effects_with_relationship_totals_and_deadline_due_metadata(uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, bigint, uuid, jsonb, jsonb, jsonb, jsonb);

-- 4. Re-install the shared primitives without the deadline System-context
--    alternative, as their owner. Granting CREATE to the adapter for the
--    duration of this transaction is the same pattern every earlier
--    record-function migration uses.

create or replace function vortex_record.relationship_total_catalogue_internal()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  installation jsonb;
  binding jsonb;
  content jsonb;
  record_types jsonb := '[]'::jsonb;
  relationships jsonb := '[]'::jsonb;
  has_installed_rules boolean := false;
  record_type jsonb;
begin
  installation := vortex_module.read_current_active_installation();
  for binding in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') item(value)
    order by item.value ->> 'moduleRootId'
  loop
    select release.compilation_output #> '{canonical,content}' into strict content
    from vortex_definition.releases release
    where release.root_id = (binding ->> 'moduleRootId')::uuid
      and release.release_revision = (binding ->> 'moduleReleaseRevision')::bigint;
    if pg_catalog.jsonb_typeof(content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000', message = 'Installed Record definitions are unavailable';
    end if;
    has_installed_rules := has_installed_rules or
      pg_catalog.jsonb_array_length(coalesce(content -> 'rules', '[]'::jsonb)) > 0;
    record_types := record_types || coalesce((
      select pg_catalog.jsonb_agg(
        item.value || pg_catalog.jsonb_build_object(
          'moduleReleaseRevision', binding -> 'moduleReleaseRevision'
        )
        order by item.value ->> 'recordTypeId'
      )
      from pg_catalog.jsonb_array_elements(content -> 'recordTypes') item(value)
    ), '[]'::jsonb);
    for record_type in
      select item.value from pg_catalog.jsonb_array_elements(content -> 'recordTypes') item(value)
    loop
      relationships := relationships || coalesce(record_type -> 'relationships', '[]'::jsonb);
    end loop;
  end loop;
  select release.compilation_output #> '{canonical,content}' into strict content
  from vortex_definition.releases release
  where release.root_id = (installation ->> 'applicationRootId')::uuid
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;
  has_installed_rules := has_installed_rules or
    pg_catalog.jsonb_array_length(coalesce(content -> 'rules', '[]'::jsonb)) > 0;
  return pg_catalog.jsonb_build_object(
    'recordTypes', record_types,
    'relationships', relationships,
    'hasInstalledRules', has_installed_rules
  );
end
$function$;

revoke all on function vortex_record.relationship_total_catalogue_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.relationship_total_catalogue_internal()
  to vortex_record_adapter;
comment on function vortex_record.relationship_total_catalogue_internal() is
  'Private relationship-total catalogue for the validated human Application request context.';

create or replace function vortex_record.relationship_total_record_snapshot_internal(
  p_catalogue jsonb,
  p_record_type_id uuid,
  p_record_id uuid,
  p_lock boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  columns_value jsonb;
  value_expression text;
  load_sql text;
  result_value jsonb;
begin
  if p_record_type_id is null or p_record_id is null or p_lock is null
    or pg_catalog.jsonb_typeof(p_catalogue -> 'recordTypes') <> 'array' then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  select item.value into record_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if record_type is null then return null; end if;

  select stored.* into catalogue_row
  from vortex_record.storage_catalogue stored
  where stored.storage_contract_id = (record_type ->> 'storageContractId')::uuid
    and stored.record_type_id = p_record_type_id
    and stored.state = 'active';
  if not found then return null; end if;

  select pg_catalog.jsonb_object_agg(
    pg_catalog.lower(field.value ->> 'fieldId'),
    pg_catalog.jsonb_build_object(
      'token', mapping.physical_column_token,
      'databaseValueType', mapping.database_value_type,
      'type', field.value ->> 'type'
    )
  ) into columns_value
  from pg_catalog.jsonb_array_elements(record_type -> 'fields') field(value)
  join vortex_record.field_storage_mappings mapping
    on mapping.storage_contract_id = (record_type ->> 'storageContractId')::uuid
   and mapping.field_id = (field.value ->> 'fieldId')::uuid
   and mapping.state = 'active';
  if (select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(coalesce(columns_value, '{}'::jsonb))) <>
      pg_catalog.jsonb_array_length(record_type -> 'fields') then
    return null;
  end if;

  select pg_catalog.string_agg(
    field_chunk.pairs_text,
    ') || pg_catalog.jsonb_build_object(' order by field_chunk.chunk_index
  )
  into value_expression
  from (
    select (ordered_fields.field_number - 1) / 50 as chunk_index,
      pg_catalog.string_agg(
        pg_catalog.format(
          '%L, %s', ordered_fields.key,
          case ordered_fields.value ->> 'databaseValueType'
            when 'decimal' then pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', ordered_fields.value ->> 'token')
            when 'timestamp_with_time_zone' then pg_catalog.format(
              'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', stored.%I), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))',
              ordered_fields.value ->> 'token'
            )
            when 'date' then pg_catalog.format(
              'pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
              ordered_fields.value ->> 'token'
            )
            else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', ordered_fields.value ->> 'token')
          end
        ), ', ' order by ordered_fields.key collate "C"
      ) as pairs_text
    from (
      select entry.key, entry.value,
        pg_catalog.row_number() over (
          order by entry.key collate "C"
        ) as field_number
      from pg_catalog.jsonb_each(columns_value) entry(key, value)
    ) as ordered_fields
    group by (ordered_fields.field_number - 1) / 50
  ) as field_chunk;

  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_build_object(
       ''recordType'', $3 - ''moduleReleaseRevision'',
       ''recordTypeId'', %L::uuid,
       ''storageContractId'', %L::uuid,
       ''recordId'', stored.record_id,
       ''concurrencyNumber'', stored.concurrency_number,
       ''definitionRevision'', %L::bigint,
       ''existingValues'', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%s))
     )
     from record_data.%I stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.lifecycle_state = ''active''
       and stored.application_root_id is not distinct from %s%s',
    p_record_type_id,
    (record_type ->> 'storageContractId')::uuid,
    (record_type ->> 'moduleReleaseRevision')::bigint,
    value_expression,
    catalogue_row.physical_table_token,
    case when record_type ->> 'storageScope' = 'application_contained'
      then '$4::uuid' else 'null::uuid' end,
    case when p_lock then ' for update' else '' end
  );
  execute load_sql into result_value using
    (context_value ->> 'organizationId')::uuid,
    p_record_id,
    record_type,
    (context_value ->> 'applicationRootId')::uuid;
  return result_value;
end
$function$;

revoke all on function vortex_record.relationship_total_record_snapshot_internal(
  jsonb, uuid, uuid, boolean
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.relationship_total_record_snapshot_internal(
  jsonb, uuid, uuid, boolean
)
  to vortex_record_adapter;
comment on function vortex_record.relationship_total_record_snapshot_internal(
  jsonb, uuid, uuid, boolean
) is
  'Private locked-or-read snapshot of one record for the validated human Application request context.';

-- The generated-values step and both protected lifecycle writers lose their
-- due-transition argument, so their old signatures are dropped explicitly
-- before the new complete bodies are installed.
drop function if exists vortex_record.apply_record_lifecycle_generated_values_internal(
  jsonb, boolean, jsonb, jsonb
);
drop function if exists vortex_record.finalize_protected_record_delete(
  uuid, uuid, uuid, bigint, jsonb, jsonb
);
drop function if exists vortex_record.finalize_protected_record_restore(
  uuid, uuid, uuid, bigint, jsonb, jsonb
);

create or replace function vortex_record.apply_record_lifecycle_generated_values_internal(
  p_preparation jsonb,
  p_include_root boolean,
  p_mutations jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  expected_mutations jsonb;
  supplied_mutations jsonb;
  mutation_value jsonb;
  prepared_record jsonb;
  reduced_final_values jsonb;
  final_revision bigint;
  revisions jsonb := '[]'::jsonb;
begin
  if pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
    or p_include_root is null then
    raise exception using errcode = '22023',
      message = 'Record lifecycle generated values are invalid';
  end if;
  perform vortex_access.validated_human_request_context();

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'recordTypeId', item.value -> 'recordTypeId',
      'recordId', item.value -> 'recordId',
      'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
      'finalFieldIds', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.lower(field.value ->> 'fieldId')
          order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
        )
        from pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') as field(value)
        where field.value ->> 'type' in ('total', 'calculation')
      ), '[]'::jsonb)
    ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
  ), '[]'::jsonb) into expected_mutations
  from pg_catalog.jsonb_array_elements(p_preparation -> 'records') as item(value)
  where p_include_root or item.value ->> 'recordKey' <> 'root';

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'recordTypeId', item.value -> 'recordTypeId',
      'recordId', item.value -> 'recordId',
      'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
      'finalFieldIds', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.lower(field_id) order by pg_catalog.lower(field_id) collate "C")
        from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') as field(field_id)
      ), '[]'::jsonb)
    ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
  ), '[]'::jsonb) into supplied_mutations
  from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and item.value ?& array['recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues']
    and item.value - array['recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues']
      = '{}'::jsonb
    and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';

  if supplied_mutations is distinct from expected_mutations
    or pg_catalog.jsonb_array_length(supplied_mutations)
      <> pg_catalog.jsonb_array_length(p_mutations) then
    raise exception using errcode = '22023',
      message = 'Record lifecycle generated values do not match the locked closure';
  end if;

  for mutation_value in
    select item.value
    from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    select item.value into strict prepared_record
    from pg_catalog.jsonb_array_elements(p_preparation -> 'records') as item(value)
    where item.value ->> 'recordTypeId' = mutation_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = mutation_value ->> 'recordId'
      and (p_include_root or item.value ->> 'recordKey' <> 'root');
    select coalesce(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into reduced_final_values
    from pg_catalog.jsonb_each(mutation_value -> 'finalValues') as entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_record -> 'existingValues' -> pg_catalog.lower(entry.key), 'null'::jsonb
    );
    perform vortex_record.apply_relationship_total_parent_internal(
      (mutation_value ->> 'recordTypeId')::uuid,
      (mutation_value ->> 'recordId')::uuid,
      (mutation_value ->> 'expectedConcurrencyNumber')::bigint,
      reduced_final_values
    );
    final_revision := (mutation_value ->> 'expectedConcurrencyNumber')::bigint
      + case when reduced_final_values = '{}'::jsonb then 0 else 1 end;
    revisions := revisions || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordKey', prepared_record ->> 'recordKey',
      'concurrencyNumber', final_revision
    ));
  end loop;
  return revisions;
end
$function$;

revoke all on function vortex_record.apply_record_lifecycle_generated_values_internal(
  jsonb, boolean, jsonb
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
comment on function vortex_record.apply_record_lifecycle_generated_values_internal(
  jsonb, boolean, jsonb
) is
  'Private lifecycle writer step: applies each locked closure record''s generated values at the revision the shared parent writer reached.';

create or replace function vortex_record.finalize_protected_record_delete(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_parent_mutations jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.record_lifecycle_command_receipts%rowtype;
  preparation jsonb;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  event_kind text;
  event_result jsonb;
  subject_ids uuid[];
begin
  context_value := vortex_access.validated_human_request_context();
  select stored.* into receipt
  from vortex_record.record_lifecycle_command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = p_command_id
  for update;
  if not found
    or receipt.state is distinct from 'pending'
    or receipt.operation is distinct from 'delete'
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.record_id is distinct from p_record_id
    or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
    raise exception using errcode = '55000',
      message = 'Protected record delete is not prepared';
  end if;

  -- Closure identity and revisions are re-derived under the held locks rather
  -- than taken from the caller.
  preparation := vortex_record.prepare_record_lifecycle_totals_internal(
    'delete', p_record_type_id, p_record_id, p_command_id, null
  );
  if preparation ->> 'outcome' is distinct from 'prepared' then
    raise exception using errcode = '40001',
      message = 'Protected record delete closure changed';
  end if;
  perform vortex_record.apply_record_lifecycle_generated_values_internal(
    preparation, false, p_parent_mutations
  );

  for effect_row in
    select effect.*
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
    order by effect.effect_sequence
  loop
    if effect_row.effect_kind = 'soft_deleted' then
      event_kind := 'deleted';
    else
      event_kind := 'unlinked';
    end if;
    event_result := vortex_event.append_record_occurrences(
      effect_row.storage_contract_id, effect_row.record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', case
          when event_kind = 'deleted' and effect_row.record_id = p_record_id
            and effect_row.record_type_id = p_record_type_id
            then receipt.occurrence_id
          else pg_catalog.gen_random_uuid() end,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', event_kind,
          'recordTypeId', effect_row.record_type_id
        ),
        'payload', pg_catalog.jsonb_build_object('kind', event_kind)
      ))
    );
    if pg_catalog.jsonb_array_length(event_result) <> 1 then
      raise exception using errcode = '55000',
        message = 'Protected record delete Event append failed';
    end if;
  end loop;

  select pg_catalog.array_agg(distinct effect.record_id order by effect.record_id)
    into subject_ids
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = receipt.organization_id
    and effect.application_root_id = receipt.application_root_id
    and effect.actor_organization_account_id = receipt.actor_organization_account_id
    and effect.command_id = receipt.command_id;
  if subject_ids is null or not (p_record_id = any (subject_ids)) then
    raise exception using errcode = '55000',
      message = 'Protected record delete effects are unavailable';
  end if;
  perform vortex_record.append_record_lifecycle_activity_internal(
    receipt.activity_id, 'delete', subject_ids
  );

  update vortex_record.record_lifecycle_command_receipts as stored
  set state = 'completed',
    completed_concurrency_number = p_expected_concurrency_number + 1,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = receipt.organization_id
    and stored.application_root_id = receipt.application_root_id
    and stored.actor_organization_account_id = receipt.actor_organization_account_id
    and stored.command_id = receipt.command_id
    and stored.state = 'pending';
  if not found then
    raise exception using errcode = '40001',
      message = 'Protected record delete receipt is stale';
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'deleted',
    'recordId', p_record_id,
    'concurrencyNumber', p_expected_concurrency_number + 1,
    'correlationId', context_value -> 'correlationId',
    'replayed', false
  );
end
$function$;

revoke all on function vortex_record.finalize_protected_record_delete(
  uuid, uuid, uuid, bigint, jsonb
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.finalize_protected_record_delete(
  uuid, uuid, uuid, bigint, jsonb
)
  to vortex_runtime;
comment on function vortex_record.finalize_protected_record_delete(
  uuid, uuid, uuid, bigint, jsonb
) is
  'Protected delete writer: generated parent values, standard Events, Activity and receipt in the preflight transaction.';

create or replace function vortex_record.finalize_protected_record_restore(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.record_lifecycle_command_receipts%rowtype;
  preparation jsonb;
  revisions jsonb;
  restored_revision bigint;
begin
  context_value := vortex_access.validated_human_request_context();
  select stored.* into receipt
  from vortex_record.record_lifecycle_command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = p_command_id
  for update;
  if not found
    or receipt.state is distinct from 'pending'
    or receipt.operation is distinct from 'restore'
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.record_id is distinct from p_record_id
    or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
    raise exception using errcode = '55000',
      message = 'Protected record restore is not prepared';
  end if;

  preparation := vortex_record.prepare_record_lifecycle_totals_internal(
    'restore', p_record_type_id, p_record_id, p_command_id, null
  );
  if preparation ->> 'outcome' is distinct from 'prepared'
    or (
      select (item.value ->> 'concurrencyNumber')::bigint
      from pg_catalog.jsonb_array_elements(preparation -> 'records') as item(value)
      where item.value ->> 'recordKey' = 'root'
    ) is distinct from p_expected_concurrency_number + 1 then
    raise exception using errcode = '40001',
      message = 'Protected record restore closure changed';
  end if;
  revisions := vortex_record.apply_record_lifecycle_generated_values_internal(
    preparation, true, p_mutations
  );
  select (item.value ->> 'concurrencyNumber')::bigint into strict restored_revision
  from pg_catalog.jsonb_array_elements(revisions) as item(value)
  where item.value ->> 'recordKey' = 'root';

  perform vortex_record.append_record_lifecycle_activity_internal(
    receipt.activity_id, 'restore', array[p_record_id]::uuid[]
  );

  update vortex_record.record_lifecycle_command_receipts as stored
  set state = 'completed',
    completed_concurrency_number = restored_revision,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = receipt.organization_id
    and stored.application_root_id = receipt.application_root_id
    and stored.actor_organization_account_id = receipt.actor_organization_account_id
    and stored.command_id = receipt.command_id
    and stored.state = 'pending';
  if not found then
    raise exception using errcode = '40001',
      message = 'Protected record restore receipt is stale';
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'restored',
    'recordId', p_record_id,
    'concurrencyNumber', restored_revision,
    'correlationId', context_value -> 'correlationId',
    'replayed', false
  );
end
$function$;

revoke all on function vortex_record.finalize_protected_record_restore(
  uuid, uuid, uuid, bigint, jsonb
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.finalize_protected_record_restore(
  uuid, uuid, uuid, bigint, jsonb
)
  to vortex_runtime;
comment on function vortex_record.finalize_protected_record_restore(
  uuid, uuid, uuid, bigint, jsonb
) is
  'Protected restore writer: refreshed generated values of the record and its parents, Activity and receipt in the preflight transaction.';

reset role;

-- The common Event writer is postgres-owned; it keeps its owner, ACLs and
-- comment, and only loses its System branch.
set local role postgres;

create or replace function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_occurrences jsonb,
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  maximum_safe_revision constant bigint := 9007199254740991;
  context_value jsonb;
  installation jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  context_actor_id uuid;
  context_correlation_id uuid;
  application_release_revision bigint;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  binding_value jsonb;
  binding_count integer;
  binding_module_root_id uuid;
  binding_module_release_revision bigint;
  binding_revision bigint;
  module_release vortex_definition.releases%rowtype;
  application_release vortex_definition.releases%rowtype;
  module_content jsonb;
  application_content jsonb;
  record_type jsonb;
  record_type_count integer;
  locked_definition_revision bigint;
  locked_record_count integer;
  sequence_application_scope_id uuid;
  next_sequence bigint;
  occurrence_time timestamptz := pg_catalog.statement_timestamp();
  occurrence_time_text text;
  occurrence_item jsonb;
  occurrence_id uuid;
  descriptor jsonb;
  payload jsonb;
  event_kind text;
  owner_kind text;
  owner_root_id uuid;
  declared_event jsonb;
  declared_event_count integer;
  definition_release jsonb;
  field_item jsonb;
  field_id_text text;
  previous_field_id_text text;
  field_definition jsonb;
  queued_message_id bigint;
  envelope jsonb;
  envelopes jsonb := '[]'::jsonb;
begin
  if p_storage_contract_id is null or p_storage_contract_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or pg_catalog.jsonb_typeof(p_occurrences) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Event append input is invalid';
  end if;

  if pg_catalog.jsonb_array_length(p_occurrences) = 0 then
    return envelopes;
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_occurrences) as candidate(value)
    where pg_catalog.jsonb_typeof(candidate.value) is distinct from 'object'
      or not candidate.value ?& array['occurrenceId', 'descriptor', 'payload']
      or candidate.value - array['occurrenceId', 'descriptor', 'payload'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(candidate.value -> 'occurrenceId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate.value -> 'descriptor') is distinct from 'object'
      or pg_catalog.jsonb_typeof(candidate.value -> 'payload') is distinct from 'object'
  ) then
    raise exception using errcode = '22023', message = 'Event occurrence batch is invalid';
  end if;

  begin
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_occurrences) as candidate(value)
      where (candidate.value ->> 'occurrenceId')::uuid = nil_uuid
    ) or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_array_elements(p_occurrences)
    ) <> (
      select pg_catalog.count(distinct (candidate.value ->> 'occurrenceId')::uuid)
      from pg_catalog.jsonb_array_elements(p_occurrences) as candidate(value)
    ) then
      raise exception using errcode = '22023', message = 'Event occurrence identities are invalid';
    end if;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Event occurrence identities are invalid';
  end;

  context_value := vortex_access.validated_human_request_context();
  if context_value ->> 'callerKind' is distinct from 'human'
    or not context_value ?& array[
      'organizationId', 'applicationRootId', 'organizationAccountId', 'correlationId'
    ] then
    raise exception using errcode = '42501', message = 'Human Application context is required';
  end if;
  context_actor_id := (context_value ->> 'organizationAccountId')::uuid;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id;
  if not found
    or catalogue_row.state is distinct from 'active'
    or catalogue_row.physical_schema_token is distinct from 'record_data' then
    raise exception using errcode = 'P0002', message = 'Event record is unavailable';
  end if;

  -- Coordinate with the approved installation lifecycle writer before trusting
  -- the exact Module binding. The actual generated row is locked below and is
  -- the ordering lock shared by every consuming Application.
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'vortex_module.binding:' || context_organization_id::text || ':' ||
        context_application_root_id::text || ':' || catalogue_row.module_root_id::text,
      0
    )
  );
  -- Installation evidence is resolved here, inside the protected region, and
  -- never before it.  A lifecycle detach that commits while this append waits
  -- for the canonical binding lock above is only observed by a read taken
  -- after that wait: this assignment is its own statement, so in read
  -- committed it sees the committed lifecycle state.  `p_installation` carries
  -- an exact pin-set only from a trusted reader that already resolved it while
  -- holding the same canonical lifecycle lock.
  if p_installation is null then
    installation := vortex_module.read_current_active_installation();
  else
    installation := p_installation;
  end if;
  if installation is null
    or pg_catalog.jsonb_typeof(installation) <> 'object'
    or not installation ?& array[
      'organizationId', 'applicationRootId', 'applicationReleaseRevision',
      'moduleBindings'
    ]
    or (installation ->> 'organizationId')::uuid is distinct from context_organization_id
    or (installation ->> 'applicationRootId')::uuid is distinct from context_application_root_id
    or pg_catalog.jsonb_typeof(installation -> 'moduleBindings') <> 'array' then
    raise exception using errcode = '42501', message = 'Resolved Event installation is unavailable';
  end if;
  application_release_revision :=
    (installation ->> 'applicationReleaseRevision')::bigint;
  -- Module's existing reader has already proved the complete binding set
  -- against the published dependency closure. Read the one exact binding from
  -- that result while its canonical lifecycle lock is held; do not add a
  -- second binding reader or broader cross-owner table grants.
  select pg_catalog.count(*), pg_catalog.jsonb_agg(item.value) -> 0
  into binding_count, binding_value
  from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  where (item.value ->> 'moduleRootId')::uuid = catalogue_row.module_root_id;
  if binding_count <> 1 then
    raise exception using errcode = '55000', message = 'Installed Event binding is unavailable';
  end if;
  binding_module_root_id := (binding_value ->> 'moduleRootId')::uuid;
  binding_module_release_revision :=
    (binding_value ->> 'moduleReleaseRevision')::bigint;
  binding_revision := (binding_value ->> 'bindingRevision')::bigint;

  select release.* into module_release
  from vortex_definition.releases as release
  where release.root_id = binding_module_root_id
    and release.release_revision = binding_module_release_revision;
  if not found
    or not exists (
      select 1 from vortex_record.release_provisions as provision
      where provision.module_root_id = module_release.root_id
        and provision.release_revision = module_release.release_revision
        and p_storage_contract_id = any (provision.storage_contract_ids)
    ) then
    raise exception using errcode = '55000', message = 'Installed Event storage is unavailable';
  end if;
  module_content := module_release.compilation_output #> '{canonical,content}';

  select pg_catalog.count(*), pg_catalog.jsonb_agg(item.value) -> 0
  into record_type_count, record_type
  from pg_catalog.jsonb_array_elements(module_content -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = catalogue_row.record_type_id;
  if record_type_count <> 1
    or (record_type ->> 'storageContractId')::uuid is distinct from p_storage_contract_id
    or record_type ->> 'storageScope' is distinct from catalogue_row.storage_scope then
    raise exception using errcode = '55000', message = 'Installed Event record type is unavailable';
  end if;

  select release.* into application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = context_application_root_id
    and release.release_revision = application_release_revision
    and root.organization_id = context_organization_id
    and root.kind = 'application';
  if not found then
    raise exception using errcode = '55000', message = 'Installed Application release is unavailable';
  end if;
  application_content := application_release.compilation_output #> '{canonical,content}';

  if catalogue_row.storage_scope = 'organization_shared' then
    sequence_application_scope_id := null;
    locked_definition_revision := null;
    execute pg_catalog.format(
      'select stored.definition_revision
       from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.application_root_id is null
       for update',
      catalogue_row.physical_table_token
    ) into locked_definition_revision
    using context_organization_id, p_record_id;
    get diagnostics locked_record_count = row_count;
  else
    sequence_application_scope_id := context_application_root_id;
    locked_definition_revision := null;
    execute pg_catalog.format(
      'select stored.definition_revision
       from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.application_root_id = $3
       for update',
      catalogue_row.physical_table_token
    ) into locked_definition_revision
    using context_organization_id, p_record_id, context_application_root_id;
    get diagnostics locked_record_count = row_count;
  end if;
  if locked_record_count <> 1 or locked_definition_revision is null
    or locked_definition_revision < catalogue_row.first_compatible_release_revision
    or (catalogue_row.last_compatible_release_revision is not null
      and locked_definition_revision > catalogue_row.last_compatible_release_revision) then
    raise exception using errcode = 'P0002', message = 'Event record is unavailable';
  end if;

  select coalesce(pg_catalog.max(stored.record_sequence), 0) + 1
  into next_sequence
  from vortex_event.event_outbox as stored
  where stored.organization_id = context_organization_id
    and stored.storage_contract_id = p_storage_contract_id
    and stored.sequence_application_root_id is not distinct from
      sequence_application_scope_id
    and stored.record_id = p_record_id;
  if next_sequence + pg_catalog.jsonb_array_length(p_occurrences) - 1 >
      maximum_safe_revision then
    raise exception using errcode = '22003', message = 'Event record sequence is exhausted';
  end if;

  occurrence_time_text := pg_catalog.to_char(
    pg_catalog.timezone('UTC', occurrence_time),
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );

  for occurrence_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_occurrences) with ordinality as item(value, ordinal)
    order by item.ordinal
  loop
    occurrence_id := (occurrence_item ->> 'occurrenceId')::uuid;
    descriptor := occurrence_item -> 'descriptor';
    payload := occurrence_item -> 'payload';

    if descriptor ->> 'kind' = 'standard' then
      if not descriptor ?& array['kind', 'eventKind', 'recordTypeId']
        or descriptor - array['kind', 'eventKind', 'recordTypeId'] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(descriptor -> 'eventKind') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'recordTypeId') is distinct from 'string'
        or (descriptor ->> 'recordTypeId')::uuid is distinct from catalogue_row.record_type_id
        or descriptor ->> 'eventKind' is null
        or descriptor ->> 'eventKind' not in (
          'created', 'changed', 'deleted', 'linked', 'unlinked', 'reassigned',
          'state_changed'
        ) then
        raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
      end if;
      event_kind := descriptor ->> 'eventKind';

      if event_kind = 'changed' then
        if not payload ?& array['kind', 'changedFieldIds']
          or payload - array['kind', 'changedFieldIds'] <> '{}'::jsonb
          or payload ->> 'kind' is distinct from event_kind
          or pg_catalog.jsonb_typeof(payload -> 'changedFieldIds') is distinct from 'array'
          or pg_catalog.jsonb_array_length(payload -> 'changedFieldIds') = 0 then
          raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
        end if;
        previous_field_id_text := null;
        for field_item in
          select item.value
          from pg_catalog.jsonb_array_elements(payload -> 'changedFieldIds')
            with ordinality as item(value, ordinal)
          order by item.ordinal
        loop
          if pg_catalog.jsonb_typeof(field_item) is distinct from 'string' then
            raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
          end if;
          field_id_text := pg_catalog.lower(field_item #>> '{}');
          if previous_field_id_text is not null
              and previous_field_id_text >= field_id_text
            or not exists (
              select 1 from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
              where pg_catalog.lower(field.value ->> 'fieldId') = field_id_text
            ) then
            raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
          end if;
          previous_field_id_text := field_id_text;
        end loop;
      elsif event_kind = 'state_changed' then
        if not payload ?& array['kind', 'fieldId']
          or payload - array['kind', 'fieldId', 'previousValue', 'newValue'] <> '{}'::jsonb
          or payload ->> 'kind' is distinct from event_kind
          or pg_catalog.jsonb_typeof(payload -> 'fieldId') is distinct from 'string' then
          raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
        end if;
        select field.value into field_definition
        from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
        where (field.value ->> 'fieldId')::uuid = (payload ->> 'fieldId')::uuid;
        if not found
          or (field_definition ->> 'personalData' = 'none'
            and not (payload ? 'previousValue' or payload ? 'newValue'))
          or (field_definition ->> 'personalData' <> 'none'
            and (payload ? 'previousValue' or payload ? 'newValue')) then
          raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
        end if;
      elsif payload <> pg_catalog.jsonb_build_object('kind', event_kind) then
        raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
      end if;

      definition_release := pg_catalog.jsonb_build_object(
        'kind', 'module',
        'rootId', module_release.root_id,
        'releaseRevision', module_release.release_revision,
        'releaseVersion', module_release.release_version,
        'contentFingerprint', module_release.content_fingerprint,
        'resolutionFingerprint', module_release.resolution_fingerprint
      );
    elsif descriptor ->> 'kind' = 'declared' then
      if not descriptor ?& array[
          'kind', 'owner', 'declarationId', 'key', 'recordTypeId', 'carriedFieldIds'
        ]
        or descriptor - array[
          'kind', 'owner', 'declarationId', 'key', 'recordTypeId', 'carriedFieldIds'
        ] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(descriptor -> 'owner') is distinct from 'object'
        or pg_catalog.jsonb_typeof(descriptor -> 'declarationId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'key') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'recordTypeId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'carriedFieldIds') is distinct from 'array'
        or (descriptor ->> 'recordTypeId')::uuid is distinct from catalogue_row.record_type_id then
        raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
      end if;

      owner_kind := descriptor #>> '{owner,kind}';
      if owner_kind = 'application'
        and (descriptor -> 'owner') - array['kind', 'applicationRootId'] = '{}'::jsonb
        and (descriptor -> 'owner') ?& array['kind', 'applicationRootId']
        and pg_catalog.jsonb_typeof(
          descriptor #> '{owner,applicationRootId}'
        ) is not distinct from 'string' then
        owner_root_id := (descriptor #>> '{owner,applicationRootId}')::uuid;
        if owner_root_id <> context_application_root_id then
          raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
        end if;
        select pg_catalog.count(*), pg_catalog.jsonb_agg(event.value) -> 0
        into declared_event_count, declared_event
        from pg_catalog.jsonb_array_elements(application_content -> 'events') as event(value)
        where (event.value ->> 'eventId')::uuid = (descriptor ->> 'declarationId')::uuid
          and event.value ->> 'key' = descriptor ->> 'key';
        definition_release := pg_catalog.jsonb_build_object(
          'kind', 'application',
          'rootId', application_release.root_id,
          'releaseRevision', application_release.release_revision,
          'releaseVersion', application_release.release_version,
          'contentFingerprint', application_release.content_fingerprint,
          'resolutionFingerprint', application_release.resolution_fingerprint
        );
      elsif owner_kind = 'module'
        and (descriptor -> 'owner') - array['kind', 'moduleRootId'] = '{}'::jsonb
        and (descriptor -> 'owner') ?& array['kind', 'moduleRootId']
        and pg_catalog.jsonb_typeof(
          descriptor #> '{owner,moduleRootId}'
        ) is not distinct from 'string' then
        owner_root_id := (descriptor #>> '{owner,moduleRootId}')::uuid;
        if owner_root_id <> module_release.root_id then
          raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
        end if;
        select pg_catalog.count(*), pg_catalog.jsonb_agg(event.value) -> 0
        into declared_event_count, declared_event
        from pg_catalog.jsonb_array_elements(module_content -> 'events') as event(value)
        where (event.value ->> 'eventId')::uuid = (descriptor ->> 'declarationId')::uuid
          and event.value ->> 'key' = descriptor ->> 'key';
        definition_release := pg_catalog.jsonb_build_object(
          'kind', 'module',
          'rootId', module_release.root_id,
          'releaseRevision', module_release.release_revision,
          'releaseVersion', module_release.release_version,
          'contentFingerprint', module_release.content_fingerprint,
          'resolutionFingerprint', module_release.resolution_fingerprint
        );
      else
        raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
      end if;

      if declared_event_count <> 1
        or (declared_event ->> 'recordTypeId')::uuid <> catalogue_row.record_type_id
        or declared_event -> 'carriedFieldIds' is distinct from
          descriptor -> 'carriedFieldIds'
        or declared_event -> 'personalOrSensitiveValuesAllowed' is distinct from
          'false'::jsonb
        or not payload ?& array['kind', 'carriedValues']
        or payload - array['kind', 'carriedValues'] <> '{}'::jsonb
        or payload ->> 'kind' is distinct from 'declared'
        or pg_catalog.jsonb_typeof(payload -> 'carriedValues') is distinct from 'object' then
        raise exception using errcode = '22023', message = 'Installed Event declaration is invalid';
      end if;

      if exists (
        select 1
        from pg_catalog.jsonb_each(payload -> 'carriedValues') as carried(field_id, value)
        where not (descriptor -> 'carriedFieldIds') ? carried.field_id
          or not exists (
            select 1
            from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
            where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(carried.field_id)
              and field.value ->> 'personalData' = 'none'
          )
      ) then
        raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
      end if;
    else
      raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
    end if;

    envelope := pg_catalog.jsonb_build_object(
      'contractVersion', '2.0.0',
      'occurrenceId', occurrence_id,
      'organizationId', context_organization_id,
      'installation', pg_catalog.jsonb_build_object(
        'applicationRootId', context_application_root_id,
        'applicationReleaseRevision', application_release_revision,
        'moduleBinding', pg_catalog.jsonb_build_object(
          'moduleRootId', binding_module_root_id,
          'moduleReleaseRevision', binding_module_release_revision,
          'bindingRevision', binding_revision
        )
      ),
      'descriptor', descriptor,
      'definitionRelease', definition_release,
      'recordId', p_record_id,
      'occurredAt', occurrence_time_text,
      'actorId', context_actor_id,
      'correlationId', context_correlation_id,
      'recordSequence', next_sequence,
      'payload', payload
    );

    insert into vortex_event.event_outbox (
      occurrence_id, organization_id, storage_contract_id, storage_scope,
      sequence_application_root_id, record_id, record_sequence, occurred_at,
      envelope
    ) values (
      occurrence_id, context_organization_id, p_storage_contract_id,
      catalogue_row.storage_scope, sequence_application_scope_id, p_record_id,
      next_sequence, occurrence_time, envelope
    );

    select sent.msg_id into strict queued_message_id
    from pgmq.send(
      'vortex_event_occurrences',
      pg_catalog.jsonb_build_object(
        'contractVersion', '2.0.0', 'occurrenceId', occurrence_id
      )
    ) as sent(msg_id);
    if queued_message_id is null then
      raise exception using errcode = '55000', message = 'Event queue append failed';
    end if;

    envelopes := envelopes || pg_catalog.jsonb_build_array(envelope);
    next_sequence := next_sequence + 1;
  end loop;

  return envelopes;
end
$function$;

revoke all on function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
comment on function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
) is
  'Appends an exact validated record occurrence batch; resolves the active installation under the canonical binding lock unless a trusted reader supplies an exact pin-set it resolved under that same lock.';

reset role;

-- 5. The base ordinary-save and named-action writers are the only runtime entry
--    points again. Ownership, comments and ACLs stay as installed; the runtime
--    grant returns to them.
set local role vortex_record_adapter;
grant execute on function vortex_record.save_base_record_with_relationship_totals(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, jsonb
) to vortex_runtime;
grant execute on function vortex_record.save_named_action_effects_with_relationship_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid,
  bigint, uuid, jsonb
) to vortex_runtime;

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
revoke create on schema vortex_record from postgres;
reset role;

commit;
