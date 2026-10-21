create or replace function vortex_record.query_search_prefilter_internal(
  p_storage_contract_id uuid,
  p_fields_by_id jsonb,
  p_search_field_ids text[],
  p_readable_field_ids text[],
  p_user_search text,
  p_search_fields_slot integer,
  p_search_term_slot integer
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  -- The one stored-value narrowing of a candidate scan by a search: the
  -- authoritative search predicate evaluated over the stored values of the searched
  -- fields, built from the same value expression read_record projects from. A
  -- projection only omits stored values, so every record whose readable values match
  -- also matches here: the narrowing is a superset and read_record, with the
  -- per-row search match, stays the decision for each counted match.
  -- A searched field without an active column, or derived (calculation, total), has no
  -- such proof, so the scan is then not narrowed at all. Nor is it when a searched field
  -- is not readable on every scanned row: a withheld stored value must never decide
  -- whether a candidate is examined, or the ceiling would reveal it.
  -- The caller binds the searched field ids and the term at the given parameter slots.
  if p_user_search is null or pg_catalog.cardinality(p_search_field_ids) = 0 or exists (
    select 1
    from pg_catalog.unnest(p_search_field_ids) as searched(id)
    left join vortex_record.field_storage_mappings as mapping
      on mapping.storage_contract_id = p_storage_contract_id
      and mapping.field_id = searched.id::uuid
    where mapping.storage_contract_id is null
      or mapping.state <> 'active'
      or p_fields_by_id -> searched.id ->> 'type' in ('calculation', 'total')
      or searched.id <> all (p_readable_field_ids)
  ) then
    return 'true';
  end if;
  return pg_catalog.format(
    'vortex_record.query_search_matches_internal(pg_catalog.jsonb_build_object(%s), $%s::text[], $%s::text)',
    vortex_record.named_action_storage_columns_internal(
      p_storage_contract_id,
      (select pg_catalog.jsonb_agg(p_fields_by_id -> searched.id)
       from pg_catalog.unnest(p_search_field_ids) as searched(id))
    ) ->> 'valueExpression',
    p_search_fields_slot,
    p_search_term_slot
  );
end
$function$;
alter function vortex_record.query_search_prefilter_internal(uuid,jsonb,text[],text[],text,integer,integer) owner to vortex_record_adapter;
revoke all on function vortex_record.query_search_prefilter_internal(uuid,jsonb,text[],text[],text,integer,integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.query_search_prefilter_internal(uuid,jsonb,text[],text[],text,integer,integer)
  to vortex_owner;

comment on function vortex_record.query_search_prefilter_internal(uuid,jsonb,text[],text[],text,integer,integer) is
  'The one stored-value search pre-predicate of a bounded candidate scan, shared by the table read and the summary: the search match over the searched fields'' stored values as a superset of the per-row match, or true when a searched field has no active column, is derived or is not readable on every scanned row.';
