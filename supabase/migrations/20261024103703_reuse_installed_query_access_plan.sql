-- Reuse the exact installed query pins and access metadata through preparation and row reads.
set local role vortex_record_adapter;

drop function vortex_record.plan_record_read_scan_internal(uuid);

CREATE OR REPLACE FUNCTION vortex_record.resolve_installed_module_query_internal(p_module_root_id uuid, p_query_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  installation jsonb;
  query_release_revision bigint;
  query_release_version text;
  query_contract_version text;
  query_content jsonb;
  query_item jsonb;
  type_module_root_id uuid;
  type_record_type_id uuid;
  type_release_revision bigint;
  type_content jsonb;
  record_type_item jsonb;
begin
  if p_module_root_id is null or p_module_root_id = nil_uuid
    or p_query_id is null or p_query_id = nil_uuid then
    return null;
  end if;

  installation := vortex_definition.read_current_active_installation();

  select (item.value ->> 'moduleReleaseRevision')::bigint
  into query_release_revision
  from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  where (item.value ->> 'moduleRootId')::uuid = p_module_root_id;
  if query_release_revision is null then
    return null;
  end if;

  select release.compilation_output #> '{canonical,content}',
    release.release_version, release.validation_contract_version
  into query_content, query_release_version, query_contract_version
  from vortex_definition.releases as release
  where release.root_id = p_module_root_id
    and release.release_revision = query_release_revision;
  if not found
    or query_contract_version <> all (vortex_definition.accepted_contract_version('module'))
    or pg_catalog.jsonb_typeof(query_content -> 'queries') is distinct from 'array' then
    return null;
  end if;

  select item.value into query_item
  from pg_catalog.jsonb_array_elements(query_content -> 'queries') as item(value)
  where pg_catalog.lower(item.value ->> 'queryId') = pg_catalog.lower(p_query_id::text)
  limit 1;
  -- No authored query has this identity: a record type of this Module, listed by its own.
  if query_item is null then
    select vortex_record.record_type_listing_query_internal(p_module_root_id, item.value)
    into query_item
    from pg_catalog.jsonb_array_elements(
      coalesce(query_content -> 'recordTypes', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_query_id::text)
    limit 1;
  end if;
  if query_item is null
    or query_item #>> '{recordType,state}' is distinct from 'resolved'
    or not coalesce(pg_catalog.pg_input_is_valid(query_item #>> '{recordType,moduleRootId}', 'uuid'), false)
    or not coalesce(pg_catalog.pg_input_is_valid(query_item #>> '{recordType,recordTypeId}', 'uuid'), false) then
    return null;
  end if;
  type_module_root_id := (query_item #>> '{recordType,moduleRootId}')::uuid;
  type_record_type_id := (query_item #>> '{recordType,recordTypeId}')::uuid;

  -- The record type may belong to a declared dependency; it must be bound to
  -- this same installation at its own pinned release.
  select (item.value ->> 'moduleReleaseRevision')::bigint
  into type_release_revision
  from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  where (item.value ->> 'moduleRootId')::uuid = type_module_root_id;
  if type_release_revision is null then
    return null;
  end if;

  if type_module_root_id = p_module_root_id then
    type_content := query_content;
  else
    select release.compilation_output #> '{canonical,content}'
    into type_content
    from vortex_definition.releases as release
    where release.root_id = type_module_root_id
      and release.release_revision = type_release_revision;
  end if;
  if pg_catalog.jsonb_typeof(type_content -> 'recordTypes') is distinct from 'array' then
    return null;
  end if;

  select item.value into record_type_item
  from pg_catalog.jsonb_array_elements(type_content -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(type_record_type_id::text)
  limit 1;
  if record_type_item is null
    or pg_catalog.jsonb_typeof(record_type_item -> 'fields') is distinct from 'array'
    or not coalesce(pg_catalog.pg_input_is_valid(record_type_item ->> 'storageContractId', 'uuid'), false) then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'installation', installation,
    'moduleReleaseRevision', query_release_revision,
    'moduleReleaseVersion', query_release_version,
    'query', query_item,
    'recordTypeId', type_record_type_id,
    'recordTypeModuleRootId', type_module_root_id,
    'recordType', record_type_item
  );
end
$$;
alter function vortex_record.resolve_installed_module_query_internal(uuid,uuid) owner to vortex_record_adapter;


COMMENT ON FUNCTION vortex_record.resolve_installed_module_query_internal(p_module_root_id uuid, p_query_id uuid) IS 'Private: the exact installed Module query and its record type, or null when either is unavailable to the current installation.';

REVOKE ALL ON FUNCTION vortex_record.resolve_installed_module_query_internal(p_module_root_id uuid, p_query_id uuid) FROM PUBLIC;

create or replace function vortex_record.plan_record_read_scan_internal(
  p_record_type_id uuid,
  p_installation jsonb
)
returns table (
  restricted boolean,
  owner_account_id uuid,
  owner_group_ids uuid[],
  shared_record_ids uuid[],
  readable_field_ids text[],
  access_predicate text,
  access_parameters jsonb,
  bound_field_ids text[],
  installation_access_plan jsonb
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  context_account_id uuid;
  plan jsonb;
  target_meta jsonb;
  declaration jsonb;
  field_bounds jsonb;
  ownership_mode text;
  access_routes record;
  alternative jsonb;
  route jsonb;
  route_terms text[];
  route_sql text;
  alternative_terms text[] := array[]::text[];
  condition_sql text;
  condition_entry jsonb;
  condition_params jsonb;
  condition_field_types jsonb;
  condition_field_columns jsonb;
  condition_field_database_types jsonb;
  condition_field_definitions jsonb;
  condition_parameter_types jsonb;
  condition_parameter_values jsonb;
  condition_referenced_ids text[];
  declared_condition_ids text[];
  field_item jsonb;
  declaration_item jsonb;
  binding_item jsonb;
  field_id text;
  field_kind text;
  semantic_type text;
  column_entry jsonb;
  database_value_type text;
  parameter_offset integer;
  supported boolean;
  compiled jsonb;
  readable_field_ids_value text[];
  access_parameters_accum jsonb := '[]'::jsonb;
  access_predicate_value text := 'true';
  access_parameters_value jsonb := '[]'::jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  -- Narrowing only. A refusal or unsupported condition named below leaves the
  -- scan less selective, so the exact per-row decision is still what decides
  -- what a caller reads. Any other failure propagates with its cause: it is
  -- never turned into an unrestricted scan.
  if p_record_type_id is null or p_record_type_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not (context_value ? 'applicationRootId') then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;

  plan := vortex_record.resolve_installation_access_plan_internal(
    p_installation
  );
  if (plan ->> 'organizationId')::uuid is distinct from context_organization_id
    or (plan ->> 'applicationRootId')::uuid is distinct from context_application_root_id then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  target_meta := plan -> 'recordTypes' -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  ownership_mode := target_meta ->> 'ownershipMode';

  -- The declaration the record loader builds for a read.
  declaration := vortex_record.record_type_read_declaration_internal(
    plan, p_record_type_id, context_application_root_id
  );
  if declaration is null then
    return query select false, null::uuid, array[]::uuid[], array[]::uuid[],
      array[]::text[], 'false'::text, '[]'::jsonb, array[]::text[], plan;
    return;
  end if;

  -- The owner, owner-group and direct-share routes the scan can narrow, and the
  -- eligible alternatives reduced to their route lists and saved-condition
  -- envelopes. A null alternative list means no narrowing is possible.
  select routes.* into access_routes
  from vortex_access.resolve_record_read_scan_routes_internal(
    declaration, ownership_mode
  ) as routes;

  -- The fields this reader is guaranteed to see on every record the read
  -- decision admits, after the field-read decision for produced fields. A
  -- refused access context yields no fields, so the scan pushes neither an
  -- order nor a filter on a value it cannot prove is visible; any other
  -- failure propagates.
  field_bounds := vortex_record.decide_record_type_read_bounds_internal(
    plan, p_record_type_id, '[]'::jsonb
  );

  -- Those fields may drive the scan only when every row the scan examines is a
  -- row the exact decision admits: an unconditioned all-records alternative
  -- admits every active record, and a restricted plan examines only owned and
  -- directly shared records, which its routes admit unless a saved condition
  -- narrows them. Otherwise the scan also examines rows the reader cannot read,
  -- whose every value is hidden, so no field is readable for the scan.
  readable_field_ids_value := case
    when (field_bounds -> 'coversAllRecords') = 'true'::jsonb
      or (access_routes.restricted and (field_bounds -> 'conditionFree') = 'true'::jsonb)
    then coalesce(
      (
        select pg_catalog.array_agg(field.value order by field.value)
        from pg_catalog.jsonb_array_elements_text(
          field_bounds -> 'readableFieldIds'
        ) as field(value)
      ),
      array[]::text[]
    )
    else array[]::text[]
  end;

  -- Access routes with an exact table form narrow the candidate rows here so a
  -- reader limited to some records still gets full pages from a large table.
  -- Every eligible alternative contributes one term: its route's exact stored
  -- predicate (or true when the route has no exact form) AND its saved
  -- condition compiled into the same scan. The terms are OR-ed deliberately:
  -- the exact decision admits a record through any one alternative, so the
  -- scan must keep every row any of them admits. The result only removes rows
  -- the exact per-row decision below would refuse; every row the scan returns
  -- still goes through read_record, so it cannot widen a result.
  if access_routes.alternatives is null
    or pg_catalog.jsonb_typeof(access_routes.alternatives) is distinct from 'array' then
    access_predicate_value := 'true';
  elsif pg_catalog.jsonb_array_length(access_routes.alternatives) = 0 then
    -- No eligible alternative admits any record.
    access_predicate_value := 'false';
  else
    for alternative in
      select item.value
      from pg_catalog.jsonb_array_elements(access_routes.alternatives) as item(value)
    loop
      route_terms := array[]::text[];
      for route in
        select item.value
        from pg_catalog.jsonb_array_elements(alternative -> 'routes') as item(value)
      loop
        case route ->> 'kind'
          when 'ownership' then
            if ownership_mode = 'organization_account' then
              route_terms := pg_catalog.array_append(
                route_terms, 'stored.owner_organisation_account_id = $6');
            elsif ownership_mode = 'group' then
              route_terms := pg_catalog.array_append(
                route_terms, 'stored.owner_group_id = any ($7)');
            else
              -- Inherited ownership is reached only by a current-edge chase.
              route_terms := pg_catalog.array_append(route_terms, 'true');
            end if;
          when 'direct_share' then
            if access_routes.shared_record_ids is null then
              -- More current shares than one query carries: not narrowed.
              route_terms := pg_catalog.array_append(route_terms, 'true');
            else
              route_terms := pg_catalog.array_append(
                route_terms, 'stored.record_id = any ($8)');
            end if;
          else
            -- all_records admits every record; a relationship route is a
            -- current-edge chase. Neither has an exact stored predicate.
            route_terms := pg_catalog.array_append(route_terms, 'true');
        end case;
      end loop;

      if pg_catalog.cardinality(route_terms) = 0 then
        route_sql := 'false';
      elsif 'true' = any (route_terms) then
        route_sql := 'true';
      else
        route_sql := '(' || pg_catalog.array_to_string(route_terms, ' or ') || ')';
      end if;

      -- A saved condition narrows every route of its alternative, including an
      -- all-records route. It is compiled with the exact-semantics type map and
      -- the alternative's own bound parameters; anything the compiler cannot
      -- express exactly is left as true, so the per-row decision still decides.
      condition_sql := null;
      condition_params := '[]'::jsonb;
      if alternative ? 'savedCondition'
        and pg_catalog.jsonb_typeof(alternative -> 'savedCondition') = 'object' then
        condition_entry := null;
        select entry.value into condition_entry
        from pg_catalog.jsonb_array_elements(plan -> 'sharingConditions') as entry(value)
        where (entry.value ->> 'conditionId')
            = (alternative -> 'savedCondition' ->> 'conditionId')
          and (entry.value ->> 'publishedRevision')::numeric
            = (alternative -> 'savedCondition' ->> 'publishedRevision')::numeric
          and (entry.value ->> 'contractFingerprint')
            = (alternative -> 'savedCondition' ->> 'contractFingerprint')
          and pg_catalog.lower(entry.value ->> 'sourceRecordTypeId')
            = pg_catalog.lower(p_record_type_id::text)
        limit 1;

        if condition_entry is not null then
          condition_field_types := '{}'::jsonb;
          condition_field_columns := '{}'::jsonb;
          condition_field_database_types := '{}'::jsonb;
          condition_field_definitions := '{}'::jsonb;
          for field_item in
            select item.value
            from pg_catalog.jsonb_array_elements(target_meta -> 'fields') as item(value)
          loop
            field_id := pg_catalog.lower(field_item ->> 'fieldId');
            column_entry := target_meta -> 'columns' -> field_id;
            if column_entry is not null then
              field_kind := field_item ->> 'type';
              -- Calculation and total fields have no fixed stored value here and stay
              -- out of the map, as do kinds the mapping does not know.
              semantic_type := case when field_kind in ('calculation', 'total') then null
                else vortex_access.condition_field_type_internal(field_item) end;
              if semantic_type is not null then
                condition_field_types := condition_field_types
                  || pg_catalog.jsonb_build_object(field_id, semantic_type);
                condition_field_columns := condition_field_columns
                  || pg_catalog.jsonb_build_object(field_id, column_entry ->> 'token');
                condition_field_database_types := condition_field_database_types
                  || pg_catalog.jsonb_build_object(field_id, column_entry ->> 'databaseValueType');
                condition_field_definitions := condition_field_definitions
                  || pg_catalog.jsonb_build_object(
                    field_id, pg_catalog.jsonb_build_object('filterable', true, 'type', field_kind));
              end if;
            end if;
          end loop;

          select coalesce(
            pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
          into condition_referenced_ids
          from pg_catalog.jsonb_path_query(
            condition_entry -> 'condition', 'lax $.**?(@.source == "field").fieldId'
          ) as referenced(value);
          select coalesce(
            pg_catalog.array_agg(pg_catalog.lower(declared.value #>> '{}')), array[]::text[])
          into declared_condition_ids
          from pg_catalog.jsonb_array_elements(
            condition_entry -> 'declaredFieldIds'
          ) as declared(value);

          supported := true;
          foreach field_id in array condition_referenced_ids loop
            field_id := pg_catalog.lower(field_id);
            if not (condition_field_types ? field_id)
              or not (condition_field_columns ? field_id)
              or not (condition_field_database_types ? field_id)
              or not (field_id = any (declared_condition_ids)) then
              supported := false;
              exit;
            end if;
            semantic_type := condition_field_types ->> field_id;
            database_value_type := condition_field_database_types ->> field_id;
            if not (
              (semantic_type = 'yes_no' and database_value_type = 'boolean')
              or (semantic_type = 'text' and database_value_type in ('text', 'json'))
              or (semantic_type = 'text_collection' and database_value_type = 'json')
              or (semantic_type = 'opaque_json' and database_value_type = 'json')
              or (semantic_type = 'money' and database_value_type = 'json')
              or (semantic_type = 'decimal_number' and database_value_type = 'decimal')
              or (semantic_type = 'whole_number' and database_value_type = 'integer')
              or (semantic_type = 'date' and database_value_type = 'date')
              or (semantic_type = 'date_time' and database_value_type = 'timestamp_with_time_zone')
            ) then
              supported := false;
              exit;
            end if;
          end loop;

          if supported then
            condition_parameter_types := '{}'::jsonb;
            condition_parameter_values := '{}'::jsonb;
            for declaration_item in
              select item.value
              from pg_catalog.jsonb_array_elements(condition_entry -> 'parameters') as item(value)
            loop
              condition_parameter_types := condition_parameter_types
                || pg_catalog.jsonb_build_object(
                  declaration_item ->> 'key', declaration_item ->> 'type');
            end loop;
            for binding_item in
              select item.value
              from pg_catalog.jsonb_array_elements(
                alternative -> 'savedCondition' -> 'parameterBindings'
              ) as item(value)
            loop
              if binding_item ->> 'source' = 'current_organization_account_id' then
                condition_parameter_values := condition_parameter_values
                  || pg_catalog.jsonb_build_object(
                    binding_item ->> 'key', context_account_id::text);
              elsif binding_item ->> 'source' = 'literal' then
                condition_parameter_values := condition_parameter_values
                  || pg_catalog.jsonb_build_object(
                    binding_item ->> 'key', binding_item -> 'value');
              else
                supported := false;
                exit;
              end if;
            end loop;
          end if;

          if supported then
            parameter_offset := pg_catalog.jsonb_array_length(access_parameters_accum);
            begin
              compiled := vortex_record.compile_query_filter_internal(
                condition_entry -> 'condition',
                condition_field_types,
                condition_field_columns,
                condition_field_database_types,
                condition_field_definitions,
                '{}'::jsonb,
                condition_parameter_types,
                condition_parameter_values,
                10,
                parameter_offset
              );
              condition_sql := compiled ->> 'predicate';
              condition_params := coalesce(compiled -> 'parameters', '[]'::jsonb);
            exception
              -- 22023 is the compiler's refusal of a condition it cannot express
              -- exactly; the condition is then left as true. Any other failure
              -- propagates.
              when sqlstate '22023' then
                get stacked diagnostics failure_sqlstate = returned_sqlstate,
                  failure_message = message_text;
                raise warning 'Record read scan condition was not pushed: SQLSTATE %, %',
                  failure_sqlstate, failure_message;
                condition_sql := null;
                condition_params := '[]'::jsonb;
            end;
          end if;

          -- Keep every compiled parameter even when nothing was pushed, so the
          -- next alternative's offsets stay aligned with the JSON array passed
          -- to the scan.
          access_parameters_accum := access_parameters_accum || condition_params;
        end if;
      end if;

      if condition_sql is null then
        alternative_terms := pg_catalog.array_append(alternative_terms, route_sql);
      elsif route_sql = 'true' then
        alternative_terms := pg_catalog.array_append(alternative_terms, condition_sql);
      else
        alternative_terms := pg_catalog.array_append(
          alternative_terms, '(' || route_sql || ' and ' || condition_sql || ')');
      end if;
    end loop;

    if 'true' = any (alternative_terms) then
      access_predicate_value := 'true';
      access_parameters_value := '[]'::jsonb;
    else
      access_predicate_value := '('
        || pg_catalog.array_to_string(alternative_terms, ' or ') || ')';
      access_parameters_value := access_parameters_accum;
    end if;
  end if;

  return query select
    access_routes.restricted,
    access_routes.owner_account_id,
    access_routes.owner_group_ids,
    access_routes.shared_record_ids,
    readable_field_ids_value,
    access_predicate_value,
    access_parameters_value,
    coalesce(
      (
        select pg_catalog.array_agg(field.value order by field.value)
        from pg_catalog.jsonb_array_elements_text(
          field_bounds -> 'readableFieldIds'
        ) as field(value)
      ),
      array[]::text[]
    ),
    plan;
  return;
end
$function$;

alter function vortex_record.plan_record_read_scan_internal(uuid, jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.plan_record_read_scan_internal(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.plan_record_read_scan_internal(uuid, jsonb) to vortex_owner;

comment on function vortex_record.plan_record_read_scan_internal(uuid, jsonb) is
  'Private read-scan narrowing for the record query: builds the read declaration for one record type of the exact active installation and returns the owner account, owner groups and directly shared record identifiers a caller can be admitted through, the fields every eligible read alternative is guaranteed to expose, kept only when every row the scan examines is one the exact decision admits, the same guaranteed fields unconditionally as the reader''s current field bound (what a list may offer to filter, search or sort by), and one scan predicate that OR-s every eligible alternative''s exact route test with its saved condition compiled into the same scan; any route without an exact stored predicate or any condition the compiler cannot express as a superset is left unrestricted or true, so the per-row decision remains the only thing that decides access.';

create or replace function vortex_record.prepare_module_query_internal(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_user_filter jsonb,
  p_declared_filterable_field_ids jsonb,
  p_stage text default 'complete',
  p_prior_plan jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  trivial_condition constant jsonb :=
    '{"kind":"comparison","operator":"is_empty","left":{"source":"value","value":null}}'::jsonb;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  semantic_type text;
  filter_condition jsonb;
  filter_exact boolean := false;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_field_columns jsonb := '{}'::jsonb;
  filter_field_database_types jsonb := '{}'::jsonb;
  filter_read_time_expressions jsonb := '{}'::jsonb;
  filter_plan jsonb;
  filter_predicate text;
  filter_parameters jsonb := '[]'::jsonb;
  user_filter jsonb;
  user_filter_ids text[] := array[]::text[];
  input_item jsonb;
  input_key text;
  input_value jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  access_plan record;
  readable_field_ids text[] := array[]::text[];
  declared_filterable_ids text[] := array[]::text[];
  parsed_ids text[] := array[]::text[];
  filterable_item jsonb;
  prepared_plan jsonb;
  preview_address text;
  preview_context jsonb;
  preview_installation_id uuid;
  preview_candidate_revision bigint;
  preview_candidate_revision_text text;
  preview_storage_contract_id uuid;
  preview_field_bounds jsonb;
  preview_field_mappings jsonb := '{}'::jsonb;
  preview_mode boolean := false;
  failure_sqlstate text;
  failure_message text;
begin
  if p_stage not in ('resolution', 'storage', 'complete') then
    raise exception using errcode = '22023', message = 'Invalid query preparation stage';
  end if;
  preview_address := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  preview_mode := preview_address is not null;
  if preview_mode then
    begin
      preview_context := vortex_record.read_current_preview_installation_internal();
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview installation): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
    preview_candidate_revision_text := preview_context ->> 'applicationReleaseRevision';
    if preview_context is null
      or pg_catalog.jsonb_typeof(preview_context) is distinct from 'object'
      or preview_context ? 'outcome'
      or not vortex_platform.is_non_nil_uuid(preview_context ->> 'previewInstallationId')
      or not coalesce(pg_catalog.pg_input_is_valid(preview_candidate_revision_text, 'bigint'), false) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
    preview_installation_id := (preview_context ->> 'previewInstallationId')::uuid;
    preview_candidate_revision := preview_candidate_revision_text::bigint;
    if preview_candidate_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  end if;
  if p_prior_plan is not null then
    prepared_plan := p_prior_plan;
    -- A plan for a system projection is a live plan, in a preview too: see below.
    if preview_mode and not (prepared_plan ? 'preview')
      and prepared_plan -> 'recordType' ? 'systemProjection' then
      preview_mode := false;
    end if;
    if preview_mode then
      if pg_catalog.jsonb_typeof(prepared_plan) is distinct from 'object'
        or prepared_plan ->> 'outcome' is distinct from 'prepared'
        or not (prepared_plan ? 'preview') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      begin
        context_value := vortex_access.validated_human_request_context();
        resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
      exception
        -- A refused access context or a stale preview is the expected refusal; any
        -- other failure is logged with its cause before the same safe refusal.
        when sqlstate '42501' or sqlstate '40001' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        when others then
          get stacked diagnostics failure_sqlstate = returned_sqlstate,
            failure_message = message_text;
          raise warning 'Query preview preparation failed (preview context): SQLSTATE %, %',
            failure_sqlstate, failure_message;
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end;
      if context_value is null or not (context_value ? 'applicationRootId') or resolved is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      context_organization_id := (context_value ->> 'organizationId')::uuid;
      context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
      if p_expected_release_revision is not null
        and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
      end if;
      if preview_context ->> 'organizationId' is distinct from context_organization_id::text
        or preview_context ->> 'applicationRootId' is distinct from context_application_root_id::text
        or prepared_plan #>> '{scope,organizationId}' is distinct from context_organization_id::text
        or prepared_plan #>> '{scope,applicationRootId}' is distinct from context_application_root_id::text
        or prepared_plan -> 'preview' is distinct from pg_catalog.jsonb_build_object(
          'previewInstallationId', preview_installation_id,
          'candidateRevision', preview_candidate_revision
        )
        or prepared_plan -> 'resolved' is distinct from resolved
        or prepared_plan -> 'query' is distinct from resolved -> 'query'
        or prepared_plan -> 'recordType' is distinct from resolved -> 'recordType'
        or prepared_plan ->> 'recordTypeId' is distinct from resolved ->> 'recordTypeId' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'resolved', resolved,
        'query', resolved -> 'query',
        'recordType', resolved -> 'recordType',
        'recordTypeId', resolved -> 'recordTypeId',
        'scope', pg_catalog.jsonb_build_object(
          'organizationId', context_organization_id,
          'applicationRootId', context_application_root_id
        )
      );
      -- A previous stage's physical tokens and field bounds are reusable only
      -- after this invocation re-reads the exact preview catalogue and bounds.
      prepared_plan := prepared_plan - 'storage' - 'readableFieldIds' - 'fieldBoundIds' - 'access'
        - 'filterFieldIds' - 'filter';
    elsif prepared_plan ? 'preview' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    else
      resolved := prepared_plan -> 'resolved';
      context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
      context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;
    end if;
    user_filter := prepared_plan -> 'userFilter';
    if user_filter = 'null'::jsonb then
      user_filter := null;
    end if;
    select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
    into declared_filterable_ids
    from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'declaredFilterableIds') as item(value);
  else
  if p_input_values is null or pg_catalog.jsonb_typeof(p_input_values) <> 'object'
    or (p_expected_release_revision is not null
      and p_expected_release_revision not between 1 and 9007199254740991) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_declared_filterable_field_ids is null then
    p_declared_filterable_field_ids := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_declared_filterable_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_declared_filterable_field_ids) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for filterable_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_declared_filterable_field_ids) as item(value)
  loop
    if pg_catalog.jsonb_typeof(filterable_item) <> 'string'
      or pg_catalog.lower(filterable_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(filterable_item #>> '{}') = any (parsed_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(filterable_item #>> '{}'));
  end loop;
  declared_filterable_ids := parsed_ids;

  if p_user_filter = 'null'::jsonb then
    p_user_filter := null;
  end if;
  if p_user_filter is not null
    and pg_catalog.jsonb_typeof(p_user_filter) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_filter := p_user_filter;
  -- The verified organisation and Application; never a caller value.
  if preview_mode then
    begin
      context_value := vortex_access.validated_human_request_context();
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview context): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
    if context_value is null or not (context_value ? 'applicationRootId') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  else
    context_value := vortex_access.validated_human_request_context();
    if not (context_value ? 'applicationRootId') then
      raise exception using errcode = '42501', message = 'Query requires an application context';
    end if;
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  if preview_mode and (
    preview_context ->> 'organizationId' is distinct from context_organization_id::text
    or preview_context ->> 'applicationRootId' is distinct from context_application_root_id::text
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;

  if preview_mode then
    begin
      resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
      -- A system projection has no preview copy: it is the platform's live read model, which a
      -- preview reads on the live path, under the reader's own live access and never under the
      -- preview's roles.
      if resolved is null then
        resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
        if resolved -> 'recordType' ? 'systemProjection' then
          preview_mode := false;
        else
          resolved := null;
        end if;
      end if;
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview query): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
  else
    resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
  end if;
  if resolved is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  if p_expected_release_revision is not null
    and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
  end if;
  -- A query of a Module this Application only uses is read only when that Module exposes it,
  -- the same rule the Studio picker, the draft compile and publication apply; a release that
  -- names a private or older query of another Application's Module reads nothing. A record
  -- type's own listing carries its record type's identity and follows record access instead.
  if pg_catalog.lower(resolved #>> '{query,queryId}')
      is distinct from pg_catalog.lower(resolved #>> '{query,recordType,recordTypeId}')
    and resolved #>> '{query,exposure}' is distinct from 'exposed'
    and not exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = p_module_root_id
        and root.kind = 'module'
        and root.owner_application_root_id = context_application_root_id
    ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  end if;
  query_item := resolved -> 'query';
  record_type_item := resolved -> 'recordType';
  record_type_id_value := (resolved ->> 'recordTypeId')::uuid;
  -- A preview reads its copy of the records with their stored totals and calculations; a system
  -- projection is read only through its protected reader, never from a preview.
  if preview_mode and record_type_item ? 'systemProjection' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if prepared_plan is null then
    prepared_plan := pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'resolved', resolved,
      'query', query_item,
      'recordType', record_type_item,
      'recordTypeId', record_type_id_value,
      'userFilter', user_filter,
      'declaredFilterableIds', pg_catalog.to_jsonb(declared_filterable_ids),
      'scope', pg_catalog.jsonb_build_object(
        'organizationId', context_organization_id,
        'applicationRootId', context_application_root_id
      )
    );
    if preview_mode then
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'preview', pg_catalog.jsonb_build_object(
          'previewInstallationId', preview_installation_id,
          'candidateRevision', preview_candidate_revision
        )
      );
    end if;
  end if;
  if p_stage = 'resolution' then
    return prepared_plan;
  end if;

  if prepared_plan ? 'storage' and not preview_mode then
    catalogue_row.storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
    select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
    into readable_field_ids
    from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);
  else
    if preview_mode then
      preview_storage_contract_id := (resolved ->> 'previewStorageContractId')::uuid;
      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = preview_storage_contract_id;
      if not found
        or catalogue_row.state is distinct from 'active'
        or catalogue_row.physical_schema_token is distinct from 'record_data'
        or catalogue_row.module_root_id is distinct from (resolved ->> 'recordTypeModuleRootId')::uuid
        or catalogue_row.record_type_id is distinct from record_type_id_value
        or catalogue_row.storage_scope is distinct from (resolved ->> 'storageScope')
        or catalogue_row.first_compatible_release_revision is distinct from
          (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        or catalogue_row.last_compatible_release_revision is distinct from
          (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        or catalogue_row.record_type_definition ->> 'storageContractId'
          is distinct from preview_storage_contract_id::text
        or pg_catalog.lower(catalogue_row.record_type_definition ->> 'recordTypeId')
          is distinct from record_type_id_value::text
        or catalogue_row.record_type_definition ->> 'storageScope'
          is distinct from (resolved ->> 'storageScope') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;

      preview_field_bounds := vortex_record.preview_record_field_bounds_internal(
        record_type_id_value, preview_storage_contract_id, record_type_item
      );
      if preview_field_bounds is null
        or pg_catalog.jsonb_typeof(preview_field_bounds -> 'readableFieldIds') is distinct from 'array' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
        where not exists (
          select 1
          from vortex_record.field_storage_mappings as mapping
          where mapping.storage_contract_id = preview_storage_contract_id
            and mapping.field_id = pg_catalog.lower(field.value ->> 'fieldId')::uuid
            and mapping.state is not distinct from 'active'
            and mapping.field_definition is not distinct from field.value
            and mapping.physical_column_token is not distinct from
              ('f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''))
            and mapping.database_value_type is not distinct from
              vortex_record.database_value_type(field.value)
            and mapping.introduced_by_module_root_id is not distinct from
              (resolved ->> 'recordTypeModuleRootId')::uuid
            and mapping.introduced_at_release_revision is not distinct from
              (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        )
      ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.lower(field.value ->> 'fieldId'),
        pg_catalog.to_jsonb(mapping)
        order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      ), '{}'::jsonb)
      into preview_field_mappings
      from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
      join vortex_record.field_storage_mappings as mapping
        on mapping.storage_contract_id = preview_storage_contract_id
        and mapping.field_id = pg_catalog.lower(field.value ->> 'fieldId')::uuid
        and mapping.state is not distinct from 'active';
      if prepared_plan ? 'fieldMappings'
        and prepared_plan -> 'fieldMappings' is distinct from preview_field_mappings then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;

      -- A record type of a Module the previewed Application only uses is shared data: the preview
      -- takes the same read plan decision as the installed path, in the preview's registration,
      -- where that Module's own permissions follow the builder's live access. No eligible read
      -- alternative is the same refusal, never an empty preview table. A row the RLS policy does
      -- not show counts as used, so the decision is never skipped.
      if not exists (
        select 1
        from vortex_definition.roots as root
        where root.root_id = (resolved ->> 'recordTypeModuleRootId')::uuid
          and root.kind = 'module'
          and root.owner_application_root_id = context_application_root_id
      ) then
        begin
          select plan.* into access_plan
          from vortex_record.plan_record_read_scan_internal(
            record_type_id_value, vortex_definition.read_current_active_installation()
          ) as plan;
        exception
          -- A refused access context or a stale preview is the expected refusal; any
          -- other failure is logged with its cause before the same safe refusal.
          when sqlstate '42501' or sqlstate '40001' then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
          when others then
            get stacked diagnostics failure_sqlstate = returned_sqlstate,
              failure_message = message_text;
            raise warning 'Query preview preparation failed (read plan): SQLSTATE %, %',
              failure_sqlstate, failure_message;
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end;
        if access_plan.access_predicate is null then
          raise warning 'Query preview preparation failed (read plan): no access predicate';
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end if;
        if access_plan.access_predicate = 'false' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'read_forbidden');
        end if;
      end if;

      for field_item in
        select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), field_item
        );
      end loop;
      select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
      into readable_field_ids
      from pg_catalog.jsonb_array_elements_text(preview_field_bounds -> 'readableFieldIds') as item(value);
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'storage', pg_catalog.jsonb_build_object(
          'storageContractId', catalogue_row.storage_contract_id,
          'storageScope', catalogue_row.storage_scope,
          'moduleRootId', catalogue_row.module_root_id,
          'recordTypeId', catalogue_row.record_type_id,
          'physicalSchemaToken', catalogue_row.physical_schema_token,
          'physicalTableToken', catalogue_row.physical_table_token,
          'protectedReadModelKey', catalogue_row.protected_read_model_key
        ),
        'fieldMappings', preview_field_mappings,
        'readableFieldIds', pg_catalog.to_jsonb(readable_field_ids),
        -- The builder's preview field bounds are also the bound a list offers its controls by.
        'fieldBoundIds', pg_catalog.to_jsonb(readable_field_ids),
        'access', pg_catalog.jsonb_build_object(
          'predicate', 'true',
          'parameters', '[]'::jsonb,
          'ownerAccountId', null,
          'ownerGroupIds', '[]'::jsonb,
          'sharedRecordIds', '[]'::jsonb
        )
      );
    else
      -- The installed physical table for this exact record type.
      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = (record_type_item ->> 'storageContractId')::uuid;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> (resolved ->> 'recordTypeModuleRootId')::uuid
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token not in ('record_data', 'system_projection')
        or (catalogue_row.physical_schema_token = 'system_projection')
          is distinct from (record_type_item ? 'systemProjection')
        or (catalogue_row.physical_schema_token = 'system_projection'
          and catalogue_row.protected_read_model_key
            is distinct from (record_type_item #>> '{systemProjection,protectedView}')) then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;

      for field_item in
        select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), field_item
        );
      end loop;

      -- The read-scan plan. Its access routes narrow candidate rows before the
      -- budget is spent; its readable fields are the fields this reader is
      -- guaranteed to see on every row the scan examines, and none when the scan
      -- can examine a row the reader cannot read. Only those fields may drive the
      -- scan order, the pushed filter or the keyset cursor, because any other
      -- field could be withheld and its value must not influence which rows are
      -- examined. A planning failure propagates; it never widens the scan.
      select plan.* into access_plan
      from vortex_record.plan_record_read_scan_internal(
        record_type_id_value, resolved -> 'installation'
      ) as plan;
      -- No eligible read alternative admits any record. Report a refusal before
      -- an empty scan can be mistaken for an empty query result.
      if access_plan.access_predicate = 'false' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'read_forbidden');
      end if;
      readable_field_ids := coalesce(access_plan.readable_field_ids, array[]::text[]);
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        -- These private values came from the installed-query resolver and the
        -- read-scan planner in this invocation. Row reads reuse their exact pins
        -- and type metadata without resolving the same installation again.
        'pageAccess', pg_catalog.jsonb_build_object(
          'installation', resolved -> 'installation',
          'plan', access_plan.installation_access_plan
        ),
        'storage', pg_catalog.jsonb_build_object(
          'storageContractId', catalogue_row.storage_contract_id,
          'storageScope', catalogue_row.storage_scope,
          'moduleRootId', catalogue_row.module_root_id,
          'recordTypeId', catalogue_row.record_type_id,
          'physicalSchemaToken', catalogue_row.physical_schema_token,
          'physicalTableToken', catalogue_row.physical_table_token,
          'protectedReadModelKey', catalogue_row.protected_read_model_key
        ),
        'readableFieldIds', pg_catalog.to_jsonb(readable_field_ids),
        -- The fields the reader is guaranteed to see on every record it may read, whatever the
        -- scan examines: the current field bound a list offers its filter, search and sort by.
        'fieldBoundIds', pg_catalog.to_jsonb(coalesce(access_plan.bound_field_ids, array[]::text[])),
        'access', pg_catalog.jsonb_build_object(
          'predicate', access_plan.access_predicate,
          'parameters', coalesce(access_plan.access_parameters, '[]'::jsonb),
          'ownerAccountId', access_plan.owner_account_id,
          'ownerGroupIds', pg_catalog.to_jsonb(coalesce(access_plan.owner_group_ids, array[]::uuid[])),
          'sharedRecordIds', pg_catalog.to_jsonb(coalesce(access_plan.shared_record_ids, array[]::uuid[]))
        )
      );
    end if;
  end if;
  if p_stage = 'storage' then
    return prepared_plan;
  end if;

  if fields_by_id = '{}'::jsonb then
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
    loop
      fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
        pg_catalog.lower(field_item ->> 'fieldId'), field_item
      );
    end loop;
  end if;
  -- Filter: the published condition tree over this record type's own fields, and,
  -- when supplied, the user's typed filter ANDed with it so it can only narrow.
  -- Every field the user's tree reads must be one the component declares
  -- filterable; the record type's own filterable flag is checked below for both.
  filter_condition := query_item -> 'filter';
  if filter_condition is not null and filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  if user_filter is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into user_filter_ids
    from pg_catalog.jsonb_path_query(
      user_filter, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    if exists (
      select 1 from pg_catalog.unnest(user_filter_ids) as referenced(id)
      where referenced.id <> pg_catalog.lower(referenced.id)
        or referenced.id <> all (declared_filterable_ids)
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end if;
    filter_condition := case
      when filter_condition is null then user_filter
      else pg_catalog.jsonb_build_object(
        'kind', 'all',
        'conditions', pg_catalog.jsonb_build_array(filter_condition, user_filter)
      )
    end;
  end if;
  if filter_condition is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into filter_ids
    from pg_catalog.jsonb_path_query(
      filter_condition, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    foreach field_key in array filter_ids loop
      -- Field values are keyed by lowercase identifier; so must the tree be.
      if field_key <> pg_catalog.lower(field_key) or not (fields_by_id ? field_key)
        or coalesce((fields_by_id -> field_key ->> 'filterable')::boolean, false) is not true then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      semantic_type := vortex_access.condition_field_type_internal(fields_by_id -> field_key);
      if semantic_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = catalogue_row.storage_contract_id
        and mapping.field_id = field_key::uuid;
      if not found or mapping_row.state is distinct from 'active' then
        if preview_mode then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end if;
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      filter_field_columns := filter_field_columns || pg_catalog.jsonb_build_object(
        field_key, mapping_row.physical_column_token
      );
      filter_field_database_types := filter_field_database_types || pg_catalog.jsonb_build_object(
        field_key, mapping_row.database_value_type
      );
      filter_types := filter_types || pg_catalog.jsonb_build_object(field_key, semantic_type);
      filter_nulls := filter_nulls || pg_catalog.jsonb_build_object(field_key, null::jsonb);
      read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
        and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
          or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
      if read_time_field then
        read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
        read_time_sql := vortex_record.read_time_deadline_expression_internal(
          catalogue_row.storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
          read_time_clock
        );
        if read_time_sql is null then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
        end if;
        filter_read_time_expressions := filter_read_time_expressions || pg_catalog.jsonb_build_object(
          field_key, read_time_sql
        );
        filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
          '%L, %s', field_key, pg_catalog.format('pg_catalog.to_jsonb(%s)', read_time_sql)
        ));
        continue;
      end if;
      -- Keep the canonical typed link object, including its target record type.
      filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
        '%L, %s', field_key,
        case
          when mapping_row.database_value_type = 'decimal' then
            pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'timestamp_with_time_zone' then
            pg_catalog.format(
              'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.%I))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'date' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
              mapping_row.physical_column_token)
          else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', mapping_row.physical_column_token)
        end
      ));
    end loop;
  end if;

  -- Inputs retain their canonical values. The bridge validates declared types.
  for input_key in select supplied.key from pg_catalog.jsonb_object_keys(p_input_values) as supplied(key) loop
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
      where item.value ->> 'key' = input_key
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
  end loop;
  for input_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
  loop
    input_key := input_item ->> 'key';
    input_value := coalesce(p_input_values -> input_key, 'null'::jsonb);
    if input_value = 'null'::jsonb and coalesce((input_item ->> 'required')::boolean, true) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
    if input_value <> 'null'::jsonb and input_item ->> 'type' = 'record_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'recordId') ~ uuid_pattern, false)
        or not exists (
          select 1 from pg_catalog.jsonb_array_elements(input_item -> 'recordTypes') as allowed(value)
          where allowed.value ->> 'state' = 'resolved'
            and pg_catalog.lower(allowed.value ->> 'recordTypeId')
              = pg_catalog.lower(input_value ->> 'recordTypeId')
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
    end if;
    parameter_types := parameter_types || pg_catalog.jsonb_build_object(input_key, case input_item ->> 'type'
      when 'formatted_text' then 'opaque_json'
      else input_item ->> 'type' end);
    parameter_values := parameter_values || pg_catalog.jsonb_build_object(input_key, input_value);
  end loop;
  begin
    perform vortex_access.evaluate_query_condition_internal(
      trivial_condition, '{}'::jsonb, '{}'::jsonb, parameter_types, parameter_values, true
    );
  exception when invalid_parameter_value then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
  end;
  if filter_condition is not null then
    begin
      perform vortex_access.evaluate_query_condition_internal(
        filter_condition, filter_types, filter_nulls, parameter_types, parameter_values, true
      );
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;

  filter_condition := vortex_record.omit_unbound_query_conditions_internal(filter_condition, parameter_values);
  select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_path_query(filter_condition, 'lax $.**?(@.source == "field").fieldId') as referenced(value);

  -- The published filter is pushed into the candidate scan only when every
  -- field it reads is one the reader is guaranteed to see; otherwise it is
  -- evaluated per row, so which rows the budget examines can never depend on a
  -- value the reader cannot see.
  filter_predicate := 'true';
  if filter_condition is not null
    and not exists (
      select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
      where referenced.id <> all (readable_field_ids)
    ) then
    begin
      filter_plan := vortex_record.compile_query_filter_internal(
        filter_condition,
        filter_types,
        filter_field_columns,
        filter_field_database_types,
        fields_by_id,
        filter_read_time_expressions,
        parameter_types,
        parameter_values,
        9,
        0
      );
      filter_predicate := coalesce(filter_plan ->> 'predicate', 'true');
      filter_parameters := coalesce(filter_plan -> 'parameters', '[]'::jsonb);
      -- An incomplete compiled predicate remains a candidate narrowing step.
      filter_exact := filter_plan ->> 'predicate' is not null
        and (filter_plan ->> 'exact')::boolean is true;
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;
  return prepared_plan || pg_catalog.jsonb_build_object(
    'filterFieldIds', pg_catalog.to_jsonb(filter_ids),
    'filter', pg_catalog.jsonb_build_object(
      'residualCondition', filter_condition,
      'residualFieldTypes', filter_types,
      'residualNullValues', filter_nulls,
      'residualInputTypes', parameter_types,
      'residualInputs', parameter_values,
      'expressions', pg_catalog.to_jsonb(filter_expressions),
      'pushedPredicate', filter_predicate,
      'pushedExact', filter_exact,
      'pushedParameters', filter_parameters
    )
  );
end
$function$;

alter function vortex_record.prepare_module_query_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb,text,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb)
  to vortex_owner;

comment on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb) is
  'Shared owner-only Module query preparation for list and summary reads: derives organisation and application authority from validated_human_request_context(), resolves one installed query or the exact current human-owned preview pins, revalidates preview prior plans, exact active field mappings and preview catalogue/field bounds without using the installed read-scan routes, refuses a preview of a used Module''s record type with read_forbidden when the same read plan decision admits no read alternative, refuses an authored query of a Module the Application does not own unless that query is exposed, validates declared inputs and the published filter narrowed by the declared user filter, and returns the exact access predicate, pushed filter and residual per-row condition with bound inputs; it never accepts authority or identity from caller values.';

create or replace function vortex_record.run_module_query(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids jsonb,
  p_page_size integer,
  p_after jsonb,
  p_requested_system_field_keys jsonb,
  p_user_inputs jsonb,
  p_direction text,
  p_exact_record_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- A page ending at this candidate budget still returns its position for the next request.
  scan_limit constant integer := 500;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  exact_ids_refusal text;
  prepared_plan jsonb;
  storage_plan jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  v_storage_contract_id uuid;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  selected_ids text[];
  requested_ids text[] := array[]::text[];
  sort_item jsonb;
  sort_ids text[] := array[]::text[];
  declared_sort_ids text[] := array[]::text[];
  cursor_sort jsonb := '[]'::jsonb;
  sort_directions text[] := array[]::text[];
  scan_directions text[] := array[]::text[];
  sort_value_sql text[] := array[]::text[];
  sort_sql_types text[] := array[]::text[];
  filter_condition jsonb;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_predicate text;
  filter_exact boolean;
  filter_parameters jsonb := '[]'::jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  after_sort_key text[];
  after_phase text;
  after_record_id uuid;
  sort_index integer;
  column_sql text;
  value_sql text;
  pushed boolean;
  after_terms text[] := array[]::text[];
  equal_prefix text := '';
  keyset_sql text := '';
  segment_predicates text[];
  segment_sql text;
  segment_prefix text;
  prefix_index integer;
  composite_sort jsonb;
  composite_index_ready boolean := false;
  record_id_direction text := 'ascending';
  scan_record_id_direction text := 'ascending';
  -- Whether each sort key has the aligned field index (stored and sortable or unique).
  sort_index_backed boolean[] := array[]::boolean[];
  sort_stored boolean[] := array[]::boolean[];
  order_terms text[] := array[]::text[];
  sort_key_terms text[] := array[]::text[];
  order_by_sql text;
  scan_sql text;
  read_row record;
  page_access_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_eligibility_checked boolean := false;
  validated_record_types jsonb;
  readable_field_ids text[] := array[]::text[];
  bound_field_ids text[] := array[]::text[];
  access_sql text;
  access_parameters jsonb := '[]'::jsonb;
  access_owner_account_id uuid;
  access_owner_group_ids uuid[] := array[]::uuid[];
  access_shared_record_ids uuid[] := array[]::uuid[];
  physical_table_token text;
  storage_scope text;
  scan_source_sql text;
  search_prefilter_sql text := 'true';
  scan_projection_sql text := 'null::jsonb';
  projection_page_scan boolean := false;
  projection_sort_key text;
  projection_batch jsonb;
  projection_after jsonb; projection_batch_size integer;
  projection_candidate_count integer := 0; projection_reader_exhausted boolean := false;
  projection_batch_exhausted boolean := false;
  projection_last_record_id uuid;
  projection_last_sort_key text[];
  projection_predicate jsonb;
  projection_plan jsonb;
  projection_failure text;
  scan_record record;
  scan_cursor refcursor;
  cursor_position integer;
  lookahead_record record;
  lookahead_ids uuid[];
  page_first_loaded jsonb;
  -- Every row shares the validated installation, facts envelope and read-time inputs.
  page_shared jsonb; page_narrowed boolean;
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  page_batching boolean := true;
  examined integer := 0;
  budget_exhausted boolean := false;
  more_rows boolean := false;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  capability_rows jsonb[] := array[]::jsonb[];
  page_capabilities jsonb;
  rows_value jsonb := '[]'::jsonb;
  row_count integer := 0;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  last_returned_sort_key text[];
  last_returned_record_id uuid;
  first_returned_sort_key text[];
  first_returned_record_id uuid;
  next_value jsonb := null;
  opposite_value jsonb := null;
  system_field_keys text[] := array[]::text[];
  system_key text;
  system_expressions text[] := array[]::text[];
  system_columns_sql text;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  list_key text;
  declared_list jsonb;
  parsed_ids text[];
  declared_lists jsonb := '{}'::jsonb;
  declared_sortable_ids text[] := array[]::text[];
  declared_searchable_ids text[] := array[]::text[];
  user_sort jsonb;
  user_search text;
  effective_sort jsonb;
  effective_sort_is_user boolean := false;
  search_plan jsonb;
  search_field_ids text[] := array[]::text[];
  board_member_mode boolean := false;
  group_member_mode boolean := false;
  board_member jsonb;
  board_choice_field_id text;
  board_column_kind text;
  board_column_value text;
  board_options jsonb;
  board_option_values text[] := array[]::text[];
  board_option jsonb;
  board_member_matches boolean;
  -- Every board column this call reads: one for a member page, every displayed
  -- column for a board's first pages, each finished in its own pass below.
  board_columns_mode boolean := false;
  board_columns jsonb := '[]'::jsonb;
  board_column_item jsonb;
  board_column_position integer := 0;
  board_column_pages jsonb := '[]'::jsonb;
  -- The stored choice column, when the reader is guaranteed to see the choice
  -- field on every scanned row, and the current column's candidate predicate.
  board_choice_column text;
  board_scan_sql text := '';
  -- A board's first pages read the table once for every column when the choice field is not
  -- guaranteed readable: each readable row is classified into its column from its own readable
  -- value, and every column keeps its own page state (rows, capability inputs, first and last
  -- returned row, and whether more cards follow) in the arrays below, by column position.
  board_shared_scan boolean := false;
  board_column_index integer;
  shared_rows jsonb[] := array[]::jsonb[];
  shared_capabilities jsonb[] := array[]::jsonb[];
  shared_counts integer[] := array[]::integer[];
  shared_more boolean[] := array[]::boolean[];
  shared_first_keys jsonb[] := array[]::jsonb[];
  shared_first_ids uuid[] := array[]::uuid[];
  shared_last_keys jsonb[] := array[]::jsonb[];
  shared_last_ids uuid[] := array[]::uuid[];
  group_member jsonb;
  group_selector jsonb;
  group_selector_values jsonb := '{}'::jsonb;
  group_selector_types jsonb := '{}'::jsonb;
  group_candidate_values jsonb;
  group_by_ids text[] := array[]::text[];
  group_key text;
  group_member_matches boolean;
  group_scan_predicate text;
  group_link_field_id text; group_link_cache jsonb := '{}'::jsonb; group_link_values jsonb[];
  group_link_scan_sql text := 'null::jsonb';
  preview_mode boolean := false;
  -- A tree level: the roots of a tree (records with no readable parent) or the
  -- children of one parent, over a one-record link of the record type to itself.
  tree_mode boolean := false;
  tree_field_id text;
  tree_parent_id uuid;
  tree_relationship_id uuid;
  tree_item jsonb;
  tree_filter jsonb;
  tree_filter_predicate text;
  tree_candidates uuid[];
  tree_root_child_ids uuid[] := array[]::uuid[];
  tree_root_nonroot_ids uuid[];
begin
  -- Request shape. Nothing here is authority; it only bounds the work.
  if p_direction not in ('forward', 'backward') or p_direction is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- An exact read names 1..200 distinct, non-nil record ids and asks for exactly that many rows.
  if p_exact_record_ids is not null then
    -- CASE checks dimensions before array_position, which requires one dimension.
    exact_ids_refusal := case
      when pg_catalog.cardinality(p_exact_record_ids) > 200 then 'exact_ids_too_many'
      when pg_catalog.array_ndims(p_exact_record_ids) is distinct from 1
        or pg_catalog.cardinality(p_exact_record_ids) = 0 then 'exact_ids_invalid'
      when pg_catalog.array_position(p_exact_record_ids, null) is not null
        or '00000000-0000-0000-0000-000000000000'::uuid = any (p_exact_record_ids)
        or (select pg_catalog.count(distinct exact_id.id) from pg_catalog.unnest(p_exact_record_ids) as exact_id(id))
          <> pg_catalog.cardinality(p_exact_record_ids) then 'exact_ids_invalid'
      when p_page_size is distinct from pg_catalog.cardinality(p_exact_record_ids)
        or (p_after is not null and p_after <> 'null'::jsonb) then 'exact_ids_page_invalid'
    end;
    if exact_ids_refusal is not null then
      raise log '%', pg_catalog.jsonb_build_object('part', 'exact_ids', 'reason', exact_ids_refusal);
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
  end if;
  if p_requested_field_ids is null
    or pg_catalog.jsonb_typeof(p_requested_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_field_ids) not between 1 and 200
    or p_page_size is null or p_page_size not between 1 and 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in select item.value from pg_catalog.jsonb_array_elements(p_requested_field_ids) as item(value) loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(field_item #>> '{}') = any (requested_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    requested_ids := pg_catalog.array_append(requested_ids, pg_catalog.lower(field_item #>> '{}'));
  end loop;
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
  -- User field sets narrow the published contract; they never supply authority.
  if p_user_inputs is null then
    p_user_inputs := '{}'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_user_inputs) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  board_member_mode := p_user_inputs ? 'boardMember';
  board_columns_mode := p_user_inputs ? 'boardColumns';
  group_member_mode := p_user_inputs ? 'groupMember';
  if (board_member_mode and group_member_mode)
    or (board_columns_mode and (board_member_mode or group_member_mode)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- A board's first pages: every requested column, each from its start.
  if board_columns_mode and (p_direction <> 'forward' or p_exact_record_ids is not null
    or (p_after is not null and p_after <> 'null'::jsonb)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  board_member_mode := board_member_mode or board_columns_mode;
  if exists (
    select 1 from pg_catalog.jsonb_object_keys(p_user_inputs) as supplied(key)
    where supplied.key not in (
      'sort', 'filter', 'search', 'sortableFieldIds', 'filterableFieldIds', 'searchableFieldIds',
      'boardMember', 'boardColumns', 'groupMember', 'grouping', 'tree'
    )
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  tree_mode := p_user_inputs ? 'tree';
  if tree_mode and (board_member_mode or group_member_mode or p_user_inputs ? 'grouping'
    or p_exact_record_ids is not null) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if group_member_mode then
    group_member := vortex_record.group_member_selector_internal(p_user_inputs -> 'groupMember');
    if group_member is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    group_selector := p_user_inputs #> '{groupMember,values}';
    group_selector_types := group_member -> 'types';
    group_selector_values := group_member -> 'values';
  end if;
  if board_member_mode then
    board_member := vortex_record.board_column_selector_internal(
      p_user_inputs -> case when board_columns_mode then 'boardColumns' else 'boardMember' end,
      board_columns_mode
    );
    if board_member is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_choice_field_id := board_member ->> 'choiceFieldId';
    board_columns := board_member -> 'columns';
  end if;
  -- The list-only sortable and searchable allow-lists contain distinct field
  -- identities. Query preparation validates the filterable allow-list.
  for list_key in
    select pg_catalog.unnest(array['sortableFieldIds', 'searchableFieldIds'])
  loop
    declared_list := coalesce(p_user_inputs -> list_key, '[]'::jsonb);
    if pg_catalog.jsonb_typeof(declared_list) <> 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    if pg_catalog.jsonb_array_length(declared_list) > 200 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := array[]::text[];
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(declared_list) as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) <> 'string'
        or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
        or pg_catalog.lower(field_item #>> '{}') = any (parsed_ids) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(field_item #>> '{}'));
    end loop;
    declared_lists := declared_lists || pg_catalog.jsonb_build_object(list_key, pg_catalog.to_jsonb(parsed_ids));
  end loop;
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_sortable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'sortableFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_searchable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'searchableFieldIds') as item(value);
  -- The user's sort: the same pair shape as the published sort, bounded and each
  -- direction valid. It replaces the published order only when it is non-empty.
  user_sort := coalesce(p_user_inputs -> 'sort', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(user_sort) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if pg_catalog.jsonb_array_length(user_sort) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_user_inputs ? 'grouping' and not group_member_mode then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if board_member_mode and (
    pg_catalog.jsonb_array_length(user_sort) <> 0
    -- The search plan is read further down; a board member read carries no search term at all.
    or nullif(pg_catalog.btrim(p_user_inputs ->> 'search'), '') is not null
    or pg_catalog.cardinality(declared_sortable_ids) <> 0
    or pg_catalog.cardinality(declared_searchable_ids) <> 0
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  foreach system_key in array system_field_keys loop
    system_expressions := pg_catalog.array_append(system_expressions, pg_catalog.format('%L, %s', system_key,
      case system_key
        when 'created_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.created_at))'
        when 'updated_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.updated_at))'
        when 'created_by' then 'pg_catalog.to_jsonb(stored.created_by)'
        when 'updated_by' then 'pg_catalog.to_jsonb(stored.updated_by)'
        else
          'case when stored.owner_organisation_account_id is not null then pg_catalog.jsonb_build_object(''kind'', ''organization_account'', ''organizationAccountId'', stored.owner_organisation_account_id) when stored.owner_group_id is not null then pg_catalog.jsonb_build_object(''kind'', ''group'', ''groupId'', stored.owner_group_id) else ''null''::jsonb end'
      end));
  end loop;
  system_columns_sql := pg_catalog.array_to_string(system_expressions, ', ');
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'resolution', null
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  resolved := prepared_plan -> 'resolved';
  query_item := prepared_plan -> 'query';
  record_type_item := prepared_plan -> 'recordType';
  record_type_id_value := (prepared_plan ->> 'recordTypeId')::uuid;
  context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
  context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;
  preview_mode := prepared_plan ? 'preview';
  if p_exact_record_ids is not null and record_type_item ? 'systemProjection' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;
  if p_user_inputs ? 'grouping' then
    query_item := vortex_record.grouping_query_internal(
      query_item, record_type_item, p_user_inputs -> 'grouping', 50
    );
    if query_item is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  end if;
  -- Grouped and totalled shapes are not plain rows. Only separately validated
  -- board and generic group member modes may read members from those Queries.
  if pg_catalog.jsonb_typeof(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) is distinct from 'array'
    or pg_catalog.jsonb_typeof(coalesce(query_item -> 'aggregates', '[]'::jsonb)) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if group_member_mode then
    group_by_ids := vortex_record.query_group_member_fields_internal(
      query_item, fields_by_id, group_selector, group_selector_types);
    if group_by_ids is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  elsif board_member_mode then
    if pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 1 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  elsif pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 0
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if p_exact_record_ids is null and p_page_size > coalesce((query_item ->> 'pageSize')::integer, 0) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'page_size_invalid');
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'storage', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  storage_plan := prepared_plan;
  v_storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
  preview_mode := prepared_plan ? 'preview';
  physical_table_token := prepared_plan #>> '{storage,physicalTableToken}';
  storage_scope := prepared_plan #>> '{storage,storageScope}';
  access_sql := prepared_plan #>> '{access,predicate}';
  if access_sql is null then
    raise exception using errcode = '55000',
      message = 'Prepared record query has no access predicate';
  end if;
  access_parameters := coalesce(prepared_plan #> '{access,parameters}', '[]'::jsonb);
  access_owner_account_id := nullif(prepared_plan #>> '{access,ownerAccountId}', '')::uuid;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,sharedRecordIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);
  if pg_catalog.jsonb_typeof(prepared_plan -> 'fieldBoundIds') is distinct from 'array' then
    raise exception using errcode = '55000',
      message = 'Prepared record query has no field bound';
  end if;
  select coalesce(pg_catalog.array_agg(item.value order by item.value), array[]::text[])
  into bound_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'fieldBoundIds') as item(value)
  where fields_by_id ? item.value;
  if p_user_inputs ? 'grouping' and not (
    pg_catalog.lower(p_user_inputs #>> '{grouping,fieldId}') = any (readable_field_ids)
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;
  if tree_mode then
    tree_item := vortex_record.query_tree_selector_internal(
      p_user_inputs -> 'tree', record_type_item, bound_field_ids);
    if tree_item ->> 'outcome' <> 'completed' then return tree_item; end if;
    tree_field_id := tree_item ->> 'fieldId';
    tree_parent_id := (tree_item ->> 'parentRecordId')::uuid;
    tree_relationship_id := (tree_item ->> 'relationshipId')::uuid;
  end if;
  search_plan := vortex_record.query_search_plan_internal(
    p_user_inputs, fields_by_id, declared_searchable_ids);
  if search_plan ->> 'outcome' <> 'completed' then return search_plan; end if;
  user_search := search_plan ->> 'search';
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into search_field_ids
  from pg_catalog.jsonb_array_elements_text(search_plan -> 'fieldIds') as item(value);
  -- Projection: only fields the published query selects.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into selected_ids
  from pg_catalog.jsonb_array_elements(query_item -> 'selectedFieldIds') as item(value);
  if exists (select 1 from pg_catalog.unnest(requested_ids) as requested(id) where requested.id <> all (selected_ids)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;
  if board_member_mode then
    if pg_catalog.lower(query_item #>> '{groupByFieldIds,0}') is distinct from board_choice_field_id
      or not (board_choice_field_id = any (selected_ids))
      or not (fields_by_id ? board_choice_field_id)
      or fields_by_id -> board_choice_field_id ->> 'type' is distinct from 'choice'
      or coalesce((fields_by_id -> board_choice_field_id ->> 'filterable')::boolean, false) is not true then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_options := fields_by_id #> array[board_choice_field_id, 'settings', 'options'];
    if pg_catalog.jsonb_typeof(board_options) is distinct from 'array'
      or pg_catalog.jsonb_array_length(board_options) not between 1 and 12 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for board_option in select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value) loop
      if pg_catalog.jsonb_typeof(board_option) is distinct from 'object'
        or board_option - array['value', 'label', 'requiredPermissionId']::text[] <> '{}'::jsonb
        or not (board_option ? 'value') or not (board_option ? 'label')
        or pg_catalog.jsonb_typeof(board_option -> 'value') is distinct from 'string'
        or coalesce(pg_catalog.length(board_option ->> 'value'), 0) not between 1 and 120
        or pg_catalog.jsonb_typeof(board_option -> 'label') is distinct from 'string'
        or coalesce(pg_catalog.length(pg_catalog.btrim(board_option ->> 'label')), 0) not between 1 and 60
        or (board_option ? 'requiredPermissionId' and (
          pg_catalog.jsonb_typeof(board_option -> 'requiredPermissionId') is distinct from 'string'
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') !~ uuid_pattern
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') = '00000000-0000-0000-0000-000000000000'
        ))
        or (board_option ->> 'value') collate "C" = any (board_option_values) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      board_option_values := pg_catalog.array_append(board_option_values, board_option ->> 'value');
    end loop;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(board_columns) as requested(value)
      where requested.value ->> 'kind' = 'option'
        and not ((requested.value ->> 'value') collate "C" = any (board_option_values))
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    -- A column reads only its own cards. When the reader is guaranteed to see the
    -- choice field on every row the scan examines, the stored choice value is the
    -- readable value, so the column's membership narrows the candidate scan and the
    -- budget is spent on that column's members only. Otherwise the scan stays
    -- unnarrowed and membership is decided from each readable projection below, so
    -- a withheld value never decides which rows are examined.
    if board_choice_field_id = any (readable_field_ids) then
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = v_storage_contract_id
        and mapping.field_id = board_choice_field_id::uuid;
      if not found or mapping_row.state is distinct from 'active' then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      if mapping_row.database_value_type = 'text' then
        board_choice_column := mapping_row.physical_column_token;
      end if;
    end if;
  end if;
  -- Sort only on readable fields: validate declared keys, refuse unbounded user keys, and end
  -- with record identity. A withheld published key never changes membership or reveals its value.
  if board_member_mode then
    effective_sort := '[]'::jsonb;
    effective_sort_is_user := false;
  elsif pg_catalog.jsonb_array_length(user_sort) > 0 then
    effective_sort := user_sort;
    effective_sort_is_user := true;
  elsif group_member_mode then
    -- Grouping keys are constant within this exact selector. Remove them from
    -- the query's default member order; record identity still breaks every tie.
    select coalesce(pg_catalog.jsonb_agg(item.value order by item.position), '[]'::jsonb)
    into effective_sort
    from pg_catalog.jsonb_array_elements(query_item -> 'sort') with ordinality as item(value, position)
    where pg_catalog.lower(item.value ->> 'fieldId') <> all (group_by_ids);
    effective_sort_is_user := false;
  else
    effective_sort := query_item -> 'sort';
    effective_sort_is_user := false;
  end if;
  for sort_item in
    select item.value from pg_catalog.jsonb_array_elements(effective_sort) as item(value)
  loop
    field_key := pg_catalog.lower(sort_item ->> 'fieldId');
    if field_key is null or not (fields_by_id ? field_key)
      or sort_item ->> 'direction' not in ('ascending', 'descending')
      or field_key = any (declared_sort_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if effective_sort_is_user
      and (not (field_key = any (declared_sortable_ids))
        or coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false) is not true) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = v_storage_contract_id
      and mapping.field_id = field_key::uuid;
    if not found or mapping_row.state is distinct from 'active' then
      if preview_mode then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    declared_sort_ids := pg_catalog.array_append(declared_sort_ids, field_key);
    pushed := field_key = any (readable_field_ids);
    cursor_sort := cursor_sort || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'fieldId', field_key, 'direction', sort_item ->> 'direction',
        'pushed', pushed
      )
    );
    if effective_sort_is_user and not pushed then
      -- The user's order must actually be the scan order.
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    -- A read-time field is worked out inside this statement, from the
    -- record's own stored values and one statement timestamp; it is never a
    -- stored column here.
    read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
      and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
        or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
    if read_time_field then
      read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
      read_time_sql := vortex_record.read_time_deadline_expression_internal(
        v_storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
        read_time_clock
      );
      if read_time_sql is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
      end if;
      if not pushed then
        continue;
      end if;
      sort_ids := pg_catalog.array_append(sort_ids, field_key);
      sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
      sort_value_sql := pg_catalog.array_append(sort_value_sql, read_time_sql);
      sort_sql_types := pg_catalog.array_append(sort_sql_types, 'boolean');
      sort_index_backed := pg_catalog.array_append(sort_index_backed, false);
      sort_stored := pg_catalog.array_append(sort_stored, false);
      continue;
    end if;
    -- JSON-valued fields (money, links, choice sets, documents) have no total
    -- order here; money in particular is never ordered across currencies.
    if mapping_row.database_value_type not in (
      'integer', 'decimal', 'boolean', 'date', 'timestamp_with_time_zone', 'text', 'uuid'
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if not pushed then
      continue;
    end if;
    sort_ids := pg_catalog.array_append(sort_ids, field_key);
    sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
    sort_value_sql := pg_catalog.array_append(
      sort_value_sql, pg_catalog.format('stored.%I', mapping_row.physical_column_token)
    );
    sort_index_backed := pg_catalog.array_append(sort_index_backed,
      coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false)
        or coalesce((fields_by_id -> field_key ->> 'unique')::boolean, false));
    sort_stored := pg_catalog.array_append(sort_stored, true);
    sort_sql_types := pg_catalog.array_append(sort_sql_types, case mapping_row.database_value_type
      when 'integer' then 'bigint'
      when 'decimal' then 'numeric'
      when 'boolean' then 'boolean'
      when 'date' then 'date'
      when 'timestamp_with_time_zone' then 'timestamp with time zone'
      when 'uuid' then 'uuid'
      else 'text' end);
  end loop;
  if pg_catalog.cardinality(declared_sort_ids) = 0
    and not board_member_mode and not group_member_mode then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
  end if;
  -- The tie-break direction is a property of the declared order, independent
  -- of whether its asynchronous physical index has finished building.
  if pg_catalog.cardinality(sort_ids) > 0 then
    record_id_direction := sort_directions[pg_catalog.cardinality(sort_ids)];
  end if;
  if pg_catalog.cardinality(sort_ids) > 1
    and pg_catalog.cardinality(sort_ids) = pg_catalog.cardinality(declared_sort_ids)
    and not (false = any (sort_stored)) then
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fieldId', sort_ids[item.position],
      'direction', sort_directions[item.position]) order by item.position)
    into composite_sort
    from pg_catalog.generate_series(1, pg_catalog.cardinality(sort_ids)) as item(position);
    select coalesce(index_value.indisvalid, false) into composite_index_ready
    from pg_catalog.pg_index as index_value
    where index_value.indexrelid = pg_catalog.to_regclass(pg_catalog.format(
      'record_data.%I', 'is_' || pg_catalog.md5(
        v_storage_contract_id::text || ':' || composite_sort::text)));
    composite_index_ready := coalesce(composite_index_ready, false);
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'complete', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  if preview_mode and (
    prepared_plan -> 'storage' is distinct from storage_plan -> 'storage'
    or prepared_plan -> 'fieldMappings' is distinct from storage_plan -> 'fieldMappings'
    or prepared_plan -> 'readableFieldIds' is distinct from storage_plan -> 'readableFieldIds'
    or prepared_plan -> 'access' is distinct from storage_plan -> 'access'
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  filter_condition := prepared_plan #> '{filter,residualCondition}';
  if filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  filter_types := coalesce(prepared_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  filter_nulls := coalesce(prepared_plan #> '{filter,residualNullValues}', '{}'::jsonb);
  parameter_types := coalesce(prepared_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values := coalesce(prepared_plan #> '{filter,residualInputs}', '{}'::jsonb);
  filter_predicate := coalesce(prepared_plan #>> '{filter,pushedPredicate}', 'true');
  -- Push membership through the stored field; recheck the projected bucket below.
  if p_user_inputs ? 'grouping' then
    group_key := pg_catalog.lower(p_user_inputs #>> '{grouping,fieldId}');
    select mapping.* into mapping_row from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = v_storage_contract_id and mapping.field_id = group_key::uuid;
    if not found or mapping_row.state <> 'active' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
    end if;
    begin
      group_scan_predicate := vortex_record.grouping_member_predicate_internal(
        mapping_row.physical_column_token, mapping_row.database_value_type,
        fields_by_id -> group_key ->> 'type', p_user_inputs -> 'grouping', group_selector_values -> group_key
      );
    exception when sqlstate 'V3187' then
      -- The forged or stale selector's date bucket is outside the supported year domain.
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'value_out_of_range');
    end;
    if group_scan_predicate is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    filter_predicate := '(' || filter_predicate || ') and (' || group_scan_predicate || ')';
    if group_selector_values -> group_key = '"not_available"'::jsonb then
      group_link_scan_sql := pg_catalog.format('stored.%I', mapping_row.physical_column_token);
    end if;
    if fields_by_id -> group_key ->> 'type' = 'link' then
      group_link_field_id := group_key;
      group_link_cache := vortex_record.group_link_unreadable_internal(
        group_link_cache, array[group_selector_values -> group_key], fields_by_id -> group_key);
      if coalesce((group_link_cache ->> (group_selector_values -> group_key ->> 'recordId'))::boolean, false) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'read_forbidden');
      end if;
    end if;
  end if;
  tree_filter_predicate := filter_predicate;
  if tree_mode and tree_parent_id is not null then
    filter_predicate := '(' || filter_predicate || ') and ' || pg_catalog.format(
      'exists (select 1 from vortex_record.relationship_edges as tree_edge'
      || ' where tree_edge.relationship_id = %1$L::uuid and tree_edge.from_organisation_id = stored.organisation_id'
      || ' and tree_edge.from_storage_contract_id = %2$L::uuid and tree_edge.from_record_id = stored.record_id'
      || ' and tree_edge.to_record_id = $16)',
      tree_relationship_id, v_storage_contract_id);
  end if;
  filter_exact := (prepared_plan #>> '{filter,pushedExact}')::boolean is true;
  filter_parameters := coalesce(prepared_plan #> '{filter,pushedParameters}', '[]'::jsonb);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_expressions
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{filter,expressions}') as item(value);
  if tree_mode then
    -- Every tree relative read applies the query's own filter and the viewer's search, exactly as
    -- the level scan does: the pushed predicate, the filtered fields' readability and the residual.
    tree_filter := pg_catalog.jsonb_build_object(
      'predicate', tree_filter_predicate, 'parameters', filter_parameters, 'exact', filter_exact,
      'condition', filter_condition, 'fieldTypes', filter_types,
      'inputTypes', parameter_types, 'inputs', parameter_values,
      'fieldIds', pg_catalog.to_jsonb(filter_ids),
      'valuesSql', (select pg_catalog.string_agg(
          filter_chunk.pairs_text,
          ') || pg_catalog.jsonb_build_object(' order by filter_chunk.chunk_index)
        from (
          select (filter_pair.pair_number - 1) / 50 as chunk_index,
            pg_catalog.string_agg(
              filter_pair.pair_text, ', ' order by filter_pair.pair_number
            ) as pairs_text
          from pg_catalog.unnest(filter_expressions)
            with ordinality as filter_pair(pair_text, pair_number)
          group by (filter_pair.pair_number - 1) / 50
        ) as filter_chunk),
      'searchFieldIds', pg_catalog.to_jsonb(search_field_ids), 'search', user_search);
  end if;
  -- The keyset position must fit this exact order. The cursor binds every
  -- declared sort field, direction and whether it was pushed, but carries
  -- values only for readable sort fields. A changed readable subset cannot
  -- reinterpret an old key or put a hidden field value in a cursor.
  if p_after is not null and p_after <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or p_after - array['sortKey', 'phase', 'recordId', 'sort']::text[] <> '{}'::jsonb
      or p_after -> 'sort' is distinct from cursor_sort
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> pg_catalog.cardinality(sort_ids)
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or p_after ->> 'phase' not in ('null', 'value')
      or pg_catalog.lower(p_after ->> 'recordId') !~ uuid_pattern
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') as item(value)
        where pg_catalog.jsonb_typeof(item.value) not in ('string', 'null')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    select pg_catalog.array_agg(item.value #>> '{}' order by item.ordinality)
    into after_sort_key
    from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') with ordinality as item(value, ordinality);
    after_record_id := (p_after ->> 'recordId')::uuid;
    after_phase := p_after ->> 'phase';
    if after_phase is distinct from (case
      when pg_catalog.cardinality(sort_ids) > 0 and after_sort_key[1] is null then 'null'
      else 'value' end) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
      if after_sort_key[sort_index] is not null
        and not pg_catalog.pg_input_is_valid(after_sort_key[sort_index], sort_sql_types[sort_index]) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
      end if;
    end loop;
  end if;
  for sort_index in 1 .. pg_catalog.cardinality(sort_directions) loop
    scan_directions := pg_catalog.array_append(scan_directions,
      case when p_direction = 'forward' then sort_directions[sort_index]
        when sort_directions[sort_index] = 'ascending' then 'descending'
        else 'ascending' end);
  end loop;
  scan_record_id_direction := case when p_direction = 'forward' then record_id_direction
    when record_id_direction = 'ascending' then 'descending' else 'ascending' end;
  scan_source_sql := pg_catalog.format('record_data.%I as stored', physical_table_token);
  projection_page_scan := not preview_mode and record_type_item ? 'systemProjection'
    and not board_member_mode and not group_member_mode and not tree_mode
    and pg_catalog.cardinality(sort_ids) = 1
    and pg_catalog.cardinality(declared_sort_ids) = 1
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        record_type_item #> '{systemProjection,sortableFieldIds}'
      ) as sortable(id)
      where pg_catalog.lower(sortable.id) = sort_ids[1]
    ) and vortex_record.has_bounded_system_projection_reader_internal(
      v_storage_contract_id, fields_by_id -> sort_ids[1] ->> 'key'
    );
  if projection_page_scan then
      projection_sort_key := fields_by_id -> sort_ids[1] ->> 'key';
      if projection_sort_key is null then
        raise exception using errcode = '55000',
          message = 'Protected projection sort field is unavailable';
      end if;
      projection_after := p_after;
      projection_batch_size := least(p_page_size, scan_limit);
      projection_plan := vortex_record.prepare_system_projection_scan_internal(
        prepared_plan || pg_catalog.jsonb_build_object('queryModuleRootId', p_module_root_id), search_plan);
      if projection_plan ->> 'outcome' <> 'prepared' then return projection_plan; end if;
      projection_predicate := projection_plan -> 'predicate';
      scan_source_sql := projection_plan ->> 'sourceSql';
      -- The one place the predicate is applied is the reader's scan.
      filter_predicate := 'true';
      filter_exact := true;
      filter_expressions := array[]::text[];
      begin
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
        into projection_batch
        from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
          null::uuid[], projection_sort_key, scan_directions[1], projection_after,
          projection_batch_size, projection_predicate) with ordinality as projected(organization_id,
          record_id, revision, attribute_values, ordinality);
      exception when sqlstate '22023' then
        get stacked diagnostics projection_failure = message_text;
        if projection_failure in ('filter_field_not_declared', 'predicate_unsupported') then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', projection_failure);
        end if;
        raise;
      end;
      scan_projection_sql := 'pg_catalog.to_jsonb(projection)';
  end if;
  -- The scan. Identifiers come only from the storage catalogue; every value is
  -- a bound parameter. Nulls order first ascending and last descending. The
  -- order always ends with the record id, so the keyset stays total even when
  -- no readable sort field may be pushed.
  for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
    column_sql := case when sort_sql_types[sort_index] = 'text'
      then sort_value_sql[sort_index] || ' collate "C"'
      else sort_value_sql[sort_index] end;
    order_terms := pg_catalog.array_append(order_terms, column_sql || case
      when scan_directions[sort_index] = 'ascending' then ' asc nulls first'
      else ' desc nulls last' end);
    sort_key_terms := pg_catalog.array_append(sort_key_terms, case sort_sql_types[sort_index]
      when 'timestamp with time zone' then pg_catalog.format(
        'vortex_platform.format_timestamp_utc(%s)',
        sort_value_sql[sort_index])
      when 'date' then pg_catalog.format(
        'pg_catalog.to_char(%s, ''YYYY-MM-DD'')', sort_value_sql[sort_index])
      else pg_catalog.format('(%s)::text', sort_value_sql[sort_index]) end);
    if after_record_id is not null then
      value_sql := case when sort_sql_types[sort_index] = 'text'
        then pg_catalog.format('$3[%s] collate "C"', sort_index)
        else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
      if after_sort_key[sort_index] is null then
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when scan_directions[sort_index] = 'ascending'
            then pg_catalog.format('(%s) is not null', sort_value_sql[sort_index])
          else 'false' end);
        equal_prefix := equal_prefix
          || pg_catalog.format('(%s) is null and ', sort_value_sql[sort_index]);
      else
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when scan_directions[sort_index] = 'ascending'
            then pg_catalog.format('coalesce(%s > %s, false)', column_sql, value_sql)
          else pg_catalog.format('((%s) is null or coalesce(%s < %s, false))',
            sort_value_sql[sort_index], column_sql, value_sql) end);
        equal_prefix := equal_prefix
          || pg_catalog.format('coalesce(%s = %s, false) and ', column_sql, value_sql);
      end if;
    end if;
  end loop;
  if after_record_id is not null then
    after_terms := pg_catalog.array_append(after_terms, equal_prefix ||
      'stored.record_id ' || case when scan_record_id_direction = 'ascending' then '>' else '<' end || ' $4');
    keyset_sql := ' and ((' || pg_catalog.array_to_string(after_terms, ') or (') || '))';
  end if;
  order_by_sql := pg_catalog.array_to_string(order_terms, ', ');
  if order_by_sql = '' then
    order_by_sql := 'stored.record_id ' ||
      case when scan_record_id_direction = 'ascending' then 'asc' else 'desc' end;
  else
    order_by_sql := order_by_sql || ', stored.record_id ' ||
      case when scan_record_id_direction = 'ascending' then 'asc' else 'desc' end;
  end if;
  if composite_index_ready then
    segment_predicates := array[]::text[];
    if after_record_id is null then
      segment_predicates := array[''];
    else
      -- A mixed-direction lexicographic comparison is one seek per first
      -- differing key. Each scan has an equality prefix and one B-tree range,
      -- including the NULL region in its own segment.
      segment_prefix := '';
      for prefix_index in 1 .. pg_catalog.cardinality(sort_ids) loop
        column_sql := case when sort_sql_types[prefix_index] = 'text'
          then sort_value_sql[prefix_index] || ' collate "C"'
          else sort_value_sql[prefix_index] end;
        if after_sort_key[prefix_index] is null then
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s is null', sort_value_sql[prefix_index]);
        else
          value_sql := case when sort_sql_types[prefix_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', prefix_index)
            else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s = %s', column_sql, value_sql);
        end if;
      end loop;
      segment_predicates := pg_catalog.array_append(segment_predicates,
        segment_prefix || ' and stored.record_id ' ||
        case when scan_record_id_direction = 'ascending' then '>' else '<' end || ' $4');
      for sort_index in reverse pg_catalog.cardinality(sort_ids) .. 1 loop
        segment_prefix := '';
        for prefix_index in 1 .. sort_index - 1 loop
          column_sql := case when sort_sql_types[prefix_index] = 'text'
            then sort_value_sql[prefix_index] || ' collate "C"'
            else sort_value_sql[prefix_index] end;
          if after_sort_key[prefix_index] is null then
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s is null', sort_value_sql[prefix_index]);
          else
            value_sql := case when sort_sql_types[prefix_index] = 'text'
              then pg_catalog.format('$3[%s] collate "C"', prefix_index)
              else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s = %s', column_sql, value_sql);
          end if;
        end loop;
        column_sql := case when sort_sql_types[sort_index] = 'text'
          then sort_value_sql[sort_index] || ' collate "C"'
          else sort_value_sql[sort_index] end;
        if after_sort_key[sort_index] is null then
          if scan_directions[sort_index] = 'ascending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is not null', sort_value_sql[sort_index]));
          end if;
        else
          value_sql := case when sort_sql_types[sort_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', sort_index)
            else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
          segment_predicates := pg_catalog.array_append(segment_predicates,
            segment_prefix || pg_catalog.format(' and %s %s %s', column_sql,
              case when scan_directions[sort_index] = 'ascending' then '>' else '<' end,
              value_sql));
          if scan_directions[sort_index] = 'descending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is null', sort_value_sql[sort_index]));
          end if;
        end if;
      end loop;
    end if;
  elsif pg_catalog.cardinality(sort_ids) = 1 and sort_index_backed[1] then
    -- Each segment has one contiguous range in the aligned index. A NULL
    -- cursor finishes its record-id range before the value range begins.
    if scan_directions[1] = 'ascending' then
      if after_record_id is null or after_phase = 'null' then
        segment_predicates := array[
          pg_catalog.format(' and %s is null%s', sort_value_sql[1],
            case when after_record_id is null then '' else ' and stored.record_id > $4' end),
          pg_catalog.format(' and %s is not null', sort_value_sql[1])
        ];
      else
        segment_predicates := array[pg_catalog.format(
          ' and %s is not null and (%s, stored.record_id) > (%s, $4)',
          sort_value_sql[1], column_sql, value_sql
        )];
      end if;
    elsif after_record_id is null then
      segment_predicates := array[
        pg_catalog.format(' and %s is not null', sort_value_sql[1]),
        pg_catalog.format(' and %s is null', sort_value_sql[1])
      ];
    elsif after_phase = 'value' then
      segment_predicates := array[
        pg_catalog.format(' and %s is not null and (%s, stored.record_id) < (%s, $4)',
          sort_value_sql[1], column_sql, value_sql),
        pg_catalog.format(' and %s is null', sort_value_sql[1])
      ];
    else
      segment_predicates := array[pg_catalog.format(
        ' and %s is null and stored.record_id < $4', sort_value_sql[1])];
    end if;
  else
    segment_predicates := array[keyset_sql];
  end if;
  if projection_page_scan then
    -- The bounded reader has already applied the sealed keyset and order.
    segment_predicates := array[''];
  else
    -- A search narrows the candidate scan, and so the budget, through the one shared
    -- stored-value pre-predicate; the per-row search match below stays the decision.
    search_prefilter_sql := vortex_record.query_search_prefilter_internal(
      v_storage_contract_id, fields_by_id, search_field_ids, readable_field_ids, user_search, 17, 18);
  end if;
  -- One pass per requested board column, each with its own page, budget and
  -- position; every other read makes exactly one pass. The page's access facts,
  -- eligibility and validated record types stay those of this one invocation.
  <<column_pass>>
  loop
  if board_member_mode then
    board_column_position := board_column_position + 1;
    exit column_pass when board_column_position > pg_catalog.jsonb_array_length(board_columns);
    board_column_item := board_columns -> (board_column_position - 1);
    board_column_kind := board_column_item ->> 'kind';
    board_column_value := board_column_item ->> 'value';
    if board_column_position = 1 and board_columns_mode and board_choice_column is null then
      board_shared_scan := true;
      shared_rows := pg_catalog.array_fill('[]'::jsonb, array[pg_catalog.jsonb_array_length(board_columns)]);
      shared_capabilities := shared_rows;
      shared_counts := pg_catalog.array_fill(0, array[pg_catalog.jsonb_array_length(board_columns)]);
      shared_more := pg_catalog.array_fill(false, array[pg_catalog.jsonb_array_length(board_columns)]);
      shared_first_keys := pg_catalog.array_fill('null'::jsonb, array[pg_catalog.jsonb_array_length(board_columns)]);
      shared_first_ids := pg_catalog.array_fill(null::uuid, array[pg_catalog.jsonb_array_length(board_columns)]);
      shared_last_keys := shared_first_keys;
      shared_last_ids := shared_first_ids;
    end if;
    board_scan_sql := case
      when board_choice_column is null then ''
      when board_column_kind = 'option' then pg_catalog.format(
        ' and stored.%I collate "C" = $13 collate "C"', board_choice_column)
      else pg_catalog.format(
        ' and (stored.%1$I is null or not (stored.%1$I collate "C" = any ($14::text[])))',
        board_choice_column)
    end;
    if board_column_position > 1 and not board_shared_scan then
      examined := 0;
      budget_exhausted := false;
      more_rows := false;
      rows_value := '[]'::jsonb;
      row_count := 0;
      capability_rows := array[]::jsonb[];
      decided_ids := array[]::uuid[];
      decided_loaded := null;
      decided_decisions := null;
      decided_bounds := null;
      last_examined_sort_key := null;
      last_examined_record_id := null;
      last_returned_sort_key := null;
      last_returned_record_id := null;
      first_returned_sort_key := null;
      first_returned_record_id := null;
      next_value := null;
      opposite_value := null;
    end if;
  end if;
  if not (board_shared_scan and board_column_position > 1) then
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
        and (case when (%s) then true else false end)%s%s
        and (%s)
     order by %s
     limit $5',
    pg_catalog.array_to_string(sort_key_terms, ', '),
    (select pg_catalog.string_agg(
       filter_chunk.pairs_text,
       ') || pg_catalog.jsonb_build_object(' order by filter_chunk.chunk_index
     )
     from (
       select (filter_pair.pair_number - 1) / 50 as chunk_index,
         pg_catalog.string_agg(
           filter_pair.pair_text, ', ' order by filter_pair.pair_number
         ) as pairs_text
       from pg_catalog.unnest(filter_expressions)
         with ordinality as filter_pair(pair_text, pair_number)
       group by (filter_pair.pair_number - 1) / 50
     ) as filter_chunk),
    system_columns_sql,
    scan_projection_sql,
    group_link_scan_sql,
    scan_source_sql,
    case when storage_scope = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    access_sql,
    filter_predicate,
    board_scan_sql,
    segment_sql,
    search_prefilter_sql,
    order_by_sql
  );
  -- A validated type set stays local to this invocation and is passed only to
  -- the fixed record adapter's private evaluator.
  open scan_cursor scroll for execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1, access_owner_account_id,
      access_owner_group_ids, access_shared_record_ids,
      filter_parameters, access_parameters, projection_batch, p_exact_record_ids,
      board_column_value, board_option_values, group_selector_values, tree_parent_id, search_field_ids, user_search;
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
        if preview_mode then
          page_shared := pg_catalog.jsonb_build_object(
            'installation', vortex_record.read_current_preview_installation_internal());
          page_shared := page_shared || pg_catalog.jsonb_build_object('plan',
            vortex_record.resolve_installation_access_plan_internal(page_shared -> 'installation'));
        else
          page_shared := prepared_plan -> 'pageAccess';
          if pg_catalog.jsonb_typeof(page_shared) is distinct from 'object' then
            raise exception using errcode = '55000', message = 'Query access plan is unavailable';
          end if;
        end if;
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
                record_type_id_value, v_storage_contract_id, record_type_item));
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
        while pg_catalog.cardinality(lookahead_ids) <= p_page_size loop
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
        if tree_mode and tree_parent_id is null then
          -- Root membership uses exact batched parent decisions, never the access superset.
          if not (scan_record.record_id = any (tree_root_child_ids)) then
            tree_root_child_ids := array[scan_record.record_id];
            while pg_catalog.cardinality(tree_root_child_ids) <= p_page_size loop
              fetch scan_cursor into lookahead_record;
              exit when not found;
              tree_root_child_ids := pg_catalog.array_append(tree_root_child_ids, lookahead_record.record_id);
            end loop;
            move absolute cursor_position from scan_cursor;
            tree_item := vortex_record.read_query_tree_relatives_internal(
              true, tree_root_child_ids, tree_relationship_id, context_organization_id,
              context_application_root_id, storage_plan, record_type_id_value, page_first_loaded,
              page_declaration, page_eligibility, page_shared, page_narrowed, validated_record_types,
              tree_filter);
            if tree_item ->> 'outcome' <> 'completed' then return tree_item; end if;
            select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
            into tree_root_nonroot_ids
            from pg_catalog.jsonb_array_elements_text(tree_item -> 'recordIds') as item(value);
          end if;
          if scan_record.record_id = any (tree_root_nonroot_ids) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          -- A root's unreadable parent must not be disclosed as a link value.
          readable_values := pg_catalog.jsonb_set(readable_values, array[tree_field_id], 'null'::jsonb);
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
          -- A search term matches only through a searchable field this row exposes
          -- to the reader; a field the reader cannot see never decides a match, so
          -- a hidden value can neither satisfy a search nor be inferred from one.
          -- Only a text or number value, or the text members of a list value, is
          -- searched; a structured value's JSON keys and identifiers never match.
          if board_shared_scan then
            -- The one scan serves every column: this row belongs to the column its readable
            -- choice value names, or to the unassigned column when it names no option. A row of a
            -- column that already holds its page and the card after it is not read again.
            board_column_index := (
              select requested.ordinality::integer
              from pg_catalog.jsonb_array_elements(board_columns) with ordinality
                as requested(value, ordinality)
              where case when (readable_values ? board_choice_field_id)
                  and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                  and (readable_values ->> board_choice_field_id) collate "C"
                    = any (board_option_values)
                then requested.value ->> 'kind' = 'option'
                  and (requested.value ->> 'value') collate "C"
                    = (readable_values ->> board_choice_field_id) collate "C"
                else requested.value ->> 'kind' = 'unassigned' end
              limit 1
            );
            if board_column_index is null or shared_more[board_column_index] then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
            rows_value := shared_rows[board_column_index];
            capability_rows := array(select item.value from pg_catalog.jsonb_array_elements(
              shared_capabilities[board_column_index]) as item(value));
            row_count := shared_counts[board_column_index];
            first_returned_record_id := shared_first_ids[board_column_index];
            first_returned_sort_key := case
              when pg_catalog.jsonb_typeof(shared_first_keys[board_column_index]) = 'array'
              then array(select item.value from pg_catalog.jsonb_array_elements_text(
                shared_first_keys[board_column_index]) as item(value)) end;
          elsif board_member_mode then
            if board_column_kind = 'option' then
              board_member_matches := (readable_values ? board_choice_field_id)
                and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                and (readable_values ->> board_choice_field_id) collate "C"
                  = board_column_value collate "C";
            else
              board_member_matches := not (
                (readable_values ? board_choice_field_id)
                and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                and (readable_values ->> board_choice_field_id) collate "C"
                  = any (board_option_values)
              );
            end if;
            if not board_member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if group_member_mode then
            group_member_matches := not exists (
              select 1 from pg_catalog.unnest(group_by_ids) as grouped(id)
              where not (readable_values ? grouped.id)
            );
            if group_member_matches and group_link_field_id is not null
              and group_selector_values -> group_link_field_id = '"not_available"'::jsonb then
              -- The group of unreadable targets: one protected title batch decides the targets of this
              -- row and the page's next candidates together; the cache holds each target once per call.
              if pg_catalog.jsonb_typeof(readable_values -> group_link_field_id) = 'object'
                and not (group_link_cache ? (readable_values -> group_link_field_id ->> 'recordId')) then
                group_link_values := array[readable_values -> group_link_field_id];
                while pg_catalog.cardinality(group_link_values) <= p_page_size loop
                  fetch scan_cursor into lookahead_record;
                  exit when not found;
                  group_link_values := pg_catalog.array_append(group_link_values, lookahead_record.group_link_value);
                end loop;
                move absolute cursor_position from scan_cursor;
                group_link_cache := vortex_record.group_link_unreadable_internal(
                  group_link_cache, group_link_values, fields_by_id -> group_link_field_id);
              end if;
              group_member_matches := coalesce(
                (group_link_cache ->> (readable_values -> group_link_field_id ->> 'recordId'))::boolean, false);
            elsif group_member_matches then
              select pg_catalog.jsonb_object_agg(grouped.id, vortex_record.grouping_value_internal(
                readable_values -> grouped.id, fields_by_id -> grouped.id ->> 'type', p_user_inputs #> '{grouping,dateBucket}'
              ))
              into group_candidate_values
              from pg_catalog.unnest(group_by_ids) as grouped(id);
              group_member_matches := group_candidate_values = group_selector_values;
            end if;
            if not group_member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if tree_mode and tree_parent_id is not null and not (
            pg_catalog.jsonb_typeof(readable_values -> tree_field_id) = 'object'
            and pg_catalog.lower(readable_values -> tree_field_id ->> 'recordId') = pg_catalog.lower(tree_parent_id::text)
          ) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          if user_search is not null and not projection_page_scan
            and not vortex_record.query_search_matches_internal(
            readable_values, search_field_ids, user_search
          ) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          if row_count = p_page_size then
            -- A shared scan's column with its page and a matching card after it has more cards;
            -- the scan ends only when every column has.
            if board_shared_scan then
              shared_more[board_column_index] := true;
              if pg_catalog.array_position(shared_more, false) is null then
                more_rows := true;
                exit;
              end if;
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
            more_rows := true;
            exit;
          end if;
          if row_count = 0 then
            first_returned_sort_key := scan_record.sort_key;
            first_returned_record_id := scan_record.record_id;
          end if;
          -- Keep the read facts and field bounds for one page-level capability
          -- decision after the readable page has been selected.
          capability_rows := pg_catalog.array_append(
            capability_rows,
            pg_catalog.jsonb_build_object(
              'recordId', scan_record.record_id, 'readBounds', read_row.read_bounds
            ) || case
              -- The page pass's compact record scope when it has one, also for
              -- the first record; its page-wide facts are the page envelope.
              when scan_record.record_id = any (decided_ids) then pg_catalog.jsonb_build_object('record',
                decided_loaded[pg_catalog.array_position(decided_ids, scan_record.record_id)])
              else pg_catalog.jsonb_build_object('readFacts', read_row.read_facts) end
          );
          rows_value := rows_value || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
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
          row_count := row_count + 1;
          last_returned_sort_key := scan_record.sort_key;
          last_returned_record_id := scan_record.record_id;
          if board_shared_scan then
            shared_rows[board_column_index] := rows_value;
            shared_capabilities[board_column_index] := pg_catalog.to_jsonb(capability_rows);
            shared_counts[board_column_index] := row_count;
            shared_first_keys[board_column_index] := pg_catalog.to_jsonb(first_returned_sort_key);
            shared_first_ids[board_column_index] := first_returned_record_id;
            shared_last_keys[board_column_index] := pg_catalog.to_jsonb(last_returned_sort_key);
            shared_last_ids[board_column_index] := last_returned_record_id;
          end if;
        end if;
      end if;
    end if;
    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;
  close scan_cursor;
  exit when not projection_page_scan or more_rows or projection_batch_exhausted
    or projection_reader_exhausted;
  projection_batch_size := least(p_page_size, scan_limit - projection_candidate_count);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
  into projection_batch
  from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
    null::uuid[], projection_sort_key, scan_directions[1], projection_after,
    projection_batch_size, projection_predicate) with ordinality as projected(organization_id,
    record_id, revision, attribute_values, ordinality);
  end loop;
  exit when more_rows or budget_exhausted;
  end loop;
  end if;
  -- The shared scan has read every column: this column's page state is the one its rows left,
  -- and its continuations are its own, never an earlier column's.
  if board_shared_scan then
    next_value := null;
    opposite_value := null;
    rows_value := shared_rows[board_column_position];
    capability_rows := array(select item.value from pg_catalog.jsonb_array_elements(
      shared_capabilities[board_column_position]) as item(value));
    row_count := shared_counts[board_column_position];
    more_rows := shared_more[board_column_position];
    first_returned_record_id := shared_first_ids[board_column_position];
    first_returned_sort_key := case
      when pg_catalog.jsonb_typeof(shared_first_keys[board_column_position]) = 'array'
      then array(select item.value from pg_catalog.jsonb_array_elements_text(
        shared_first_keys[board_column_position]) as item(value)) end;
    last_returned_record_id := shared_last_ids[board_column_position];
    last_returned_sort_key := case
      when pg_catalog.jsonb_typeof(shared_last_keys[board_column_position]) = 'array'
      then array(select item.value from pg_catalog.jsonb_array_elements_text(
        shared_last_keys[board_column_position]) as item(value)) end;
  end if;
  if projection_batch_exhausted and not more_rows then
    budget_exhausted := true;
    last_examined_sort_key := projection_last_sort_key;
    last_examined_record_id := projection_last_record_id;
  end if;
  if row_count > 0 then
    page_capabilities := vortex_record.read_record_capabilities_page_internal(
      record_type_id_value, pg_catalog.to_jsonb(capability_rows), page_shared -> 'envelope'
    );
    if pg_catalog.jsonb_typeof(page_capabilities) is distinct from 'array'
      or pg_catalog.jsonb_array_length(page_capabilities) <> row_count then
      raise exception using errcode = '55000', message = 'Page capabilities are unavailable';
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(page_capabilities) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
    ) then
      raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
    end if;
    -- Each row gets its own capabilities, in one pass over the page.
    select pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
        'capabilities', page_capabilities -> (item.ordinality::integer - 1)) order by item.ordinality)
    into rows_value
    from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
  end if;
  if tree_mode and row_count > 0 then
    select pg_catalog.array_agg((item.value ->> 'recordId')::uuid) into tree_candidates
    from pg_catalog.jsonb_array_elements(rows_value) as item(value);
    tree_item := vortex_record.read_query_tree_relatives_internal(
      false, tree_candidates, tree_relationship_id, context_organization_id,
      context_application_root_id, storage_plan, record_type_id_value, page_first_loaded,
      page_declaration, page_eligibility, page_shared, page_narrowed, validated_record_types,
      tree_filter);
    if tree_item ->> 'outcome' <> 'completed' then return tree_item; end if;
    -- A parent the examination budget did not decide has no answer yet: null, never a refusal.
    select pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
        'hasChildren', case when (tree_item -> 'undecidedIds') ? (item.value ->> 'recordId') then null
          else (tree_item -> 'recordIds') ? (item.value ->> 'recordId') end) order by item.ordinality)
    into rows_value
    from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
  end if;
  if more_rows then
    next_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(last_returned_sort_key),
      'phase', case when pg_catalog.cardinality(last_returned_sort_key) > 0
        and last_returned_sort_key[1] is null then 'null' else 'value' end,
      'recordId', last_returned_record_id
    );
  elsif budget_exhausted then
    next_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(last_examined_sort_key),
      'phase', case when pg_catalog.cardinality(last_examined_sort_key) > 0
        and last_examined_sort_key[1] is null then 'null' else 'value' end,
      'recordId', last_examined_record_id
    );
  end if;
  if first_returned_record_id is not null then
    opposite_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(first_returned_sort_key),
      'phase', case when pg_catalog.cardinality(first_returned_sort_key) > 0
        and first_returned_sort_key[1] is null then 'null' else 'value' end,
      'recordId', first_returned_record_id
    );
  end if;
  if p_direction = 'backward' and row_count > 1 then
    select pg_catalog.jsonb_agg(item.value order by item.ordinality desc)
    into rows_value
    from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
  end if;
  exit column_pass when not board_columns_mode;
  board_column_pages := board_column_pages || pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('column', board_column_item, 'rows', rows_value, 'next', next_value)
  );
  end loop column_pass;
  if preview_mode then
    -- No rows leave this invocation until the builder's authority is current
    -- again. Its role/group path can expire while the page is assembled;
    -- invocation-local reuse must never extend that permission deadline.
    if vortex_record.read_current_preview_installation_internal() -> 'previewInstallationId'
      is distinct from prepared_plan #> '{preview,previewInstallationId}' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  end if;
  if board_columns_mode then
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed',
      'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
      'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
      'columns', board_column_pages,
      'fieldBounds', pg_catalog.jsonb_build_object(
        'readableFieldIds', pg_catalog.to_jsonb(bound_field_ids),
        'searchable', search_field_ids && bound_field_ids
      )
    );
  end if;
  -- The reader's current field bound travels with the page, even an empty one: the fields it is
  -- guaranteed to see on every record it may read, and whether a search can match through any.
  -- A generic group member page also names its exact group.
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
    'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
    'rows', rows_value,
    'next', next_value,
    'opposite', opposite_value,
    'fieldBounds', pg_catalog.jsonb_build_object(
      'readableFieldIds', pg_catalog.to_jsonb(bound_field_ids),
      'searchable', search_field_ids && bound_field_ids
    )
  ) || case when group_member_mode then pg_catalog.jsonb_build_object(
    'groupByFieldIds', pg_catalog.to_jsonb(group_by_ids),
    'groupValues', group_selector_values
  ) else '{}'::jsonb end;
end
$function$;
alter function vortex_record.run_module_query(uuid,uuid,bigint,jsonb,jsonb,integer,jsonb,jsonb,jsonb,text,uuid[]) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid[])
  to vortex_request;
comment on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid[]) is
  'One bounded keyset page of rows readable through read_record for one installed Module query, or one exact current human-owned preview query over isolated preview storage, each carrying the record''s concurrency number and the per-row capabilities from read_record_capabilities, each action decided exactly as its own writer decides it, with only the declared Record system values, or one refusal before any row is exposed; accepts a bound list component''s declared sortable, filterable and searchable field sets together with the viewer''s chosen sort, typed filter and search term, refuses a sort or filter outside the declared sets, keeps a user sort only over a field the record type declares sortable and the reader is guaranteed to see, ANDs the user filter with the published filter so it can only narrow, and matches a search only through searchable fields the returned row exposes to the reader; returns with every plain page and board column read, even an empty one, the reader''s current field bound (the fields it is guaranteed to see on every record it may read, and whether any searchable field is among them) so a list offers and accepts its filter, search and sort controls from the same read; requires every filtered field to be declared filterable; pushes a filter or a sort into the candidate scan only for fields the reader is guaranteed to see for the whole record type, evaluates a filter on a possibly-withheld field per row, and keeps the keyset cursor over readable sort values and a record identity so no cursor carries a hidden field value and the scan order and budget never depend on one; narrows an installed scan with one predicate that OR-s every eligible alternative''s exact owner, owner-group and direct-share route test with its saved condition compiled over the record''s own catalogue columns where that condition can be expressed as a superset of the per-row decision, leaves the installed scan unrestricted where a route or condition has no exact stored form, and still decides every returned row through read_record; validates every preview stage against the current human, candidate revision and exact release and storage pins, uses only active preview catalogue mappings and preview field bounds, and never falls through to installed resolution; works out read-time fields, such as a deadline-passed calculation, inside an installed query at one statement timestamp in the organisation time zone, so no installed query is refused for freshness; admits board members only through a separately validated board selector over the sole filterable choice grouping key, reads one column''s member page or, for a board''s first pages, the first page of every requested column in one invocation with its own budget and position per column, classifies those columns from current readable values and, when the choice field is guaranteed readable on every scanned row, narrows each column''s candidate scan to its own stored choice value so a column reads only its own cards, and otherwise reads the table once for every column, each readable row going to the column its readable value names, and admits generic grouped members only when every installed grouping value is present in the current readable projection and JSONB-equal to the closed typed selector; missing or withheld values belong to no generic group while JSON null is a value, and generic group membership never uses hidden stored values, and a grid dimension narrows the stored candidate scan only after the field is proven guaranteed readable, with date bucket membership using the same authored-zone canonical value as the summary and typed half-open calendar ranges; reads one level of a tree over a one-record link of the record type to itself, either the roots (records whose parent no readable record matching the query''s filter and search holds, so an unreadable parent is never revealed and a matching record under a non-matching parent stays reachable) or the children of one parent, through the same keyset order, access scan, filter, search and exact per-row decision as a plain page, requiring the parent link to be a field the reader is guaranteed to see and reporting for every returned record, from one bounded set of rounds over the whole page rather than one query per row, whether the reader may read a child of it that matches the query, or that this is undecided when the rounds'' examination budget ran out; orders board pages by record identity and generic members by the requested or query order with bidirectional keysets, returns generic group identity and the reader''s field bound even for empty pages, and binds each member operation, selector and projection in its own uncached continuation; reads the copied records of a preview like installed ones and refuses a system projection in a preview; with a list of 1 to 200 distinct record ids it reads exactly those records in one page, each under the same scope, release, filter, search and readability decision as any row, and returns only those readable now.';

reset role;
