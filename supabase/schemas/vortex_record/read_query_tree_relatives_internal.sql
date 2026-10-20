create or replace function vortex_record.read_query_tree_relatives_internal(
  p_parents boolean, p_record_ids uuid[], p_relationship_id uuid,
  p_organization_id uuid, p_application_root_id uuid, p_storage_plan jsonb,
  p_record_type_id uuid, p_first_loaded jsonb, p_declaration jsonb,
  p_eligibility jsonb, p_shared jsonb, p_narrowed boolean, p_validated_types jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  pending uuid[] := p_record_ids;
  found_ids uuid[] := array[]::uuid[];
  candidates uuid[];
  owners uuid[];
  decided_ids uuid[];
  outcomes text[];
  candidate_index integer;
  round_number integer := 0;
  examined integer := 0;
  outcome text;
  access_sql text := p_storage_plan #>> '{access,predicate}';
  owner_groups uuid[];
  shared_records uuid[];
  storage_contract_id uuid := (p_storage_plan #>> '{storage,storageContractId}')::uuid;
  owner_column text := case when p_parents then 'from_record_id' else 'to_record_id' end;
  candidate_column text := case when p_parents then 'to_record_id' else 'from_record_id' end;
begin
  -- Private invocation-local facts come from the query's validated page, never caller state.
  if p_parents is null or pg_catalog.cardinality(p_record_ids) > 201
    or p_organization_id is null or storage_contract_id is null or access_sql is null then
    raise exception using errcode = '22023', message = 'Tree relative read is invalid';
  end if;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[]) into owner_groups
  from pg_catalog.jsonb_array_elements_text(p_storage_plan #> '{access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[]) into shared_records
  from pg_catalog.jsonb_array_elements_text(p_storage_plan #> '{access,sharedRecordIds}') as item(value);
  -- Keep the protected scan's parameter slots; only slots 1,2,6,7,8,10 occur in access predicates.
  while examined < 500 and pg_catalog.cardinality(pending) > 0 loop
    round_number := round_number + 1;
    execute pg_catalog.format(
      'select pg_catalog.array_agg(candidate.record_id order by candidate.owner_id),
         pg_catalog.array_agg(candidate.owner_id order by candidate.owner_id)
       from (
         select stored.record_id, edge.%1$I as owner_id,
           pg_catalog.row_number() over (partition by edge.%1$I order by stored.record_id) as rank
         from vortex_record.relationship_edges as edge
         join record_data.%2$I as stored on stored.organisation_id = edge.from_organisation_id
           and stored.record_id = edge.%3$I
         where edge.relationship_id = %4$L::uuid and edge.from_organisation_id = $1
           and edge.to_organisation_id = $1
           and edge.from_storage_contract_id = %5$L::uuid and edge.to_storage_contract_id = %5$L::uuid
           and edge.%1$I = any ($11) and stored.lifecycle_state = ''active''
           and %6$s and (%7$s)
       ) as candidate where candidate.rank = $12',
      owner_column, p_storage_plan #>> '{storage,physicalTableToken}', candidate_column,
      p_relationship_id, storage_contract_id,
      case when p_storage_plan #>> '{storage,storageScope}' = 'application_contained'
        then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
      access_sql)
    into candidates, owners
    using p_organization_id, p_application_root_id, null::text[], null::uuid, 501,
      (p_storage_plan #>> '{access,ownerAccountId}')::uuid, owner_groups, shared_records,
      null::jsonb, p_storage_plan #> '{access,parameters}', pending, round_number;
    exit when candidates is null;
    examined := examined + pg_catalog.cardinality(candidates);
    select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
      coalesce(pg_catalog.array_agg(decided.decision ->> 'outcome'), array[]::text[])
    into decided_ids, outcomes
    from vortex_record.read_record_page_decisions_internal(
      p_record_type_id, p_first_loaded, p_declaration, p_eligibility,
      candidates, p_shared -> 'envelope', p_narrowed
    ) as decided;
    for candidate_index in 1 .. pg_catalog.cardinality(candidates) loop
      if candidates[candidate_index] = any (decided_ids) then
        outcome := outcomes[pg_catalog.array_position(decided_ids, candidates[candidate_index])];
      else
        select row_read.projection ->> 'outcome' into outcome
        from vortex_record.read_record_projection_with_validated_types_internal(
          p_record_type_id, candidates[candidate_index], p_declaration, p_eligibility,
          p_validated_types, null, null, null, null, p_shared
        ) as row_read;
      end if;
      if outcome = 'allowed' then
        found_ids := pg_catalog.array_append(found_ids, owners[candidate_index]);
      end if;
    end loop;
    exit when p_parents;
    select coalesce(pg_catalog.array_agg(item.id), array[]::uuid[]) into pending
    from pg_catalog.unnest(pending) as item(id)
    where item.id <> all (found_ids) and item.id = any (owners);
  end loop;
  if not p_parents and examined >= 500 and pg_catalog.cardinality(pending) > 0 then
    raise warning 'Tree child visibility examination budget exhausted';
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'dataset_limit_exceeded');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'recordIds', pg_catalog.to_jsonb(found_ids));
end
$function$;

alter function vortex_record.read_query_tree_relatives_internal(boolean,uuid[],uuid,uuid,uuid,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,boolean,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.read_query_tree_relatives_internal(boolean,uuid[],uuid,uuid,uuid,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,boolean,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
