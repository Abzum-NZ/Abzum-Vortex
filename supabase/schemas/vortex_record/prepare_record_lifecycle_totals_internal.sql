create or replace function vortex_record.prepare_record_lifecycle_totals_internal(
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_command_id uuid,
  p_root_snapshot jsonb,
  p_proposed_records jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  catalogue jsonb;
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  proposals jsonb;
  graph jsonb;
  prepared_records jsonb := '[]'::jsonb;
  rule_module_root_id uuid;
  lifecycle_effect record;
  lifecycle_loaded jsonb;
  lifecycle_type jsonb;
  lifecycle_records jsonb := '[]'::jsonb;
begin
  if p_operation is null or p_operation not in ('delete', 'restore')
    or (p_operation = 'restore' and p_root_snapshot is not null)
    or pg_catalog.jsonb_typeof(p_proposed_records) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Record lifecycle total preparation is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  catalogue := vortex_record.relationship_total_catalogue_internal()
    || pg_catalog.jsonb_build_object('proposedRecords', p_proposed_records);

  before_closure := vortex_record.record_lifecycle_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_command_id
  );
  if before_closure is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'relationship_refused',
      'correlationId', context_value -> 'correlationId'
    );
  end if;

  for record_value in
    select item.value
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value)
    where item.value ? 'recordId'
    order by (item.value ->> 'storageContractId')::uuid,
      (item.value ->> 'recordId')::uuid
  loop
    if vortex_record.relationship_total_record_snapshot_internal(
      catalogue,
      (record_value ->> 'recordTypeId')::uuid,
      (record_value ->> 'recordId')::uuid,
      true
    ) is null then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
  end loop;

  after_closure := vortex_record.record_lifecycle_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_command_id
  );
  if after_closure is null
    or (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value))
      is distinct from
      (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;

  select coalesce(pg_catalog.jsonb_agg(ordered.value order by ordered.position, ordered.record_key), '[]'::jsonb)
  into prepared_records
  from (
    select p_root_snapshot || pg_catalog.jsonb_build_object('recordKey', 'root') as value,
      0 as position, '' as record_key where p_root_snapshot is not null
    union all
    select item.value, case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
      item.value ->> 'recordKey'
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)
  ) as ordered;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'recordKey', (
      select item.value -> 'recordKey' from pg_catalog.jsonb_array_elements(prepared_records) as item(value)
      where item.value -> 'recordTypeId' = proposed.value -> 'recordTypeId'
        and item.value -> 'recordId' = proposed.value -> 'recordId'
    ),
    'recordTypeId', proposed.value -> 'recordTypeId', 'recordId', proposed.value -> 'recordId',
    'values', proposed.value -> 'existingValues', 'lifecycleState', proposed.value -> 'lifecycleState'
  )), '[]'::jsonb) into proposals
  from pg_catalog.jsonb_array_elements(p_proposed_records) as proposed(value);
  graph := vortex_record.prepare_record_calculation_graph_internal(
    catalogue, prepared_records, proposals, array['root']::text[]
  );
  if graph ->> 'outcome' is distinct from 'prepared' then return graph; end if;
  prepared_records := graph -> 'records';

  -- Every record removed or recovered by the command has its own lifecycle
  -- rules. Keep those stored-value snapshots separate from generated-field
  -- parents, whose applicable operation remains update.
  for lifecycle_effect in
    select effect.*
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = context_organization_id
      and effect.application_root_id = context_application_id
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = p_command_id
      and effect.effect_kind = case when p_operation = 'delete' then 'soft_deleted' else 'restored' end
    order by effect.storage_contract_id, effect.record_id
  loop
    select item.value into strict lifecycle_type
    from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') as item(value)
    where (item.value ->> 'recordTypeId')::uuid = lifecycle_effect.record_type_id;
    lifecycle_loaded := vortex_record.load_record_access_facts_internal(
      lifecycle_effect.record_type_id, p_operation, lifecycle_effect.record_id,
      null, null
    );
    if lifecycle_loaded ->> 'outcome' is distinct from 'loaded' then
      raise exception using errcode = '55000', message = 'Lifecycle rule snapshot is unavailable';
    end if;
    select storage.module_root_id into strict rule_module_root_id
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = lifecycle_effect.storage_contract_id
      and storage.record_type_id = lifecycle_effect.record_type_id
      and storage.state = 'active';
    lifecycle_records := lifecycle_records || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordKey', case when lifecycle_effect.record_type_id = p_record_type_id
            and lifecycle_effect.record_id = p_record_id then 'root'
          else lifecycle_effect.record_type_id::text || ':' || lifecycle_effect.record_id::text end,
        'recordType', lifecycle_type - 'moduleReleaseRevision',
        'recordId', lifecycle_effect.record_id,
        'concurrencyNumber', lifecycle_loaded -> 'concurrencyNumber',
        'existingValues', case when p_root_snapshot is not null
            and lifecycle_effect.record_type_id = p_record_type_id
            and lifecycle_effect.record_id = p_record_id
          then p_root_snapshot -> 'existingValues'
          else lifecycle_loaded -> 'fieldValues' end,
        'canRead', lifecycle_effect.record_type_id = p_record_type_id and lifecycle_effect.record_id = p_record_id,
        'relationshipSources', '[]'::jsonb,
        'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
          rule_module_root_id, (lifecycle_type ->> 'moduleReleaseRevision')::bigint,
          lifecycle_effect.record_type_id
        )
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', '[]'::jsonb,
    'records', prepared_records,
    'lifecycleRecords', lifecycle_records
  );
end
$function$;
alter function vortex_record.prepare_record_lifecycle_totals_internal(text,uuid,uuid,uuid,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_record_lifecycle_totals_internal(text, uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.prepare_record_lifecycle_totals_internal(text, uuid, uuid, uuid, jsonb, jsonb) is null;
