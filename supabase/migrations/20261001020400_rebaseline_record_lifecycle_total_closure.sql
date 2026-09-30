begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

set local role vortex_record_adapter;
create or replace function vortex_record.record_lifecycle_total_closure_internal(
  p_catalogue jsonb,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_command_id uuid
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
  context_actor_id uuid;
  seed record;
  seed_key text;
  closure_value jsonb;
  closure_record jsonb;
  record_key text;
  records jsonb := '[]'::jsonb;
  record_keys text[] := array[]::text[];
  signatures jsonb := '[]'::jsonb;
begin
  if p_operation = 'restore' then
    return vortex_record.discover_relationship_total_closure_internal(
      p_catalogue, 'update', p_record_type_id, p_record_id, '{}'::jsonb
    );
  end if;
  if p_operation is distinct from 'delete' or p_command_id is null
    or pg_catalog.jsonb_typeof(p_catalogue -> 'recordTypes') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_catalogue -> 'relationships') is distinct from 'array' then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  context_actor_id := (context_value ->> 'organizationAccountId')::uuid;

  for seed in
    select distinct
      (target_type.value ->> 'recordTypeId')::uuid as record_type_id,
      edge.to_storage_contract_id as storage_contract_id,
      edge.to_record_id as record_id
    from vortex_record.record_lifecycle_command_effects as effect
    join vortex_record.relationship_edges as edge
      on edge.from_organisation_id = effect.organization_id
     and edge.from_storage_contract_id = effect.storage_contract_id
     and edge.from_record_id = effect.record_id
    cross join lateral (
      select item.value
      from pg_catalog.jsonb_array_elements(p_catalogue -> 'relationships') as item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
          pg_catalog.lower(edge.relationship_id::text)
        and item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
    ) as relationship
    cross join lateral (
      select item.value
      from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
      where (item.value ->> 'storageContractId')::uuid = edge.to_storage_contract_id
        and vortex_record.relationship_declares_target_internal(
          relationship.value, (item.value ->> 'recordTypeId')::uuid
        )
    ) as target_type
    where effect.organization_id = context_organization_id
      and effect.application_root_id = context_application_id
      and effect.actor_organization_account_id = context_actor_id
      and effect.command_id = p_command_id
      and effect.effect_kind = 'soft_deleted'
      and edge.to_organisation_id = context_organization_id
      and edge.to_application_root_id is not distinct from case
        when target_type.value ->> 'storageScope' = 'application_contained'
          then context_application_id else null end
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements(target_type.value -> 'fields') as field(value)
        where field.value ->> 'type' = 'total'
          and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
            pg_catalog.lower(relationship.value ->> 'relationshipId')
      )
      and not exists (
        select 1 from vortex_record.record_lifecycle_command_effects as deleted
        where deleted.organization_id = effect.organization_id
          and deleted.application_root_id = effect.application_root_id
          and deleted.actor_organization_account_id = effect.actor_organization_account_id
          and deleted.command_id = effect.command_id
          and deleted.effect_kind = 'soft_deleted'
          and deleted.storage_contract_id = edge.to_storage_contract_id
          and deleted.record_id = edge.to_record_id
      )
    order by 2, 3
  loop
    seed_key := pg_catalog.lower(seed.record_type_id::text) || ':'
      || pg_catalog.lower(seed.record_id::text);
    -- A parent already reached is complete: discovery follows every
    -- transitive total parent of each member it adds.
    if seed_key = any (record_keys) then
      continue;
    end if;
    closure_value := vortex_record.discover_relationship_total_closure_internal(
      p_catalogue, 'update', seed.record_type_id, seed.record_id, '{}'::jsonb
    );
    if closure_value is null then
      return null;
    end if;
    for closure_record in
      select item.value
      from pg_catalog.jsonb_array_elements(closure_value -> 'records') as item(value)
    loop
      record_key := case when closure_record ->> 'recordKey' = 'root'
        then seed_key else closure_record ->> 'recordKey' end;
      if record_key = any (record_keys) then
        continue;
      end if;
      records := records || pg_catalog.jsonb_build_array(
        closure_record || pg_catalog.jsonb_build_object('recordKey', record_key)
      );
      record_keys := pg_catalog.array_append(record_keys, record_key);
    end loop;
    signatures := signatures || coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'from', case when item.value ->> 'from' = 'root'
          then seed_key else item.value ->> 'from' end,
        'relationshipId', item.value -> 'relationshipId',
        'to', case when item.value ->> 'to' = 'root'
          then seed_key else item.value ->> 'to' end
      ))
      from pg_catalog.jsonb_array_elements(closure_value -> 'signatures') as item(value)
    ), '[]'::jsonb);
  end loop;

  return pg_catalog.jsonb_build_object(
    'records', records,
    'signatures', coalesce((
      select pg_catalog.jsonb_agg(distinct item.value order by item.value)
      from pg_catalog.jsonb_array_elements(signatures) as item(value)
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_record.record_lifecycle_total_closure_internal(jsonb, text, uuid, uuid, uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.record_lifecycle_total_closure_internal(jsonb, text, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
comment on function vortex_record.record_lifecycle_total_closure_internal(jsonb, text, uuid, uuid, uuid) is null;

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
