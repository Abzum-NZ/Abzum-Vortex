create or replace function vortex_record.read_query_tree_relatives_internal(
  p_parents boolean, p_record_ids uuid[], p_relationship_id uuid,
  p_organization_id uuid, p_application_root_id uuid, p_storage_plan jsonb,
  p_record_type_id uuid, p_first_loaded jsonb, p_declaration jsonb,
  p_eligibility jsonb, p_shared jsonb, p_narrowed boolean, p_validated_types jsonb,
  p_filter jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  pending uuid[] := p_record_ids;
  pending_after uuid[] := pg_catalog.array_fill(null::uuid, array[pg_catalog.cardinality(p_record_ids)]);
  batch_owners uuid[];
  batch_after uuid[];
  rest_owners uuid[];
  rest_after uuid[];
  round_room integer;
  candidate_values jsonb[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  readable_values jsonb;
  filter_condition jsonb := nullif(p_filter -> 'condition', 'null'::jsonb);
  filter_ids text[];
  search_field_ids text[];
  search_text text := p_filter ->> 'search';
  matches boolean;
  found_ids uuid[] := array[]::uuid[];
  candidates uuid[];
  owners uuid[];
  decided_ids uuid[];
  outcomes text[];
  candidate_index integer;
  examined integer := 0;
  outcome text;
  access_sql text := p_storage_plan #>> '{access,predicate}';
  owner_groups uuid[];
  shared_records uuid[];
  storage_contract_id uuid := (p_storage_plan #>> '{storage,storageContractId}')::uuid;
  filter_exact boolean := (p_filter ->> 'exact')::boolean is true;
  owner_column text := case when p_parents then 'from_record_id' else 'to_record_id' end;
  candidate_column text := case when p_parents then 'to_record_id' else 'from_record_id' end;
begin
  -- Private invocation-local facts come from the query's validated page, never caller state.
  if p_parents is null or pg_catalog.cardinality(p_record_ids) > 201
    or p_organization_id is null or storage_contract_id is null or access_sql is null
    or pg_catalog.jsonb_typeof(p_filter) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_filter -> 'predicate') is distinct from 'string' then
    raise exception using errcode = '22023', message = 'Tree relative read is invalid';
  end if;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[]) into owner_groups
  from pg_catalog.jsonb_array_elements_text(p_storage_plan #> '{access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[]) into shared_records
  from pg_catalog.jsonb_array_elements_text(p_storage_plan #> '{access,sharedRecordIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into filter_ids
  from pg_catalog.jsonb_array_elements_text(p_filter -> 'fieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into search_field_ids
  from pg_catalog.jsonb_array_elements_text(p_filter -> 'searchFieldIds') as item(value);
  -- Keep the protected scan's parameter slots; slots 1,2,6,7,8,10 occur in access predicates and
  -- slot 9 in the query's pushed filter predicate.
  -- Each round reads, for every undecided owner within the remaining budget, its next candidate that
  -- matches the query's filter after the one it last examined (keyset by record id), so the work is
  -- bounded by the candidates examined. Owners the budget did not reach stay undecided.
  while examined < 500 and pg_catalog.cardinality(pending) > 0 loop
    round_room := 500 - examined;
    batch_owners := pending[1 : round_room];
    batch_after := pending_after[1 : round_room];
    rest_owners := pending[round_room + 1 :];
    rest_after := pending_after[round_room + 1 :];
    execute pg_catalog.format(
      'select pg_catalog.array_agg(candidate.record_id order by pending_item.owner_id),
         pg_catalog.array_agg(pending_item.owner_id order by pending_item.owner_id),
         pg_catalog.array_agg(candidate.filter_values order by pending_item.owner_id)
       from rows from (pg_catalog.unnest($11::uuid[]), pg_catalog.unnest($12::uuid[]))
         as pending_item(owner_id, after_id)
       cross join lateral (
         select stored.record_id, pg_catalog.jsonb_build_object(%8$s) as filter_values
         from vortex_record.relationship_edges as edge
         join record_data.%2$I as stored on stored.organisation_id = edge.from_organisation_id
           and stored.record_id = edge.%3$I
         where edge.relationship_id = %4$L::uuid and edge.from_organisation_id = $1
           and edge.to_organisation_id = $1
           and edge.from_storage_contract_id = %5$L::uuid and edge.to_storage_contract_id = %5$L::uuid
           and edge.%1$I = pending_item.owner_id
           and (pending_item.after_id is null or stored.record_id > pending_item.after_id)
           and stored.lifecycle_state = ''active''
           and %6$s and (%7$s)
           and (case when (%9$s) then true else false end)
         order by stored.record_id
         limit 1
       ) as candidate',
      owner_column, p_storage_plan #>> '{storage,physicalTableToken}', candidate_column,
      p_relationship_id, storage_contract_id,
      case when p_storage_plan #>> '{storage,storageScope}' = 'application_contained'
        then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
      access_sql, coalesce(p_filter ->> 'valuesSql', ''), p_filter ->> 'predicate')
    into candidates, owners, candidate_values
    using p_organization_id, p_application_root_id, null::text[], null::uuid, 501,
      (p_storage_plan #>> '{access,ownerAccountId}')::uuid, owner_groups, shared_records,
      p_filter -> 'parameters', p_storage_plan #> '{access,parameters}', batch_owners, batch_after;
    if candidates is null then
      -- No owner of this batch has a matching candidate left; only owners beyond the budget remain.
      pending := coalesce(rest_owners, array[]::uuid[]);
      pending_after := coalesce(rest_after, array[]::uuid[]);
      continue;
    end if;
    examined := examined + pg_catalog.cardinality(candidates);
    select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
      coalesce(pg_catalog.array_agg(decided.decision ->> 'outcome'), array[]::text[]),
      pg_catalog.array_agg(decided.loaded), pg_catalog.array_agg(decided.decision),
      pg_catalog.array_agg(decided.bounds)
    into decided_ids, outcomes, decided_loaded, decided_decisions, decided_bounds
    from vortex_record.read_record_page_decisions_internal(
      p_record_type_id, p_first_loaded, p_declaration, p_eligibility,
      candidates, p_shared -> 'envelope', p_narrowed
    ) as decided;
    for candidate_index in 1 .. pg_catalog.cardinality(candidates) loop
      decided_index := pg_catalog.array_position(decided_ids, candidates[candidate_index]);
      readable_values := null;
      if decided_index is not null and pg_catalog.cardinality(filter_ids) = 0
        and search_text is null and (filter_condition is null or filter_exact) then
        outcome := outcomes[decided_index];
      else
        -- The filter's referenced values must be readable, and its residual condition and the viewer's
        -- search must hold on the readable projection, exactly as the level scan decides a row.
        select row_read.projection ->> 'outcome', row_read.projection -> 'values'
        into outcome, readable_values
        from vortex_record.read_record_projection_with_validated_types_internal(
          p_record_type_id, candidates[candidate_index], p_declaration, p_eligibility,
          p_validated_types, null, decided_loaded[decided_index],
          decided_decisions[decided_index], decided_bounds[decided_index], p_shared
        ) as row_read;
      end if;
      if outcome = 'allowed' and readable_values is not null then
        matches := not exists (
          select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
          where not (readable_values ? referenced.id));
        if matches and filter_condition is not null and not filter_exact then
          begin
            matches := vortex_access.evaluate_query_condition_internal(
              filter_condition, p_filter -> 'fieldTypes', candidate_values[candidate_index],
              p_filter -> 'inputTypes', p_filter -> 'inputs', false);
          exception when invalid_parameter_value then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end;
        end if;
        if matches and search_text is not null then
          matches := vortex_record.query_search_matches_internal(
            readable_values, search_field_ids, search_text);
        end if;
        if not matches then outcome := 'filtered'; end if;
      end if;
      if outcome = 'allowed' then
        found_ids := pg_catalog.array_append(found_ids, owners[candidate_index]);
      end if;
    end loop;
    exit when p_parents;
    -- An owner with an allowed candidate is decided; one whose candidates ran out drops out; one the
    -- budget did not reach stays undecided with the owners that continue.
    select coalesce(pg_catalog.array_agg(item.owner_id order by item.owner_id), array[]::uuid[]),
      coalesce(pg_catalog.array_agg(item.record_id order by item.owner_id), array[]::uuid[])
    into pending, pending_after
    from rows from (pg_catalog.unnest(owners), pg_catalog.unnest(candidates))
      as item(owner_id, record_id)
    where item.owner_id <> all (found_ids);
    pending := pending || coalesce(rest_owners, array[]::uuid[]);
    pending_after := pending_after || coalesce(rest_after, array[]::uuid[]);
  end loop;
  -- Owners still pending when the budget ran out are undecided: the page is returned, not refused.
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'recordIds', pg_catalog.to_jsonb(found_ids),
    'undecidedIds', case when p_parents then '[]'::jsonb else pg_catalog.to_jsonb(pending) end);
end
$function$;

alter function vortex_record.read_query_tree_relatives_internal(boolean,uuid[],uuid,uuid,uuid,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,boolean,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.read_query_tree_relatives_internal(boolean,uuid[],uuid,uuid,uuid,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,boolean,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
