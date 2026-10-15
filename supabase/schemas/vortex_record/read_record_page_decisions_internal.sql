create or replace function vortex_record.read_record_page_decisions_internal(
  p_record_type_id uuid,
  p_first_loaded jsonb,
  p_page_declaration jsonb,
  p_page_eligibility jsonb,
  p_record_ids uuid[]
)
returns table (record_id uuid, loaded jsonb, decision jsonb, bounds jsonb)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  checked_at timestamptz;
  type_meta jsonb := p_first_loaded -> 'recordTypeMeta';
  load_sql text;
  page_records jsonb;
  page_record_ids uuid[];
  page_concurrency bigint[];
  page_definition_revisions bigint[];
  narrowed boolean := false;
  decisions jsonb;
  decision_item jsonb;
  facts_item jsonb;
  bounds_by_route jsonb := '{}'::jsonb;
  bounds_key text;
  row_position integer;
  envelope jsonb := p_first_loaded;
begin
  -- The page's read decisions in one pass. The first record's facts, loaded by
  -- the exact loader in this invocation, supply the installation-wide part of
  -- every record's facts; each record contributes only its own stored row. A
  -- record type whose read facts can reach other records (an inherited owner
  -- or a relationship route) is not decided here at all, and neither is a
  -- preview, a protected projection or an expired page eligibility.
  if p_record_type_id is null
    or pg_catalog.cardinality(p_record_ids) is null
    or pg_catalog.cardinality(p_record_ids) > 201
    or p_first_loaded ->> 'outcome' is distinct from 'loaded'
    or p_first_loaded ? 'previewInstallationId'
    or (p_first_loaded ->> 'isSystemProjection')::boolean is distinct from false
    or p_first_loaded -> 'declaration' is distinct from p_page_declaration
    or pg_catalog.lower(p_first_loaded #>> '{facts,binding,recordTypeId}')
      is distinct from pg_catalog.lower(p_record_type_id::text)
    or pg_catalog.jsonb_typeof(type_meta) is distinct from 'object'
    or pg_catalog.lower(type_meta ->> 'recordTypeId') is distinct from pg_catalog.lower(p_record_type_id::text)
    or coalesce(type_meta ->> 'ownershipMode', '') = 'inherited'
    or pg_catalog.jsonb_array_length(p_first_loaded #> '{facts,records}') is distinct from 1
    or p_first_loaded #> '{facts,edges}' is distinct from '[]'::jsonb
    or p_page_eligibility ->> 'outcome' is distinct from 'eligible'
    or (p_page_eligibility ->> 'validUntil')::timestamptz <= pg_catalog.clock_timestamp()
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_page_declaration -> 'requiredPermissions') as required(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_first_loaded -> 'accessPermissions'
            -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes') = 'array'
          then p_first_loaded -> 'accessPermissions'
            -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes'
          else '[{"kind": "relationship"}]'::jsonb end
      ) as route(value)
      where route.value ->> 'kind' = 'relationship'
    ) then
    return;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if p_first_loaded -> 'context' is distinct from context_value then
    return;
  end if;

  -- The same record fact the exact loader builds, for every page record.
  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
       ''recordScope'', pg_catalog.jsonb_build_object(
         ''storageScope'', %L,
         ''organizationId'', stored.organisation_id,
         ''moduleRootId'', %L::uuid,
         ''recordTypeId'', %L::uuid,
         ''storageContractId'', %L::uuid,
         ''recordId'', stored.record_id
       ) || case when %L = ''application_contained''
         then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
         else ''{}''::jsonb end,
       ''lifecycleState'', stored.lifecycle_state,
       ''fieldValues'', pg_catalog.jsonb_build_object(%s)
     ) || case
       when stored.owner_organisation_account_id is not null
         then pg_catalog.jsonb_build_object(
           ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
       when stored.owner_group_id is not null
         then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
       else ''{}''::jsonb end order by requested.ordinality),
     pg_catalog.array_agg(stored.record_id order by requested.ordinality),
     pg_catalog.array_agg(stored.concurrency_number order by requested.ordinality),
     pg_catalog.array_agg(stored.definition_revision order by requested.ordinality)
     from pg_catalog.unnest($2) with ordinality as requested(id, ordinality)
     join record_data.%I as stored
       on stored.organisation_id = $1 and stored.record_id = requested.id',
    type_meta ->> 'storageScope', (type_meta ->> 'moduleRootId')::uuid, p_record_type_id,
    (type_meta ->> 'storageContractId')::uuid, type_meta ->> 'storageScope',
    type_meta ->> 'valueExpression', type_meta ->> 'table'
  );
  execute load_sql
    into page_records, page_record_ids, page_concurrency, page_definition_revisions
    using (context_value ->> 'organizationId')::uuid, p_record_ids;
  if page_records is null then
    return;
  end if;

  -- When nothing about this record type can reach another record or another
  -- record type (no total field, and every route of every permission on it is
  -- an all-record, owner or direct-share route), each record's facts carry
  -- only its own type and its own permissions, and no relationship: every
  -- reader of these facts (projection, derived fields, capabilities) looks at
  -- nothing else.
  if not exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_first_loaded #> '{facts,recordTypes}') as record_type(value)
      cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
      where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
        and field.value ->> 'type' = 'total'
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_each(p_first_loaded -> 'accessPermissions') as declared(key, value)
      where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
        and (pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}') is distinct from 'array'
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(
              case when pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}') = 'array'
                then declared.value #> '{recordScope,routes}' else '[]'::jsonb end
            ) as route(value)
            where coalesce(route.value ->> 'kind', '') not in ('all_records', 'ownership', 'direct_share')
          ))
    ) then
    envelope := pg_catalog.jsonb_set(pg_catalog.jsonb_set(pg_catalog.jsonb_set(
      p_first_loaded, '{facts,relationships}', '[]'::jsonb), '{facts,recordTypes}', (
        select coalesce(pg_catalog.jsonb_agg(record_type.value order by record_type.ordinality), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(p_first_loaded #> '{facts,recordTypes}')
          with ordinality as record_type(value, ordinality)
        where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
      )), '{accessPermissions}', (
        select coalesce(pg_catalog.jsonb_object_agg(declared.key, declared.value), '{}'::jsonb)
        from pg_catalog.jsonb_each(p_first_loaded -> 'accessPermissions') as declared(key, value)
        where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
      ));
    narrowed := true;
  end if;

  checked_at := pg_catalog.clock_timestamp();
  decisions := vortex_access.decide_record_page_scope_internal(
    context_value, checked_at, p_page_declaration, p_page_eligibility,
    p_first_loaded #> '{facts,recordTypes}', page_records, true
  );
  if decisions is null then
    return;
  end if;

  for decision_item, facts_item, row_position in
    select decided.value, page_records -> (decided.ordinality::integer - 1), decided.ordinality::integer
    from pg_catalog.jsonb_array_elements(decisions) with ordinality as decided(value, ordinality)
  loop
    if decision_item = 'null'::jsonb then
      continue;
    end if;
    record_id := (decision_item ->> 'recordId')::uuid;
    if record_id is distinct from page_record_ids[row_position]
      or record_id is distinct from (facts_item #>> '{recordScope,recordId}')::uuid then
      raise exception using errcode = '55000', message = 'Page record decisions are misaligned';
    end if;
    decision := decision_item;
    bounds := null;
    loaded := pg_catalog.jsonb_set(envelope, '{facts,records}',
        pg_catalog.jsonb_build_array(facts_item))
      || pg_catalog.jsonb_build_object(
        'concurrencyNumber', page_concurrency[row_position],
        'definitionRevision', page_definition_revisions[row_position],
        'fieldValues', facts_item -> 'fieldValues');
    if decision_item ->> 'outcome' = 'allowed' then
      -- The same contributions have the same field policy: resolve each
      -- distinct contribution set once for the page.
      bounds_key := pg_catalog.jsonb_build_array(
        decision_item -> 'organizationId', decision_item -> 'matchedContributions')::text;
      bounds := bounds_by_route -> bounds_key;
      if bounds is null then
        bounds := vortex_access.resolve_record_field_bounds_internal(decision_item);
        if narrowed then
          -- Without a total field the derived readable set depends only on the
          -- record type and these bounds, not on the record.
          bounds := bounds || pg_catalog.jsonb_build_object('projectedReadableFieldIds',
            vortex_record.project_derived_readable_field_ids_internal(
              loaded, p_record_type_id, record_id, bounds -> 'readableFieldIds',
              bounds -> 'readableFieldIds', '[]'::jsonb));
        end if;
        bounds_by_route := bounds_by_route || pg_catalog.jsonb_build_object(bounds_key, bounds);
      end if;
    end if;
    return next;
  end loop;
end
$function$;

alter function vortex_record.read_record_page_decisions_internal(uuid,jsonb,jsonb,jsonb,uuid[])
  owner to vortex_record_adapter;
revoke all on function vortex_record.read_record_page_decisions_internal(uuid,jsonb,jsonb,jsonb,uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_page_decisions_internal(uuid,jsonb,jsonb,jsonb,uuid[]) is
  'Private page read pass for the fixed record adapter: loads the stored facts of every candidate record of one page in one statement, decides them together through the set-based exact decision with the page eligibility computed once in this invocation, and resolves field bounds once per distinct contribution set; each decided record carries the facts the exact loader would give it, narrowed to its own record type and permissions when nothing about that type reaches another record or type; returns only records it decided, so every other record keeps the exact single-record path.';
