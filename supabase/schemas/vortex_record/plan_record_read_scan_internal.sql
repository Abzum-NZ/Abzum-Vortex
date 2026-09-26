create or replace function vortex_record.plan_record_read_scan_internal(
  p_record_type_id uuid
)
returns table (
  restricted boolean,
  owner_account_id uuid,
  owner_group_ids uuid[],
  shared_record_ids uuid[],
  readable_field_ids text[],
  access_predicate text,
  access_parameters jsonb
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
  required_permissions jsonb;
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
  exact_values boolean;
  parameter_offset integer;
  supported boolean;
  compiled jsonb;
  readable_field_ids_value text[];
  access_parameters_accum jsonb := '[]'::jsonb;
  access_predicate_value text := 'true';
  access_parameters_value jsonb := '[]'::jsonb;
begin
  -- Narrowing only. Any refusal or failure here leaves the scan unrestricted,
  -- so the exact per-row decision, which raises or refuses for the same cause,
  -- is the only thing that decides what a caller reads.
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
    vortex_module.read_current_active_installation()
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

  -- The declaration the record loader builds for a read: every record-scoped
  -- read permission declared for this exact record type by the context
  -- Application or the record type's own Module, in canonical order.
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'applicationRootId', context_application_root_id,
      'ownerKind', declared.value ->> 'ownerKind',
      'ownerId', (declared.value ->> 'ownerId')::uuid,
      'permissionId', declared.key::uuid
    )
    order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
  )
  into required_permissions
  from pg_catalog.jsonb_each(plan -> 'permissions') as declared(key, value)
  where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and declared.value ->> 'actionKind' = 'read'
    and (declared.value ->> 'namedAction') is null
    and (
      (declared.value ->> 'ownerKind') = 'application'
      or (declared.value ->> 'ownerId')::uuid = (target_meta ->> 'moduleRootId')::uuid
    );

  if required_permissions is null then
    return query select false, null::uuid, array[]::uuid[], array[]::uuid[],
      array[]::text[], null::text, '[]'::jsonb;
    return;
  end if;

  declaration := pg_catalog.jsonb_build_object(
    'operationKey', 'record.read',
    'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application', 'applicationRootId', context_application_root_id
    ),
    'requiredPermissions', required_permissions,
    'recordBinding', pg_catalog.jsonb_build_object(
      'moduleRootId', (target_meta ->> 'moduleRootId')::uuid,
      'recordTypeId', p_record_type_id,
      'storageContractId', (target_meta ->> 'storageContractId')::uuid,
      'storageScope', target_meta ->> 'storageScope'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  );

  -- The owner, owner-group and direct-share routes the scan can narrow, and the
  -- eligible alternatives reduced to their route lists and saved-condition
  -- envelopes. A null alternative list means no narrowing is possible.
  select routes.* into access_routes
  from vortex_access.resolve_record_read_scan_routes_internal(
    declaration, ownership_mode
  ) as routes;

  -- The fields this reader is guaranteed to see on every record the read
  -- decision admits. Any failure yields no fields, so the scan pushes neither
  -- an order nor a filter on a value it cannot prove is visible.
  begin
    field_bounds := vortex_access.resolve_record_read_field_bounds_internal(declaration);
  exception
    when others then
      field_bounds := '{}'::jsonb;
  end;

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
          exact_values := coalesce(target_meta ->> 'validationContractVersion', '')
            in ('2.0.0', '3.0.0');
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
              -- The exact (current Module contract) semantics of the
              -- saved-condition evaluator: calculation and total fields have no
              -- fixed stored value here and stay out of the map.
              semantic_type := case
                when exact_values and field_kind = 'decimal_number' then 'decimal_number'
                when exact_values and field_kind = 'money' then 'money'
                when field_kind in ('whole_number', 'decimal_number', 'money') then 'number'
                when field_kind = 'yes_no' then 'boolean'
                when field_kind = 'date' then 'date'
                when field_kind = 'date_time' then 'date_time'
                when field_kind = 'several_choices' then 'text_collection'
                when field_kind in ('table', 'attachment') then 'opaque_json'
                when field_kind in ('link', 'link_to_one_of_several') then 'record_reference'
                when field_kind = 'link_to_person' then 'organization_account_reference'
                when field_kind in (
                  'text', 'long_text', 'formatted_text', 'choice', 'reference_number',
                  'email_address', 'phone_number', 'web_address'
                ) then 'text'
                else null end;
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
              (semantic_type = 'boolean' and database_value_type = 'boolean')
              or (semantic_type = 'text' and database_value_type in ('text', 'json'))
              or (semantic_type = 'text_collection' and database_value_type = 'json')
              or (semantic_type = 'opaque_json' and database_value_type = 'json')
              or (semantic_type = 'money' and database_value_type = 'json')
              or (semantic_type = 'decimal_number' and database_value_type in ('decimal', 'text'))
              or (semantic_type = 'number' and database_value_type in ('integer', 'decimal'))
              or (semantic_type = 'date' and database_value_type in ('date', 'text'))
              or (semantic_type = 'date_time'
                and database_value_type in ('timestamp_with_time_zone', 'text'))
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
              when others then
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
    access_parameters_value;
  return;
exception
  when others then
    return query select false, null::uuid, array[]::uuid[], array[]::uuid[],
      array[]::text[], null::text, '[]'::jsonb;
    return;
end
$function$;

revoke all on function vortex_record.plan_record_read_scan_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.plan_record_read_scan_internal(uuid) is
  'Private read-scan narrowing for the record query: builds the read declaration for one record type of the exact active installation and returns the owner account, owner groups and directly shared record identifiers a caller can be admitted through, the fields every eligible read alternative is guaranteed to expose, kept only when every row the scan examines is one the exact decision admits, and one scan predicate that OR-s every eligible alternative''s exact route test with its saved condition compiled into the same scan; any route without an exact stored predicate or any condition the compiler cannot express as a superset is left unrestricted or true, so the per-row decision remains the only thing that decides access.';
