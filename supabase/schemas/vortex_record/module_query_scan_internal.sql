create or replace function vortex_record.module_query_scan_internal(
  p_plan jsonb,
  p_member jsonb,
  p_prior_decision jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  -- A page ending at this candidate budget still returns its position for the next request.
  scan_limit constant integer := 500;
  member_kind text := p_member ->> 'kind';
  page_size integer := (p_plan ->> 'pageSize')::integer;
  direction text := p_plan ->> 'direction';
  record_type_id_value uuid := (p_plan ->> 'recordTypeId')::uuid;
  v_storage_contract_id uuid := (p_plan ->> 'storageContractId')::uuid;
  context_organization_id uuid := (p_plan ->> 'organizationId')::uuid;
  context_application_root_id uuid := (p_plan ->> 'applicationRootId')::uuid;
  preview_mode boolean := (p_plan ->> 'preview')::boolean;
  fields_by_id jsonb := p_plan -> 'fieldsById';
  storage_plan jsonb := p_plan -> 'storagePlan';
  requested_ids text[];
  system_field_keys text[];
  filter_ids text[];
  search_field_ids text[];
  user_search text := p_plan #>> '{searchPlan,search}';
  filter_condition jsonb := nullif(p_plan -> 'filterCondition', 'null'::jsonb);
  filter_exact boolean := (p_plan ->> 'filterExact')::boolean;
  filter_types jsonb := p_plan -> 'filterTypes';
  parameter_types jsonb := p_plan -> 'inputTypes';
  parameter_values jsonb := p_plan -> 'inputs';
  after_sort_key text[];
  after_record_id uuid := (p_plan ->> 'afterRecordId')::uuid;
  exact_record_ids uuid[];
  access_owner_account_id uuid := nullif(p_plan #>> '{prepared,access,ownerAccountId}', '')::uuid;
  access_owner_group_ids uuid[];
  access_shared_record_ids uuid[];
  segment_predicates text[];
  segment_sql text;
  scan_sql text;
  scan_record record;
  scan_cursor refcursor;
  cursor_position integer;
  lookahead_record record;
  lookahead_ids uuid[];
  read_row record;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  -- The one bounded system projection reader, when the plan chose it.
  projection_page_scan boolean := (p_plan ->> 'projectionPageScan')::boolean;
  projection_sort_key text := p_plan ->> 'projectionSortKey';
  projection_direction text := p_plan ->> 'projectionDirection';
  projection_predicate jsonb := p_plan -> 'projectionPredicate';
  projection_batch jsonb;
  projection_after jsonb := nullif(p_plan -> 'after', 'null'::jsonb);
  projection_batch_size integer;
  projection_candidate_count integer := 0;
  projection_reader_exhausted boolean := false;
  projection_batch_exhausted boolean := false;
  projection_last_record_id uuid;
  projection_last_sort_key text[];
  projection_failure text;
  -- The page's access facts, eligibility and validated record types stay those of this one scan.
  page_access_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_eligibility_checked boolean := false;
  validated_record_types jsonb;
  page_first_loaded jsonb;
  page_shared jsonb;
  page_narrowed boolean;
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  page_batching boolean := true;
  examined integer := 0;
  budget_exhausted boolean := false;
  every_bucket_more boolean := false;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  -- Page state by bucket: one bucket, except a board's shared first pages, where each readable row
  -- goes to the column its readable choice value names.
  bucket_count integer := case when p_member ->> 'kind' = 'choice'
    then pg_catalog.jsonb_array_length(p_member -> 'columns') else 1 end;
  bucket integer;
  bucket_rows jsonb[];
  bucket_capabilities jsonb[];
  bucket_counts integer[];
  bucket_more boolean[];
  bucket_first_keys jsonb[];
  bucket_first_ids uuid[];
  bucket_last_keys jsonb[];
  bucket_last_ids uuid[];
  page_capabilities jsonb;
  rows_value jsonb;
  next_value jsonb;
  opposite_value jsonb;
  pages jsonb := '[]'::jsonb;
  key_value jsonb;
  -- Membership of the closed mode value.
  choice_field_id text := p_member ->> 'choiceFieldId';
  choice_option_values text[];
  group_by_ids text[];
  group_selector_values jsonb := p_member -> 'groupValues';
  group_link_field_id text := p_member ->> 'linkFieldId';
  group_link_cache jsonb := coalesce(p_member -> 'linkCache', '{}'::jsonb);
  group_link_values jsonb[];
  group_candidate_values jsonb;
  member_matches boolean;
  tree_field_id text := p_member ->> 'fieldId';
  tree_parent_id uuid := (p_member ->> 'parentRecordId')::uuid;
  tree_item jsonb;
  tree_root_child_ids uuid[] := array[]::uuid[];
  tree_root_nonroot_ids uuid[];
  tree_root_readable_parent_ids uuid[];
begin
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into requested_ids
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'requestedFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into system_field_keys
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'systemFieldKeys') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into filter_ids
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into search_field_ids
  from pg_catalog.jsonb_array_elements_text(p_plan #> '{searchPlan,fieldIds}') as item(value);
  select pg_catalog.array_agg(item.value #>> '{}' order by item.ordinality) into after_sort_key
  from pg_catalog.jsonb_array_elements(coalesce(nullif(p_plan -> 'afterSortKey', 'null'::jsonb), '[]'::jsonb))
    with ordinality as item(value, ordinality);
  if p_plan -> 'exactRecordIds' <> 'null'::jsonb then
    select pg_catalog.array_agg(item.value::uuid) into exact_record_ids
    from pg_catalog.jsonb_array_elements_text(p_plan -> 'exactRecordIds') as item(value);
  end if;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[]) into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(p_plan #> '{prepared,access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[]) into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(p_plan #> '{prepared,access,sharedRecordIds}') as item(value);
  select pg_catalog.array_agg(item.value) into segment_predicates
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'segmentPredicates') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into choice_option_values
  from pg_catalog.jsonb_array_elements_text(coalesce(p_member -> 'optionValues', '[]'::jsonb)) as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into group_by_ids
  from pg_catalog.jsonb_array_elements_text(coalesce(p_member -> 'groupByFieldIds', '[]'::jsonb)) as item(value);
  -- A later scan of the same invocation (the next narrowed board column) reuses the first scan's
  -- page decision exactly as one scan reuses it for its next candidates.
  if p_prior_decision is not null then
    page_eligibility_checked := (p_prior_decision ->> 'checked')::boolean;
    page_first_loaded := nullif(p_prior_decision -> 'firstLoaded', 'null'::jsonb);
    page_declaration := nullif(p_prior_decision -> 'declaration', 'null'::jsonb);
    page_eligibility := nullif(p_prior_decision -> 'eligibility', 'null'::jsonb);
    page_shared := nullif(p_prior_decision -> 'shared', 'null'::jsonb);
    page_narrowed := (p_prior_decision ->> 'narrowed')::boolean;
    validated_record_types := nullif(p_prior_decision -> 'validatedRecordTypes', 'null'::jsonb);
  end if;
  bucket_rows := pg_catalog.array_fill('[]'::jsonb, array[bucket_count]);
  bucket_capabilities := bucket_rows;
  bucket_counts := pg_catalog.array_fill(0, array[bucket_count]);
  bucket_more := pg_catalog.array_fill(false, array[bucket_count]);
  bucket_first_keys := pg_catalog.array_fill('null'::jsonb, array[bucket_count]);
  bucket_first_ids := pg_catalog.array_fill(null::uuid, array[bucket_count]);
  bucket_last_keys := bucket_first_keys;
  bucket_last_ids := bucket_first_ids;
  if projection_page_scan then
    projection_batch_size := least(page_size, scan_limit);
    begin
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
      into projection_batch
      from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
        null::uuid[], projection_sort_key, projection_direction, projection_after,
        projection_batch_size, projection_predicate) with ordinality as projected(organization_id,
        record_id, revision, attribute_values, ordinality);
    exception when sqlstate '22023' then
      get stacked diagnostics projection_failure = message_text;
      if projection_failure in ('filter_field_not_declared', 'predicate_unsupported') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', projection_failure);
      end if;
      raise;
    end;
  end if;
  foreach segment_sql in array segment_predicates loop
  loop
  if projection_page_scan then
    projection_candidate_count := projection_candidate_count + pg_catalog.jsonb_array_length(projection_batch);
    projection_reader_exhausted := pg_catalog.jsonb_array_length(projection_batch) < projection_batch_size;
    if pg_catalog.jsonb_array_length(projection_batch) = 0 then
      exit;
    end if;
    projection_last_record_id := (projection_batch -> -1 ->> 'record_id')::uuid;
    projection_last_sort_key := array[projection_batch -> -1 -> 'attribute_values' ->> projection_sort_key];
    projection_after := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(projection_last_sort_key),
      'phase', case when projection_last_sort_key[1] is null then 'null' else 'value' end,
      'recordId', projection_last_record_id);
    projection_batch_exhausted := projection_candidate_count >= scan_limit;
  end if;
  scan_sql := pg_catalog.format(
    'select stored.record_id,
       array[%s]::text[] as sort_key,
       pg_catalog.jsonb_build_object(%s) as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values,
       %s as projection_row,
       %s as group_link_value
     from %s
     where stored.organisation_id = $1
       and stored.lifecycle_state = ''active''
       and ($12::uuid[] is null or stored.record_id = any ($12))
       and %s
       and (%s)
        and (case when (%s) then true else false end)
        and (%s)%s
        and (%s)
     order by %s
     limit $5',
    p_plan ->> 'sortKeySql',
    p_plan ->> 'filterValuesSql',
    p_plan ->> 'systemColumnsSql',
    p_plan ->> 'scanProjectionSql',
    coalesce(p_member ->> 'linkValueSql', 'null::jsonb'),
    p_plan ->> 'scanSourceSql',
    case when p_plan #>> '{prepared,storage,storageScope}' = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    p_plan #>> '{prepared,access,predicate}',
    p_plan ->> 'filterPredicate',
    coalesce(p_member ->> 'predicate', 'true'),
    segment_sql,
    p_plan ->> 'searchPrefilterSql',
    p_plan ->> 'orderBySql'
  );
  -- A validated type set stays local to this invocation and is passed only to
  -- the fixed record adapter's private evaluator.
  open scan_cursor scroll for execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1, access_owner_account_id,
      access_owner_group_ids, access_shared_record_ids,
      p_plan -> 'filterParameters', coalesce(p_plan #> '{prepared,access,parameters}', '[]'::jsonb),
      projection_batch, exact_record_ids,
      p_member ->> 'columnValue', choice_option_values, group_selector_values, tree_parent_id,
      search_field_ids, user_search;
  cursor_position := 0;
  loop
    fetch scan_cursor into scan_record;
    exit when not found;
    cursor_position := cursor_position + 1;
    examined := examined + 1;
    if examined > scan_limit then
      budget_exhausted := true;
      exit;
    end if;
    -- The filter is evaluated on stored values first only to avoid reading
    -- rows it rejects; a row it admits is still read through the protected
    -- projection, and every filtered field must be readable there.
    -- A value the condition engine refuses decides nothing until the row is
    -- known to be readable, so an unreadable row can never cause a refusal.
    needs_refusal_check := false;
    -- Preparation has already validated the inputs. An exact SQL predicate
    -- has decided this condition over fields every candidate reader can see.
    if filter_condition is null or filter_exact then
      passes := true;
    else
      begin
        passes := vortex_access.evaluate_query_condition_internal(
          filter_condition, filter_types, scan_record.filter_values,
          parameter_types, parameter_values, false
        );
      exception when invalid_parameter_value then
        passes := true;
        needs_refusal_check := true;
      end;
    end if;
    if passes then
      page_access_loaded := null;
      if not page_eligibility_checked then
        -- Keep the reusable decision in this invocation; the request role cannot
        -- write it or pass it to the owner-only exact-record evaluator.
        page_eligibility_checked := true;
        -- The installation and its access plan are resolved once for the page;
        -- every exact record decision below consumes this local plan.
        page_shared := pg_catalog.jsonb_build_object(
          'installation', case when preview_mode
            then vortex_record.read_current_preview_installation_internal()
            else vortex_definition.read_current_active_installation() end);
        page_shared := page_shared || pg_catalog.jsonb_build_object('plan',
          vortex_record.resolve_installation_access_plan_internal(page_shared -> 'installation'));
        page_access_loaded := vortex_record.load_record_access_facts_with_plan_internal(
          record_type_id_value, 'read', scan_record.record_id, null,
          page_shared -> 'installation', page_shared -> 'plan', scan_record.projection_row
        );
        if page_access_loaded ->> 'outcome' = 'loaded'
          and pg_catalog.jsonb_typeof(page_access_loaded -> 'declaration') = 'object' then
          page_declaration := page_access_loaded -> 'declaration';
          if preview_mode then
            -- Owner authority and the exact storage binding were validated by
            -- preparation and the first loader in this invocation. Bounds are
            -- identical for every copied row of this record type.
            page_shared := page_shared || pg_catalog.jsonb_build_object(
              'previewBounds', vortex_record.preview_record_field_bounds_internal(
                record_type_id_value, v_storage_contract_id, p_plan -> 'recordType'));
          else
            page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
              page_declaration, vortex_access.validated_human_request_context(),
              pg_catalog.clock_timestamp()
            );
          end if;
          page_first_loaded := page_access_loaded;
          select page_shared || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
            page.narrowed
          into page_shared, page_narrowed
          from vortex_record.read_record_page_envelope_internal(record_type_id_value, page_first_loaded) as page;
        end if;
      end if;
      -- Decide this candidate and the page's next ones together in one set
      -- pass; the cursor returns to this row, so the scan order, budget and
      -- every later check stay those of the row-by-row walk.
      if page_batching and page_first_loaded is not null
        and not (scan_record.record_id = any (decided_ids)) then
        lookahead_ids := array[scan_record.record_id];
        while pg_catalog.cardinality(lookahead_ids) <= page_size loop
          fetch scan_cursor into lookahead_record;
          exit when not found;
          lookahead_ids := pg_catalog.array_append(lookahead_ids, lookahead_record.record_id);
        end loop;
        move absolute cursor_position from scan_cursor;
        select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
          pg_catalog.array_agg(decided.loaded), pg_catalog.array_agg(decided.decision),
          pg_catalog.array_agg(decided.bounds)
        into decided_ids, decided_loaded, decided_decisions, decided_bounds
        from vortex_record.read_record_page_decisions_internal(
          record_type_id_value, page_first_loaded, page_declaration, page_eligibility,
          lookahead_ids, page_shared -> 'envelope', page_narrowed
        ) as decided;
        page_batching := pg_catalog.cardinality(decided_ids) > 0;
      end if;
      -- The page's first record keeps the exact decision, which also validates
      -- the installation-wide facts every decided record shares.
      decided_index := case when page_access_loaded is null
        then pg_catalog.array_position(decided_ids, scan_record.record_id) end;
      select row_read.* into read_row
      from vortex_record.read_record_projection_with_validated_types_internal(
        record_type_id_value, scan_record.record_id, page_declaration, page_eligibility,
        validated_record_types, scan_record.projection_row,
        coalesce(decided_loaded[decided_index], page_access_loaded),
        decided_decisions[decided_index], decided_bounds[decided_index], page_shared
      ) as row_read;
      projection := read_row.projection;
      -- Only the exact evaluator validates record types for reuse.
      if validated_record_types is null and decided_index is null then
        validated_record_types := coalesce(
          read_row.read_facts -> 'validatedRecordTypes',
          case when projection ->> 'outcome' = 'allowed'
            then read_row.read_facts #> '{facts,recordTypes}' end
        );
      end if;
      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        if member_kind = 'tree_roots' then
          -- Root membership uses exact batched parent decisions, never the access superset.
          if not (scan_record.record_id = any (tree_root_child_ids)) then
            tree_root_child_ids := array[scan_record.record_id];
            while pg_catalog.cardinality(tree_root_child_ids) <= page_size loop
              fetch scan_cursor into lookahead_record;
              exit when not found;
              tree_root_child_ids := pg_catalog.array_append(tree_root_child_ids, lookahead_record.record_id);
            end loop;
            move absolute cursor_position from scan_cursor;
            tree_item := vortex_record.read_query_tree_relatives_internal(
              true, tree_root_child_ids, (p_member ->> 'relationshipId')::uuid, context_organization_id,
              context_application_root_id, storage_plan, record_type_id_value, page_first_loaded,
              page_declaration, page_eligibility, page_shared, page_narrowed, validated_record_types,
              p_member -> 'filter');
            if tree_item ->> 'outcome' <> 'completed' then return tree_item; end if;
            select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
            into tree_root_nonroot_ids
            from pg_catalog.jsonb_array_elements_text(tree_item -> 'recordIds') as item(value);
            select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
            into tree_root_readable_parent_ids
            from pg_catalog.jsonb_array_elements_text(tree_item -> 'readableParentRecordIds') as item(value);
          end if;
          if scan_record.record_id = any (tree_root_nonroot_ids) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          -- A readable parent outside the filter/search still keeps its link value.
          -- Only an unreadable or absent parent is hidden, using the same exact batch decision.
          if not (scan_record.record_id = any (tree_root_readable_parent_ids)) then
            readable_values := pg_catalog.jsonb_set(readable_values, array[tree_field_id], 'null'::jsonb);
          end if;
        end if;
        -- Filters decide membership, so every referenced value must be readable.
        -- Sorts only decide order: the scan already drops unguaranteed sort keys
        -- and ends with record identity. A withheld published sort field must
        -- neither remove a readable row nor expose its value through ordering.
        if not exists (
          select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
          where not (readable_values ? referenced.id)
        ) and not exists (
          select 1 from pg_catalog.unnest(search_field_ids) as searched(id)
          where projection_page_scan and user_search is not null
            and not (readable_values ? searched.id)
        ) then
          if needs_refusal_check then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end if;
          bucket := 1;
          if member_kind = 'choice' then
            -- A board row belongs to the column its readable choice value names, or to the
            -- unassigned column when it names no option. A column that already holds its page
            -- and the card after it does not read the row again.
            bucket := (
              select requested.ordinality::integer
              from pg_catalog.jsonb_array_elements(p_member -> 'columns') with ordinality
                as requested(value, ordinality)
              where case when (readable_values ? choice_field_id)
                  and pg_catalog.jsonb_typeof(readable_values -> choice_field_id) = 'string'
                  and (readable_values ->> choice_field_id) collate "C"
                    = any (choice_option_values)
                then requested.value ->> 'kind' = 'option'
                  and (requested.value ->> 'value') collate "C"
                    = (readable_values ->> choice_field_id) collate "C"
                else requested.value ->> 'kind' = 'unassigned' end
              limit 1
            );
            if bucket is null or bucket_more[bucket] then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          elsif member_kind = 'group' then
            member_matches := not exists (
              select 1 from pg_catalog.unnest(group_by_ids) as grouped(id)
              where not (readable_values ? grouped.id)
            );
            if member_matches and group_link_field_id is not null
              and group_selector_values -> group_link_field_id = '"not_available"'::jsonb then
              -- The group of unreadable targets: one protected title batch decides the targets of this
              -- row and the page's next candidates together; the cache holds each target once per call.
              if pg_catalog.jsonb_typeof(readable_values -> group_link_field_id) = 'object'
                and not (group_link_cache ? (readable_values -> group_link_field_id ->> 'recordId')) then
                group_link_values := array[readable_values -> group_link_field_id];
                while pg_catalog.cardinality(group_link_values) <= page_size loop
                  fetch scan_cursor into lookahead_record;
                  exit when not found;
                  group_link_values := pg_catalog.array_append(group_link_values, lookahead_record.group_link_value);
                end loop;
                move absolute cursor_position from scan_cursor;
                group_link_cache := vortex_record.group_link_unreadable_internal(
                  group_link_cache, group_link_values, fields_by_id -> group_link_field_id);
              end if;
              member_matches := coalesce(
                (group_link_cache ->> (readable_values -> group_link_field_id ->> 'recordId'))::boolean, false);
            elsif member_matches then
              select pg_catalog.jsonb_object_agg(grouped.id, vortex_record.grouping_value_internal(
                readable_values -> grouped.id, fields_by_id -> grouped.id ->> 'type', nullif(p_member -> 'dateBucket', 'null'::jsonb)
              ))
              into group_candidate_values
              from pg_catalog.unnest(group_by_ids) as grouped(id);
              member_matches := group_candidate_values = group_selector_values;
            end if;
            if not member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          elsif member_kind = 'tree_children' and not (
            pg_catalog.jsonb_typeof(readable_values -> tree_field_id) = 'object'
            and pg_catalog.lower(readable_values -> tree_field_id ->> 'recordId') = pg_catalog.lower(tree_parent_id::text)
          ) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          -- A search term matches only through a searchable field this row exposes
          -- to the reader; a field the reader cannot see never decides a match, so
          -- a hidden value can neither satisfy a search nor be inferred from one.
          -- Only a text or number value, or the text members of a list value, is
          -- searched; a structured value's JSON keys and identifiers never match.
          if user_search is not null and not projection_page_scan
            and not vortex_record.query_search_matches_internal(
            readable_values, search_field_ids, user_search
          ) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          if bucket_counts[bucket] = page_size then
            -- A full bucket with a matching row after it has more rows; the scan ends only when
            -- every bucket has.
            bucket_more[bucket] := true;
            if pg_catalog.array_position(bucket_more, false) is null then
              every_bucket_more := true;
              exit;
            end if;
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          if bucket_counts[bucket] = 0 then
            bucket_first_keys[bucket] := pg_catalog.to_jsonb(scan_record.sort_key);
            bucket_first_ids[bucket] := scan_record.record_id;
          end if;
          -- Keep the read facts and field bounds for one page-level capability
          -- decision after the readable page has been selected.
          bucket_capabilities[bucket] := bucket_capabilities[bucket] || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'recordId', scan_record.record_id, 'readBounds', read_row.read_bounds
            ) || case
              -- The page pass's compact record scope when it has one, also for
              -- the first record; its page-wide facts are the page envelope.
              when scan_record.record_id = any (decided_ids) then pg_catalog.jsonb_build_object('record',
                decided_loaded[pg_catalog.array_position(decided_ids, scan_record.record_id)])
              else pg_catalog.jsonb_build_object('readFacts', read_row.read_facts) end
          );
          bucket_rows[bucket] := bucket_rows[bucket] || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordId', scan_record.record_id,
            'revision', projection -> 'concurrencyNumber',
            'values', coalesce((
              select pg_catalog.jsonb_object_agg(requested.id, readable_values -> requested.id)
              from pg_catalog.unnest(requested_ids) as requested(id)
              where readable_values ? requested.id
            ), '{}'::jsonb)
          ) || case when pg_catalog.cardinality(system_field_keys) > 0
            then pg_catalog.jsonb_build_object('systemValues', scan_record.system_values)
            else '{}'::jsonb end);
          bucket_counts[bucket] := bucket_counts[bucket] + 1;
          bucket_last_keys[bucket] := pg_catalog.to_jsonb(scan_record.sort_key);
          bucket_last_ids[bucket] := scan_record.record_id;
        end if;
      end if;
    end if;
    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;
  close scan_cursor;
  exit when not projection_page_scan or every_bucket_more or projection_batch_exhausted
    or projection_reader_exhausted;
  projection_batch_size := least(page_size, scan_limit - projection_candidate_count);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
  into projection_batch
  from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
    null::uuid[], projection_sort_key, projection_direction, projection_after,
    projection_batch_size, projection_predicate) with ordinality as projected(organization_id,
    record_id, revision, attribute_values, ordinality);
  end loop;
  exit when every_bucket_more or budget_exhausted;
  end loop;
  if projection_batch_exhausted and not bucket_more[1] then
    budget_exhausted := true;
    last_examined_sort_key := projection_last_sort_key;
    last_examined_record_id := projection_last_record_id;
  end if;
  -- Each bucket's page: its rows with their capabilities, in one pass over the page, and its own
  -- continuations, never another bucket's.
  for bucket in 1 .. bucket_count loop
    rows_value := bucket_rows[bucket];
    if bucket_counts[bucket] > 0 then
      page_capabilities := vortex_record.read_record_capabilities_page_internal(
        record_type_id_value, bucket_capabilities[bucket], page_shared -> 'envelope'
      );
      if pg_catalog.jsonb_typeof(page_capabilities) is distinct from 'array'
        or pg_catalog.jsonb_array_length(page_capabilities) <> bucket_counts[bucket] then
        raise exception using errcode = '55000', message = 'Page capabilities are unavailable';
      end if;
      if exists (
        select 1 from pg_catalog.jsonb_array_elements(page_capabilities) as item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) then
        raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
      end if;
      select pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
          'capabilities', page_capabilities -> (item.ordinality::integer - 1)) order by item.ordinality)
      into rows_value
      from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
    end if;
    next_value := null;
    opposite_value := null;
    key_value := case when bucket_more[bucket] then bucket_last_keys[bucket]
      when budget_exhausted then pg_catalog.to_jsonb(last_examined_sort_key) end;
    if bucket_more[bucket] or budget_exhausted then
      next_value := pg_catalog.jsonb_build_object(
        'sort', p_plan -> 'cursorSort',
        'sortKey', key_value,
        'phase', case when pg_catalog.jsonb_array_length(key_value) > 0
          and key_value -> 0 = 'null'::jsonb then 'null' else 'value' end,
        'recordId', case when bucket_more[bucket] then bucket_last_ids[bucket]
          else last_examined_record_id end
      );
    end if;
    if bucket_first_ids[bucket] is not null then
      opposite_value := pg_catalog.jsonb_build_object(
        'sort', p_plan -> 'cursorSort',
        'sortKey', bucket_first_keys[bucket],
        'phase', case when pg_catalog.jsonb_array_length(bucket_first_keys[bucket]) > 0
          and bucket_first_keys[bucket] -> 0 = 'null'::jsonb then 'null' else 'value' end,
        'recordId', bucket_first_ids[bucket]
      );
    end if;
    if direction = 'backward' and bucket_counts[bucket] > 1 then
      select pg_catalog.jsonb_agg(item.value order by item.ordinality desc)
      into rows_value
      from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
    end if;
    pages := pages || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'rows', rows_value, 'next', next_value, 'opposite', opposite_value));
  end loop;
  -- The scanned pages and the one page decision a later scan or tree read of this invocation reuses.
  return pg_catalog.jsonb_build_object(
    'outcome', 'scanned',
    'pages', pages,
    'decision', pg_catalog.jsonb_build_object(
      'checked', page_eligibility_checked, 'firstLoaded', page_first_loaded, 'declaration', page_declaration,
      'eligibility', page_eligibility, 'shared', page_shared, 'narrowed', page_narrowed,
      'validatedRecordTypes', validated_record_types)
  );
end
$function$;

alter function vortex_record.module_query_scan_internal(jsonb,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_scan_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_scan_internal(jsonb,jsonb,jsonb) is
  'Adapter-only candidate scan of every Module query page read: runs the planned scan of one organisation''s active records (application scope, access predicate, pushed filter, the mode''s stored-value predicate, keyset segment, search pre-predicate) within a 500-candidate budget, decides each candidate through the exact read_record projection with batched page decisions, then admits it only when every filtered field is readable, the closed membership value matches its readable values (all rows, a board column classified from its readable choice value, a generic group equal to its typed selector, the children of one parent, or the roots, decided from exact batched parent reads) and the search matches a readable searchable field. It returns one page per bucket with per-row capabilities and its own keyset continuations, never a hidden value.';
