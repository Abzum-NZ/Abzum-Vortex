-- #574: Query system values and deadline freshness.
--
-- run_module_query gains two behaviours, both decided inside its existing
-- SECURITY DEFINER boundary and under the same organisation/row access checks:
--
-- 1. Declared system values. A request may name any of the five supported
--    Record system values (created-at, creator, changed-at, changer, owner).
--    Only the named values are selected from the row's own metadata, and only
--    for a row that already passed vortex_record.read_record. Undeclared system
--    values are never selected into the result; an unsupported or repeated key
--    refuses the request.
--
-- 2. Deadline freshness. A due deadline transition that the #48 protected
--    refresh has not yet applied leaves calculated values stale. That claim is
--    bound to the configured deadline worker's login role and initialises a
--    System context, so it cannot run inside a human request transaction and
--    is not called here. The Query instead never serves an observable stale
--    value: when the fields it filters, sorts or projects have a deadline
--    calculation anywhere in their recursive dependency closure, it checks
--    whether a due transition for such a calculation is unapplied on a record
--    the caller can read (with that calculation and its own dependencies), and
--    if so returns one neutral, retryable 'freshness_pending' refusal before
--    any row is scanned. Records the caller cannot read never influence the
--    outcome, and a query with no deadline-dependent field is never refused.
--    When more due rows exist than one request examines, it is refused rather
--    than served partially.
--
-- The signature changes, so the old function is dropped and no compatibility
-- overload remains. run_module_query is not rewritten in place by any later
-- migration; its live body is still patched rather than re-created, each edit
-- guarded to apply exactly once.
begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

do $migration$
declare
  live_definition text;
  patch_old text[];
  patch_new text[];
  patch_index integer;
  occurrences integer;
begin
  patch_old := array[
    $p$p_after jsonb)$p$,
    $p$next_value jsonb := null;$p$,
    $p$  -- The verified organisation and Application; never a caller value.$p$,
    $p$  for scan_record in execute scan_sql$p$,
    $p$as filter_values$p$,
    $p$    pg_catalog.array_to_string(filter_expressions, ', '),$p$,
    $p$row_count := row_count + 1;$p$
  ];
  patch_new := array[
    $p$p_after jsonb, p_requested_system_field_keys jsonb)$p$,
    $p$next_value jsonb := null;
  system_field_keys text[] := array[]::text[];
  system_key text;
  system_expressions text[] := array[]::text[];
  system_columns_sql text;
  due_limit constant integer := 100;
  type_catalogue jsonb;
  all_fields jsonb := '{}'::jsonb;
  closure_ids text[];
  closure_added text[];
  closure_pass integer := 0;
  deadline_ids text[] := array[]::text[];
  due_examined integer := 0;
  due_record record;
  due_projection jsonb;
  due_values jsonb;$p$,
    $p$  -- Declared system values: a closed set, each named at most once.
  if p_requested_system_field_keys is null then
    p_requested_system_field_keys := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_requested_system_field_keys) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_system_field_keys) > 5 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(p_requested_system_field_keys) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or (field_item #>> '{}') not in ('created_at', 'created_by', 'updated_at', 'updated_by', 'owner')
      or (field_item #>> '{}') = any (system_field_keys) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    system_field_keys := pg_catalog.array_append(system_field_keys, field_item #>> '{}');
  end loop;
  foreach system_key in array system_field_keys loop
    system_expressions := pg_catalog.array_append(system_expressions, pg_catalog.format('%L, %s', system_key,
      case system_key
        when 'created_at' then
          'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', stored.created_at), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))'
        when 'updated_at' then
          'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', stored.updated_at), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))'
        when 'created_by' then 'pg_catalog.to_jsonb(stored.created_by)'
        when 'updated_by' then 'pg_catalog.to_jsonb(stored.updated_by)'
        else
          'case when stored.owner_organisation_account_id is not null then pg_catalog.jsonb_build_object(''kind'', ''organization_account'', ''organizationAccountId'', stored.owner_organisation_account_id) when stored.owner_group_id is not null then pg_catalog.jsonb_build_object(''kind'', ''group'', ''groupId'', stored.owner_group_id) else ''null''::jsonb end'
      end));
  end loop;
  system_columns_sql := pg_catalog.array_to_string(system_expressions, ', ');

  -- The verified organisation and Application; never a caller value.$p$,
    $p$  -- Freshness. The recursive dependency closure of every field this query
  -- filters, sorts or projects, followed through calculation dependencies and
  -- relationship totals, decides whether a deadline calculation feeds it. A
  -- query that no deadline calculation feeds is never refused here.
  if exists (
    select 1
    from pg_catalog.unnest(sort_ids || filter_ids || requested_ids) as referenced(id)
    where fields_by_id -> referenced.id ->> 'type' in ('calculation', 'total')
  ) then
    type_catalogue := vortex_record.relationship_total_catalogue_internal();
    for field_item in
      select field.value
      from pg_catalog.jsonb_array_elements(type_catalogue -> 'recordTypes') as type_entry(value),
        pg_catalog.jsonb_array_elements(coalesce(type_entry.value -> 'fields', '[]'::jsonb)) as field(value)
    loop
      all_fields := all_fields || pg_catalog.jsonb_build_object(
        pg_catalog.lower(field_item ->> 'fieldId'), field_item
      );
    end loop;
    closure_ids := sort_ids || filter_ids || requested_ids;
    loop
      closure_pass := closure_pass + 1;
      if closure_pass > 64 then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      select coalesce(pg_catalog.array_agg(distinct dependency.id), array[]::text[])
      into closure_added
      from (
        select pg_catalog.lower(dep.value) as id
        from pg_catalog.unnest(closure_ids) as member(id),
          pg_catalog.jsonb_array_elements_text(
            case when all_fields -> member.id ->> 'type' = 'calculation'
              and pg_catalog.jsonb_typeof(all_fields -> member.id #> '{settings,dependencyFieldIds}') = 'array'
              then all_fields -> member.id #> '{settings,dependencyFieldIds}' else '[]'::jsonb end
          ) as dep(value)
        union
        select pg_catalog.lower(all_fields -> member.id #>> '{settings,fieldId}')
        from pg_catalog.unnest(closure_ids) as member(id)
        where all_fields -> member.id ->> 'type' = 'total'
          and all_fields -> member.id #>> '{settings,fieldId}' is not null
        union
        select pg_catalog.lower(referenced.value #>> '{}')
        from pg_catalog.unnest(closure_ids) as member(id),
          pg_catalog.jsonb_path_query(
            coalesce(all_fields -> member.id #> '{settings,filter}', 'null'::jsonb),
            'lax $.**?(@.source == "field").fieldId'
          ) as referenced(value)
        where all_fields -> member.id ->> 'type' = 'total'
      ) as dependency
      where dependency.id is not null and dependency.id <> all (closure_ids);
      exit when pg_catalog.cardinality(closure_added) = 0;
      closure_ids := closure_ids || closure_added;
    end loop;
    select coalesce(pg_catalog.array_agg(member.id), array[]::text[])
    into deadline_ids
    from pg_catalog.unnest(closure_ids) as member(id)
    where all_fields -> member.id ->> 'type' = 'calculation'
      and all_fields -> member.id #>> '{settings,expression,kind}' = 'deadline_passed';
  end if;

  -- A due transition for such a calculation that is unapplied on a record the
  -- caller can read, with that calculation and its own dependencies readable,
  -- makes every observable filter, order, page and projection stale.
  if pg_catalog.cardinality(deadline_ids) > 0 then
    for due_record in
      select due.record_type_id, due.record_id, due.deadline_calculation_field_id
      from vortex_record.record_deadline_due_metadata as due
      where due.organization_id = context_organization_id
        and due.transition_at <= pg_catalog.statement_timestamp()
        and due.deadline_calculation_field_id::text = any (deadline_ids)
        and (due.application_root_id is null or due.application_root_id = context_application_root_id)
      order by due.transition_at asc, due.record_id asc
      limit due_limit + 1
    loop
      due_examined := due_examined + 1;
      if due_examined > due_limit then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'freshness_pending');
      end if;
      due_projection := vortex_record.read_record(due_record.record_type_id, due_record.record_id);
      if due_projection ->> 'outcome' = 'allowed' then
        due_values := due_projection -> 'values';
        if due_values ? due_record.deadline_calculation_field_id::text
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements_text(
              coalesce(all_fields -> due_record.deadline_calculation_field_id::text
                #> '{settings,dependencyFieldIds}', '[]'::jsonb)
            ) as dep(value)
            where not (due_values ? pg_catalog.lower(dep.value))
          ) then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'freshness_pending');
        end if;
      end if;
    end loop;
  end if;

  for scan_record in execute scan_sql$p$,
    $p$as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values$p$,
    $p$    pg_catalog.array_to_string(filter_expressions, ', '),
    system_columns_sql,$p$,
    $p$row_count := row_count + 1;
          if pg_catalog.cardinality(system_field_keys) > 0 then
            rows_value := pg_catalog.jsonb_set(
              rows_value, array[(row_count - 1)::text, 'systemValues'], scan_record.system_values
            );
          end if;$p$
  ];

  live_definition := pg_catalog.pg_get_functiondef(
    'vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb)'::pg_catalog.regprocedure
  );
  live_definition := pg_catalog.replace(live_definition, E'\r\n', E'\n');

  for patch_index in 1 .. pg_catalog.cardinality(patch_old) loop
    occurrences := (
      pg_catalog.length(live_definition)
      - pg_catalog.length(pg_catalog.replace(live_definition, patch_old[patch_index], ''))
    ) / pg_catalog.length(patch_old[patch_index]);
    if occurrences <> 1 then
      raise exception using errcode = '55000',
        message = 'run_module_query live body does not match the expected text';
    end if;
    live_definition := pg_catalog.replace(live_definition, patch_old[patch_index], patch_new[patch_index]);
  end loop;

  drop function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb);
  execute live_definition;
end
$migration$;

revoke all on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb)
  to vortex_request;

comment on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb) is
  'One bounded keyset page of rows readable through read_record for one installed Module query, with only the declared Record system values, or one refusal before any row is exposed; refuses while a readable due deadline transition feeding the queried fields is unapplied.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
commit;
