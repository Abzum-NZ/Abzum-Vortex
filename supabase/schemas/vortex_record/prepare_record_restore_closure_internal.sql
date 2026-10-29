create or replace function vortex_record.prepare_record_restore_closure_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  delete_command_id uuid;
  effects jsonb;
  subjects jsonb := '[]'::jsonb;
  subject jsonb;
  effect jsonb;
  meta jsonb;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  stored_fact jsonb;
  relationship_value jsonb;
  bounds jsonb;
  restored_values jsonb;
  physical_values jsonb;
  missing_links integer;
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record restore requires an Application context';
  end if;
  -- The current root revision identifies the delete that removed this record.
  -- A different actor may restore it only under their own current permissions.
  select entry.command_id into delete_command_id
  from vortex_record.record_lifecycle_command_effects as entry
  where entry.organization_id = (context_value ->> 'organizationId')::uuid
    and entry.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and entry.record_type_id = p_record_type_id
    and entry.record_id = p_record_id
    and entry.effect_kind = 'soft_deleted'
    and entry.post_concurrency_number = p_expected_concurrency_number;
  if delete_command_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(entry) order by entry.effect_sequence),
    pg_catalog.count(*) filter (
      where entry.effect_kind = 'optional_cleared' and entry.previous_value is null
    )::integer
  into effects, missing_links
  from vortex_record.record_lifecycle_command_effects as entry
  where entry.organization_id = (context_value ->> 'organizationId')::uuid
    and entry.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and entry.command_id = delete_command_id;

  -- Lock the complete affected set before changing any row. A cleared-link
  -- source can occur more than once; its last journaled revision is authoritative.
  for subject in
    select pg_catalog.jsonb_build_object(
      'storageContractId', item.value -> 'storage_contract_id',
      'recordTypeId', item.value -> 'record_type_id',
      'recordId', item.value -> 'record_id',
      'expectedConcurrencyNumber', pg_catalog.max((item.value ->> 'post_concurrency_number')::bigint),
      'deleted', pg_catalog.bool_or(item.value ->> 'effect_kind' = 'soft_deleted')
    )
    from pg_catalog.jsonb_array_elements(effects) as item(value)
    where item.value ->> 'effect_kind' = 'soft_deleted'
      or item.value -> 'previous_value' <> 'null'::jsonb
    group by item.value -> 'storage_contract_id', item.value -> 'record_type_id',
      item.value -> 'record_id'
    order by item.value -> 'storage_contract_id', item.value -> 'record_id'
  loop
    meta := vortex_record.resolve_record_action_context_internal(
      (subject ->> 'recordTypeId')::uuid,
      case when (subject ->> 'deleted')::boolean then 'restore' else 'update' end
    );
    loaded := vortex_record.load_record_access_facts_internal(
      (subject ->> 'recordTypeId')::uuid,
      case when (subject ->> 'deleted')::boolean then 'restore' else 'update' end,
      (subject ->> 'recordId')::uuid,
      (subject ->> 'expectedConcurrencyNumber')::bigint, null
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'restore_closure_changed',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' is distinct from 'loaded'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') is distinct from 'object'
      or meta -> 'storageContractId' is distinct from subject -> 'storageContractId' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    select item.value into strict stored_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where item.value #>> '{recordScope,recordId}' = subject ->> 'recordId';
    if stored_fact ->> 'lifecycleState' is distinct from
      (case when (subject ->> 'deleted')::boolean then 'soft_deleted' else 'active' end) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'restore_closure_changed',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    -- Inherited ownership and permission conditions see the same complete
    -- restored closure, not a partially restored parent or child.
    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta #> '{declaration,recordBinding}',
      'records', (
        select pg_catalog.jsonb_agg(case when exists (
          select 1 from pg_catalog.jsonb_array_elements(effects) as deleted(value)
          where deleted.value ->> 'effect_kind' = 'soft_deleted'
            and deleted.value ->> 'record_id' = item.value #>> '{recordScope,recordId}'
            and deleted.value ->> 'storage_contract_id' = item.value #>> '{recordScope,storageContractId}'
        ) then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active')
          else item.value end order by item.ordinality)
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
          with ordinality as item(value, ordinality)
      )
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', (subject ->> 'recordId')::uuid, facts
    );
    if decision ->> 'outcome' is distinct from 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
    restored_values := loaded -> 'fieldValues';
    physical_values := '{}'::jsonb;
    for effect in
      select item.value from pg_catalog.jsonb_array_elements(effects) as item(value)
      where item.value ->> 'effect_kind' = 'optional_cleared'
        and item.value ->> 'storage_contract_id' = subject ->> 'storageContractId'
        and item.value ->> 'record_id' = subject ->> 'recordId'
        and item.value -> 'previous_value' <> 'null'::jsonb
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(meta #> '{recordType,relationships}') as item(value)
      where item.value ->> 'relationshipId' = effect ->> 'relationship_id';
      if relationship_value is null
        or not (bounds -> 'changeableFieldIds') ? (relationship_value ->> 'fromFieldId')
        or coalesce(loaded -> 'fieldValues' -> (relationship_value ->> 'fromFieldId'), 'null'::jsonb)
          <> 'null'::jsonb then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'restore_closure_changed',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      restored_values := restored_values || pg_catalog.jsonb_build_object(
        relationship_value ->> 'fromFieldId', effect -> 'previous_value'
      );
      physical_values := physical_values || pg_catalog.jsonb_build_object(
        meta -> 'columns' -> (relationship_value ->> 'fromFieldId') ->> 'token',
        effect -> 'previous_value'
      );
    end loop;
    subjects := subjects || pg_catalog.jsonb_build_array(subject || pg_catalog.jsonb_build_object(
      'table', meta -> 'table', 'releaseRevision', meta -> 'moduleReleaseRevision',
      'recordType', meta -> 'recordType', 'columns', meta -> 'columns',
      'values', restored_values,
      'storageChange', pg_catalog.jsonb_build_object(
        'storageContractId', subject -> 'storageContractId', 'recordId', subject -> 'recordId',
        'expectedConcurrencyNumber', subject -> 'expectedConcurrencyNumber',
        'values', physical_values || pg_catalog.jsonb_build_object(
          'definition_revision', meta -> 'moduleReleaseRevision'
        ) || case when (subject ->> 'deleted')::boolean then pg_catalog.jsonb_build_object(
          'lifecycle_state', 'active', 'deleted_at', null, 'deleted_by', null, 'removal_due_at', null
        ) else '{}'::jsonb end
      )
    ));
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'subjects', subjects,
    'storageChanges', (select pg_catalog.jsonb_agg(item.value -> 'storageChange')
      from pg_catalog.jsonb_array_elements(subjects) as item(value)),
    'unrestoredLinkCount', missing_links
  );
end
$function$;

alter function vortex_record.prepare_record_restore_closure_internal(uuid,uuid,bigint) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_restore_closure_internal(uuid,uuid,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_restore_closure_internal(uuid,uuid,bigint) is
  'Private restore closure preparation: locates the deleting command and locks its unchanged retained records and recoverable optional links under current authority, without writing records.';
