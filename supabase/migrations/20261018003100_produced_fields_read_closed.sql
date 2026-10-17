-- A produced field is readable only where everything it is produced from is readable (#2869).
-- One field-read decision for every reader: a calculation is readable only when every dependency,
-- through other calculations and totals, is readable under the reader's field policy, and a total
-- only when an unconditioned all-records read of its child record type guarantees the reader the
-- summed field and every filter field. Anything else is withheld, so lists, detail pages, queries,
-- sorts, filters, group summaries and the API all show it as Restricted. Exact-record reads take
-- their readable fields from decide_record_field_bounds_internal, and whole-record-type scans from
-- decide_record_type_read_bounds_internal; the per-record total walk and the calculation-only
-- filter they replace are removed.
set local role vortex_record_adapter;

-- record_type_read_declaration_internal
create or replace function vortex_record.record_type_read_declaration_internal(
  p_plan jsonb,
  p_record_type_id uuid,
  p_application_root_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  target_meta jsonb;
  required_permissions jsonb;
begin
  if p_record_type_id is null or p_application_root_id is null
    or pg_catalog.jsonb_typeof(p_plan -> 'recordTypes') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_plan -> 'permissions') is distinct from 'object' then
    raise exception using errcode = '22023',
      message = 'Record read declaration input is invalid';
  end if;
  target_meta := p_plan -> 'recordTypes' -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;

  -- The declaration the record loader builds for a read: every record-scoped
  -- read permission declared for this exact record type by the context
  -- Application or the record type's own Module, in canonical order.
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'applicationRootId', p_application_root_id,
      'ownerKind', declared.value ->> 'ownerKind',
      'ownerId', (declared.value ->> 'ownerId')::uuid,
      'permissionId', declared.key::uuid
    )
    order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
  )
  into required_permissions
  from pg_catalog.jsonb_each(p_plan -> 'permissions') as declared(key, value)
  where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and declared.value ->> 'actionKind' = 'read'
    and (declared.value ->> 'namedAction') is null
    and (
      (declared.value ->> 'ownerKind') = 'application'
      or (declared.value ->> 'ownerId')::uuid = (target_meta ->> 'moduleRootId')::uuid
    );

  -- No read permission is declared for the record type: nobody reads it.
  if required_permissions is null then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'operationKey', 'record.read',
    'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application', 'applicationRootId', p_application_root_id
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
end
$function$;

alter function vortex_record.record_type_read_declaration_internal(jsonb, uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.record_type_read_declaration_internal(jsonb, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.record_type_read_declaration_internal(jsonb, uuid, uuid) is
  'Private whole-record-type read declaration over one installation access plan: every record-scoped read permission the context Application or the record type''s own Module declares for the record type, or null when none is declared.';

-- decide_produced_field_ids_internal
create or replace function vortex_record.decide_produced_field_ids_internal(
  p_plan jsonb,
  p_record_type_id uuid,
  p_readable_field_ids jsonb,
  p_seen_record_type_ids jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  type_key text;
  fields_value jsonb;
  record_types_value jsonb;
  relationships_value jsonb;
  field_value jsonb;
  field_id text;
  dependency_id text;
  readable_ids text[];
  allowed_ids text[];
  contract_value jsonb;
  source_type_key text;
  source_bounds jsonb;
  source_bounds_by_type jsonb := '{}'::jsonb;
  required_field_ids jsonb;
  dependencies_allowed boolean;
  changed boolean := true;
begin
  if p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_plan -> 'recordTypes') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_readable_field_ids) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_seen_record_type_ids) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Produced field decision input is invalid';
  end if;
  type_key := pg_catalog.lower(p_record_type_id::text);
  fields_value := p_plan -> 'recordTypes' -> type_key -> 'fields';
  if pg_catalog.jsonb_typeof(fields_value) is distinct from 'array' then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;

  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into readable_ids
  from pg_catalog.jsonb_array_elements(p_readable_field_ids) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'string';

  -- Without a readable calculation or total the field policy alone decides.
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(fields_value) as field(value)
    where field.value ->> 'type' in ('calculation', 'total')
      and pg_catalog.lower(field.value ->> 'fieldId') = any (readable_ids)
  ) then
    return p_readable_field_ids;
  end if;

  -- Stored fields keep the visibility the field policy gave them.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value ->> 'fieldId')), array[]::text[])
  into allowed_ids
  from pg_catalog.jsonb_array_elements(fields_value) as field(value)
  where field.value ->> 'type' not in ('calculation', 'total')
    and pg_catalog.lower(field.value ->> 'fieldId') = any (readable_ids);

  -- A total is readable only when the reader can read every record it adds
  -- up and every field it uses there: an unconditioned all-records read of
  -- the child record type that guarantees the summed field, every filter
  -- field and the link fields that point here, each decided by this same
  -- rule. Any narrowing record scope, a
  -- refused or undeclared read, an unknown relationship or a cycle back to a
  -- record type still being decided leaves it Restricted.
  for field_value in
    select field.value
    from pg_catalog.jsonb_array_elements(fields_value) as field(value)
    where field.value ->> 'type' = 'total'
      and pg_catalog.lower(field.value ->> 'fieldId') = any (readable_ids)
  loop
    field_id := pg_catalog.lower(field_value ->> 'fieldId');
    if record_types_value is null then
      select coalesce(pg_catalog.jsonb_agg(meta.value order by meta.key collate "C"), '[]'::jsonb)
      into record_types_value
      from pg_catalog.jsonb_each(p_plan -> 'recordTypes') as meta(key, value);
      select coalesce(pg_catalog.jsonb_agg(declared.value order by declared.key collate "C"), '[]'::jsonb)
      into relationships_value
      from pg_catalog.jsonb_each(coalesce(p_plan -> 'relationships', '{}'::jsonb)) as declared(key, value);
    end if;
    contract_value := vortex_record.total_dependency_contract_internal(
      record_types_value, relationships_value, p_record_type_id, field_value
    );
    if contract_value is null then
      continue;
    end if;
    source_type_key := pg_catalog.lower(contract_value ->> 'sourceRecordTypeId');
    if p_seen_record_type_ids ? source_type_key then
      continue;
    end if;
    source_bounds := source_bounds_by_type -> source_type_key;
    if source_bounds is null then
      source_bounds := vortex_record.decide_record_type_read_bounds_internal(
        p_plan, (contract_value ->> 'sourceRecordTypeId')::uuid,
        p_seen_record_type_ids || pg_catalog.jsonb_build_array(type_key)
      );
      source_bounds_by_type := source_bounds_by_type
        || pg_catalog.jsonb_build_object(source_type_key, source_bounds);
    end if;
    -- Which child records a total covers is decided by their link to this
    -- record type, so every link field of the child record type that can
    -- point here is an input too. A child record type without one is an
    -- unknown relationship.
    select pg_catalog.jsonb_agg(pg_catalog.lower(field.value ->> 'fieldId'))
    into required_field_ids
    from pg_catalog.jsonb_array_elements(
      p_plan -> 'recordTypes' -> source_type_key -> 'fields'
    ) as field(value)
    where (field.value ->> 'type' = 'link'
        and pg_catalog.lower(field.value #>> '{settings,target,recordTypeId}') = type_key)
      or (field.value ->> 'type' = 'link_to_one_of_several'
        and pg_catalog.jsonb_typeof(field.value #> '{settings,targets}') = 'array'
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(field.value #> '{settings,targets}') as target(value)
          where pg_catalog.lower(target.value ->> 'recordTypeId') = type_key
        ));
    if required_field_ids is null then
      continue;
    end if;
    required_field_ids := required_field_ids || (contract_value -> 'sourceFieldIds');
    if (source_bounds -> 'coversAllRecords') = 'true'::jsonb
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(required_field_ids) as required(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements_text(source_bounds -> 'readableFieldIds') as guaranteed(value)
          where pg_catalog.lower(guaranteed.value) = pg_catalog.lower(required.value)
        )
      ) then
      allowed_ids := pg_catalog.array_append(allowed_ids, field_id);
    end if;
  end loop;

  -- A calculation is readable only when every field it depends on is: its
  -- declared dependencies, through other calculations and totals, to a fixed
  -- point over what is already allowed.
  while changed loop
    changed := false;
    for field_value in
      select field.value
      from pg_catalog.jsonb_array_elements(fields_value) as field(value)
      where field.value ->> 'type' = 'calculation'
        and pg_catalog.lower(field.value ->> 'fieldId') = any (readable_ids)
        and pg_catalog.lower(field.value ->> 'fieldId') <> all (allowed_ids)
    loop
      field_id := pg_catalog.lower(field_value ->> 'fieldId');
      if pg_catalog.jsonb_typeof(field_value -> 'settings' -> 'dependencyFieldIds') is distinct from 'array' then
        continue;
      end if;
      dependencies_allowed := true;
      for dependency_id in
        select pg_catalog.lower(item.value #>> '{}')
        from pg_catalog.jsonb_array_elements(field_value -> 'settings' -> 'dependencyFieldIds') as item(value)
      loop
        if dependency_id is null or dependency_id <> all (allowed_ids) then
          dependencies_allowed := false;
          exit;
        end if;
      end loop;
      if dependencies_allowed then
        allowed_ids := pg_catalog.array_append(allowed_ids, field_id);
        changed := true;
      end if;
    end loop;
  end loop;

  return coalesce((
    select pg_catalog.jsonb_agg(item.value order by item.ordinality)
    from pg_catalog.jsonb_array_elements(p_readable_field_ids)
      with ordinality as item(value, ordinality)
    where pg_catalog.jsonb_typeof(item.value) = 'string'
      and pg_catalog.lower(item.value #>> '{}') = any (allowed_ids)
  ), '[]'::jsonb);
end
$function$;

alter function vortex_record.decide_produced_field_ids_internal(jsonb, uuid, jsonb, jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.decide_produced_field_ids_internal(jsonb, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.decide_produced_field_ids_internal(jsonb, uuid, jsonb, jsonb) is
  'Private field-read decision for produced fields, applied to the fields a reader''s field policy allows on one record type of one installation access plan: a total stays readable only when an unconditioned all-records read of its child record type guarantees the reader its summed and filter fields and the link fields that point to the total''s record type, and a calculation only when every dependency is readable, transitively; anything else is withheld and shown as Restricted. Fails closed on an unknown relationship, a refused child read and a cycle of totals.';

-- decide_record_type_read_bounds_internal
create or replace function vortex_record.decide_record_type_read_bounds_internal(
  p_plan jsonb,
  p_record_type_id uuid,
  p_seen_record_type_ids jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  -- Nothing guaranteed and no exactness claim: the fail-closed answer.
  nothing constant jsonb := '{"readableFieldIds":[],"coversAllRecords":false,"conditionFree":false}'::jsonb;
  context_value jsonb;
  declaration jsonb;
  bounds jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  if p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_seen_record_type_ids) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Record type read bounds input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not (context_value ? 'applicationRootId')
    or (p_plan ->> 'organizationId')::uuid is distinct from (context_value ->> 'organizationId')::uuid
    or (p_plan ->> 'applicationRootId')::uuid is distinct from (context_value ->> 'applicationRootId')::uuid then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  declaration := vortex_record.record_type_read_declaration_internal(
    p_plan, p_record_type_id, (context_value ->> 'applicationRootId')::uuid
  );
  if declaration is null then
    return nothing;
  end if;

  -- The fields this reader is guaranteed to see on every record the read
  -- decision admits. A refused access context guarantees no field; any other
  -- failure propagates.
  begin
    bounds := vortex_access.resolve_record_read_field_bounds_internal(declaration);
  exception
    when sqlstate '42501' then
      get stacked diagnostics failure_sqlstate = returned_sqlstate,
        failure_message = message_text;
      raise warning 'Record read field bounds were refused: SQLSTATE %, %',
        failure_sqlstate, failure_message;
      return nothing;
  end;

  -- Produced fields are guaranteed only where the one field-read decision
  -- shows them.
  return bounds || pg_catalog.jsonb_build_object(
    'readableFieldIds', vortex_record.decide_produced_field_ids_internal(
      p_plan, p_record_type_id, bounds -> 'readableFieldIds', p_seen_record_type_ids
    )
  );
end
$function$;

alter function vortex_record.decide_record_type_read_bounds_internal(jsonb, uuid, jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.decide_record_type_read_bounds_internal(jsonb, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.decide_record_type_read_bounds_internal(jsonb, uuid, jsonb) is
  'Private whole-record-type read bounds for the current reader: the fields every record the read decision admits is guaranteed to expose, after the field-read decision for produced fields, whether an unconditioned all-records alternative admits every active record, and whether no alternative carries a saved condition; a refused context or an undeclared read yields no fields.';

-- decide_record_field_bounds_internal
create or replace function vortex_record.decide_record_field_bounds_internal(
  p_decision jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  bounds jsonb;
  record_type_id_value uuid;
  preview_installation jsonb;
  plan jsonb;
  readable_ids jsonb;
begin
  -- The one field-read decision for an exact record: the field policy of the
  -- contributions the access decision matched, then the rule for produced
  -- fields. Every reader of record values takes its readable fields here.
  bounds := vortex_access.resolve_record_field_bounds_internal(p_decision);
  if not pg_catalog.pg_input_is_valid(p_decision #>> '{recordBinding,recordTypeId}', 'uuid') then
    raise exception using errcode = '22023',
      message = 'Record field bounds require a record binding';
  end if;
  record_type_id_value := (p_decision #>> '{recordBinding,recordTypeId}')::uuid;

  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    raise exception using errcode = '42501',
      message = 'Record installation is unavailable';
  end if;
  plan := vortex_record.resolve_installation_access_plan_internal(
    coalesce(preview_installation, vortex_definition.read_current_active_installation())
  );
  if (plan ->> 'organizationId')::uuid is distinct from (p_decision ->> 'organizationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  readable_ids := vortex_record.decide_produced_field_ids_internal(
    plan, record_type_id_value, bounds -> 'readableFieldIds', '[]'::jsonb
  );
  -- Changeable never exceeds readable.
  return pg_catalog.jsonb_build_object(
    'readableFieldIds', readable_ids,
    'changeableFieldIds', coalesce((
      select pg_catalog.jsonb_agg(item.value order by item.ordinality)
      from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds')
        with ordinality as item(value, ordinality)
      where readable_ids @> pg_catalog.jsonb_build_array(item.value)
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_record.decide_record_field_bounds_internal(jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.decide_record_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.decide_record_field_bounds_internal(jsonb) is
  'Private field-read decision over one allowed exact-record access decision: the readable and changeable fields of the matched contributions'' field policies, with every calculation and total the reader may not fully read withheld so that every reader shows it as Restricted.';

-- plan_record_read_scan_internal
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
    vortex_definition.read_current_active_installation()
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
      array[]::text[], 'false'::text, '[]'::jsonb;
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
              -- The exact (current Module contract) semantics of the
              -- saved-condition evaluator: calculation and total fields have no
              -- fixed stored value here and stay out of the map.
              semantic_type := case
                when field_kind = 'decimal_number' then 'decimal_number'
                when field_kind = 'money' then 'money'
                when field_kind = 'whole_number' then 'number'
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
              or (semantic_type = 'decimal_number' and database_value_type = 'decimal')
              -- A version-1 decimal field is a number to the condition engine
              -- but is projected as decimal text, which that engine refuses;
              -- only a whole number is stored as the number it compares.
              or (semantic_type = 'number' and database_value_type = 'integer')
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
    access_parameters_value;
  return;
end
$function$;

alter function vortex_record.plan_record_read_scan_internal(uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.plan_record_read_scan_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.plan_record_read_scan_internal(uuid) is
  'Private read-scan narrowing for the record query: builds the read declaration for one record type of the exact active installation and returns the owner account, owner groups and directly shared record identifiers a caller can be admitted through, the fields every eligible read alternative is guaranteed to expose, kept only when every row the scan examines is one the exact decision admits, and one scan predicate that OR-s every eligible alternative''s exact route test with its saved condition compiled into the same scan; any route without an exact stored predicate or any condition the compiler cannot express as a superset is left unrestricted or true, so the per-row decision remains the only thing that decides access.';

-- read_record_page_decisions_internal
create or replace function vortex_record.read_record_page_decisions_internal(
  p_record_type_id uuid,
  p_first_loaded jsonb,
  p_page_declaration jsonb,
  p_page_eligibility jsonb,
  p_record_ids uuid[],
  p_envelope jsonb,
  p_narrowed boolean
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
  decisions jsonb;
  decision_item jsonb;
  facts_item jsonb;
  bounds_by_route jsonb := '{}'::jsonb;
  bounds_key text;
  row_position integer;
begin
  -- The page's read decisions in one pass. The first record's facts, loaded by
  -- the exact loader in this invocation, supply the installation-wide part of
  -- every record's facts; each record contributes only its own stored row. A
  -- record type whose read facts can reach other records (an inherited owner
  -- or a relationship route) is not decided here at all, and neither is a
  -- preview, a protected projection or an expired page eligibility. Each
  -- decided record is returned as its compact record scope (its own stored
  -- fact, concurrency number and definition revision); with the page envelope
  -- the caller built once from the first record's facts
  -- (read_record_page_envelope_internal), it is exactly the facts the exact
  -- loader gives that record.
  if p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_envelope) is distinct from 'object'
    or p_narrowed is null
    or p_envelope -> 'declaration' is distinct from p_page_declaration
    or p_envelope -> 'context' is distinct from p_first_loaded -> 'context'
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
    loaded := pg_catalog.jsonb_build_object(
      'record', facts_item,
      'concurrencyNumber', page_concurrency[row_position],
      'definitionRevision', page_definition_revisions[row_position]);
    if decision_item ->> 'outcome' = 'allowed' then
      -- The same contributions have the same field policy: resolve each
      -- distinct contribution set once for the page.
      bounds_key := pg_catalog.jsonb_build_array(
        decision_item -> 'organizationId', decision_item -> 'matchedContributions')::text;
      bounds := bounds_by_route -> bounds_key;
      if bounds is null then
        bounds := vortex_record.decide_record_field_bounds_internal(decision_item);
        bounds_by_route := bounds_by_route || pg_catalog.jsonb_build_object(bounds_key, bounds);
      end if;
    end if;
    return next;
  end loop;
end
$function$;

alter function vortex_record.read_record_page_decisions_internal(uuid,jsonb,jsonb,jsonb,uuid[],jsonb,boolean)
  owner to vortex_record_adapter;
revoke all on function vortex_record.read_record_page_decisions_internal(uuid,jsonb,jsonb,jsonb,uuid[],jsonb,boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_page_decisions_internal(uuid,jsonb,jsonb,jsonb,uuid[],jsonb,boolean) is
  'Private page read pass for the fixed record adapter: loads the stored facts of every candidate record of one page in one statement, decides them together through the set-based exact decision with the page eligibility computed once in this invocation, and resolves field bounds once per distinct contribution set; each decided record is returned as its compact record scope, which with the page envelope built once for the page is the facts the exact loader would give it; returns only records it decided, so every other record keeps the exact single-record path.';

reset role;
set local role vortex_owner;

-- read_record_projection_with_validated_types_internal
create or replace function vortex_record.read_record_projection_with_validated_types_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_page_declaration jsonb,
  p_page_eligibility jsonb,
  p_validated_record_types jsonb,
  p_projection_row jsonb,
  p_loaded jsonb,
  p_decision jsonb,
  p_bounds jsonb,
  p_page jsonb
)
returns table (projection jsonb, read_facts jsonb, read_bounds jsonb)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  loaded jsonb;
  -- The page-wide part of the facts (the envelope) when this record arrives
  -- as a compact record scope; otherwise the record's own complete facts.
  shared jsonb;
  compact boolean;
  decision jsonb;
  bounds jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
  field_values jsonb;
  read_time_fields jsonb;
  read_time_clock jsonb;
  read_time_expression jsonb;
  read_time_value jsonb;
  preview_meta jsonb;
  preview_bounds jsonb;
  due_key text;
  status_key text;
  due_value jsonb;
  status_value jsonb;
  batched boolean := false;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    projection := pg_catalog.jsonb_build_object('outcome', 'refused');
    return next;
    return;
  end if;
  -- A page passes the page-wide part of the facts once (p_page.envelope) and
  -- each decided record as its compact record scope; the complete facts are
  -- rebuilt only on the paths that read more than this record's own values.
  compact := p_loaded is not null and p_loaded ? 'record'
    and pg_catalog.jsonb_typeof(p_page -> 'envelope') = 'object';
  if p_loaded is not null and p_loaded ? 'record' and not compact then
    raise exception using errcode = '22023', message = 'Page record facts are invalid';
  end if;
  loaded := case when compact then null else p_loaded end;
  if loaded is null and not compact then
    if p_page ? 'installation' then
      -- The active installation this invocation read and validated once.
      loaded := vortex_record.load_record_access_facts_from_installation_internal(
        p_record_type_id, 'read', p_record_id, null, p_page -> 'installation', p_projection_row
      );
    else
      loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'read', p_record_id, null, p_projection_row
      );
    end if;
  end if;
  shared := case when compact then p_page -> 'envelope' else loaded end;
  if p_loaded is not null and shared ->> 'outcome' = 'loaded' and (
    shared -> 'facts' -> 'binding' ->> 'recordTypeId' is distinct from
      pg_catalog.lower(p_record_type_id::text)
    or case when compact
      then p_loaded -> 'record' -> 'recordScope' ->> 'recordId' is distinct from pg_catalog.lower(p_record_id::text)
      else not exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
        where item.value -> 'recordScope' ->> 'recordId' = pg_catalog.lower(p_record_id::text)
      ) end
  ) then
    raise exception using errcode = '22023', message = 'Page record facts are invalid';
  end if;
  if shared ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(shared -> 'declaration') <> 'object' then
    projection := pg_catalog.jsonb_build_object('outcome', 'refused');
    return next;
    return;
  end if;
  if shared ? 'previewInstallationId' then
    loaded := coalesce(loaded, vortex_record.read_record_page_row_facts_internal(shared, p_loaded));
    preview_meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'read'
    );
    preview_bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (preview_meta ->> 'storageContractId')::uuid,
      preview_meta -> 'recordType'
    );
    if preview_bounds is null then
      projection := pg_catalog.jsonb_build_object('outcome', 'refused');
      return next;
      return;
    end if;
    bounds := preview_bounds;
  else
    if p_decision is not null then
      -- The page's set pass decided this exact record in this invocation from
      -- these facts; only the fixed record adapter can pass it.
      if p_loaded is null
        or p_decision ->> 'recordId' is distinct from pg_catalog.lower(p_record_id::text) then
        raise exception using errcode = '22023', message = 'Page record decision is invalid';
      end if;
      -- It is used only while it is still current now: an allowed decision
      -- whose own deadline (every matched permission path, share and group
      -- membership) and the page eligibility are both still in the future.
      -- Anything else is decided again exactly, at this row's own time.
      batched := coalesce(p_decision ->> 'outcome' = 'allowed'
        and (p_decision ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp()
        and p_page_eligibility ->> 'outcome' = 'eligible'
        and (p_page_eligibility ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp(), false);
    end if;
    if batched then
      decision := p_decision;
    else
      loaded := coalesce(loaded, vortex_record.read_record_page_row_facts_internal(shared, p_loaded));
      if p_page_eligibility ->> 'outcome' = 'eligible'
        and loaded -> 'declaration' = p_page_declaration
        and (p_page_eligibility ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp() then
        decision := vortex_access.evaluate_record_access_with_validated_types_internal(
          loaded -> 'declaration', p_record_id, loaded -> 'facts', p_page_eligibility,
          p_validated_record_types
        );
      else
        decision := vortex_access.evaluate_organization_record_access_internal(
          loaded -> 'declaration', p_record_id, loaded -> 'facts'
        );
      end if;
    end if;
    if decision ->> 'outcome' <> 'allowed' then
      projection := pg_catalog.jsonb_build_object('outcome', 'refused');
      -- A decision, even a refusal, means the record types passed validation;
      -- the page reuses them. Callers read read_facts only for allowed rows.
      read_facts := pg_catalog.jsonb_build_object(
        'validatedRecordTypes', shared -> 'facts' -> 'recordTypes'
      );
      return next;
      return;
    end if;
    bounds := coalesce(case when batched then p_bounds end,
      vortex_record.decide_record_field_bounds_internal(decision));
  end if;
  field_values := case when compact then p_loaded -> 'record' -> 'fieldValues'
    else loaded -> 'fieldValues' end;
  -- Read-time calculations are worked out here, at one statement timestamp in
  -- the organisation's time zone, from the record's stored values. They are
  -- never read from storage. A page works out the record type's read-time
  -- fields and the statement's clock once and passes them here.
  if compact and p_page ? 'readTimeFields' then
    read_time_fields := p_page -> 'readTimeFields';
  else
    select coalesce(pg_catalog.jsonb_object_agg(pg_catalog.lower(field.value ->> 'fieldId'), field.value), '{}'::jsonb)
    into read_time_fields
    from pg_catalog.jsonb_array_elements(shared -> 'facts' -> 'recordTypes') as record_type(value)
    cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
    where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
      and field.value ->> 'type' = 'calculation'
      and (field.value #>> '{settings,evaluation}' = 'read_time'
        or field.value #>> '{settings,expression,kind}' = 'deadline_passed');
  end if;
  if read_time_fields <> '{}'::jsonb then
    read_time_clock := case when compact and p_page ? 'readTimeClock' then p_page -> 'readTimeClock'
      else vortex_record.read_time_clock_internal() end;
  end if;
  if read_time_fields = '{}'::jsonb then
    -- Without read-time fields every readable stored value is projected as
    -- stored: one statement instead of one step per field.
    select coalesce(pg_catalog.jsonb_object_agg(item.value #>> '{}', field_values -> (item.value #>> '{}')
        order by item.ordinality), '{}'::jsonb)
    into values_value
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') with ordinality as item(value, ordinality)
    where shared -> 'columns' ? (item.value #>> '{}');
  end if;
  for field_id in
    select item.value #>> '{}' from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
    where read_time_fields <> '{}'::jsonb
  loop
    if not (shared -> 'columns' ? field_id) then
      continue;
    end if;
    if read_time_fields ? pg_catalog.lower(field_id) then
      read_time_expression := read_time_fields -> pg_catalog.lower(field_id) #> '{settings,expression}';
      -- Only the deadline-passed form is defined; another read-time form is
      -- withheld rather than disclosed from a stored column.
      if read_time_expression ->> 'kind' is distinct from 'deadline_passed' then
        continue;
      end if;
      due_key := pg_catalog.lower(read_time_expression ->> 'dueFieldId');
      status_key := pg_catalog.lower(read_time_expression ->> 'statusFieldId');
      due_value := field_values -> due_key;
      status_value := case when status_key is null then null else field_values -> status_key end;
      if status_value is not null and status_value <> 'null'::jsonb and exists (
        select 1
        from pg_catalog.jsonb_array_elements(coalesce(read_time_expression -> 'terminalStatusValues', '[]'::jsonb))
          as terminal(value)
        where terminal.value = status_value
      ) then
        read_time_value := 'false'::jsonb;
      elsif pg_catalog.jsonb_typeof(due_value) = 'string'
        and shared -> 'columns' -> due_key ->> 'databaseValueType' = 'date' then
        -- Without the organisation's time zone the local date is unknown.
        if read_time_clock ->> 'organizationLocalDate' is null then
          continue;
        end if;
        read_time_value := pg_catalog.to_jsonb((read_time_clock ->> 'organizationLocalDate') > (due_value #>> '{}'));
      elsif pg_catalog.jsonb_typeof(due_value) = 'string'
        and shared -> 'columns' -> due_key ->> 'databaseValueType' = 'timestamp_with_time_zone' then
        read_time_value := pg_catalog.to_jsonb(
          (read_time_clock ->> 'instant')::timestamp with time zone
            >= (due_value #>> '{}')::timestamp with time zone
        );
      else
        read_time_value := 'null'::jsonb;
      end if;
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, read_time_value);
    else
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, field_values -> field_id);
    end if;
  end loop;
  projection := pg_catalog.jsonb_build_object('outcome', 'allowed', 'recordId', p_record_id,
    'concurrencyNumber', case when compact then p_loaded -> 'concurrencyNumber'
      else loaded -> 'concurrencyNumber' end,
    'values', values_value);
  -- A compact record keeps its compact scope; the caller holds the envelope.
  read_facts := case when compact then p_loaded else loaded end;
  read_bounds := bounds;
  return next;
end
$function$;

alter function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  to vortex_record_adapter;

reset role;
set local role vortex_record_adapter;

-- prepare_base_record_save
create or replace function vortex_record.prepare_base_record_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  installation jsonb;
  application_content jsonb;
  unsupported boolean := false;
  context_value jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  effective_command_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  receipt_claim jsonb;
  projection jsonb;
  decision jsonb;
  bounds jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    )) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', effective_command_id, true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_id_value
      );
    end if;
    projection := vortex_record.read_record(
      p_record_type_id, (receipt_claim ->> 'recordId')::uuid
    );
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', correlation_id_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  );
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
    or (preview_installation is not null and meta ? 'recordType'
      and meta -> 'recordType' ? 'systemProjection') then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  installation := case when preview_installation is null
    then vortex_definition.read_current_active_installation()
    else preview_installation end;

  select release.record_content
  into strict application_content
  from vortex_definition.runtime_releases as release
  where release.root_id = (meta -> 'context' ->> 'applicationRootId')::uuid
    and release.release_revision =
      (installation ->> 'applicationReleaseRevision')::bigint;

  unsupported := exists (
    select 1
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as field(value)
    where field.value ->> 'type' = 'total'
  ) or exists (
    -- #578: Record evaluates the owning Module release's rules (`beforeSaveRules`);
    -- an Application rule on this record type cannot be evaluated and refuses.
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'rules', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
      pg_catalog.lower(p_record_type_id::text)
  );

  if unsupported then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported',
      'correlationId', meta -> 'context' -> 'correlationId'
    );
  end if;

  if meta -> 'recordType' ? 'systemProjection' then
    if p_operation <> 'update'
      or meta #>> '{recordType,key}' <> 'organization_settings'
      or meta #>> '{recordType,systemProjection,protectedView}' <>
        'organization_runtime_settings'
      or not coalesce(
        (meta #> '{recordType,standardActions}') ? 'update', false
      )
      or not vortex_definition.is_system_projection_module_internal(
        (meta ->> 'moduleRootId')::uuid, organization_id_value
      )
      or p_record_id is distinct from
        (meta -> 'context' ->> 'organizationId')::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;

    -- Do not execute application before-save rules for this projection until
    -- the platform settings-manage permission has passed its own current check.
    if not vortex_access.organization_runtime_settings_manage_is_current() then
      perform vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', organization_id_value,
        array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded',
        'correlationId', correlation_id_value
      );
    end if;

    -- The writable system projection is prepared through its protected read
    -- model. Its final write remains inside apply_record_changes.
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'read', p_record_id, null, null::jsonb
    );
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_base_save_activity_internal(
          p_activity_id, 'update', organization_id_value,
          array[]::uuid[], 'refused'
        );
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_record.decide_record_field_bounds_internal(decision);
    else
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'recordType', meta -> 'recordType',
      'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
        (meta ->> 'moduleRootId')::uuid,
        (meta ->> 'moduleReleaseRevision')::bigint,
        p_record_type_id
      ),
      'correlationId', correlation_id_value,
      'readableFieldIds', bounds -> 'readableFieldIds',
      'existingValues', loaded -> 'fieldValues'
    );
  end if;

  if p_operation = 'update' then
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if loaded ? 'previewInstallationId' then
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    else
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_base_save_activity_internal(
          p_activity_id, 'update', organization_id_value,
          array[]::uuid[], 'refused'
        );
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_record.decide_record_field_bounds_internal(decision);
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'recordType', meta -> 'recordType',
    -- #578: the owning Module release's rules for this record type, evaluated by Record.
    'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'correlationId', meta -> 'context' -> 'correlationId',
    'readableFieldIds', case when p_operation = 'update'
      then bounds -> 'readableFieldIds' else '[]'::jsonb end,
    'existingValues', case when p_operation = 'update'
      then loaded -> 'fieldValues' else '{}'::jsonb end
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Record save preparation refused: % (%)', failure_message, failure_sqlstate;
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_base_record_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Server-only operation-scoped preparation read for one exact active installed or owner-validated preview base Record save.';

-- prepare_named_action_set_announce_internal
create or replace function vortex_record.prepare_named_action_set_announce_internal(
  p_preview boolean,
  p_command_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_inputs jsonb,
  p_activity_id uuid,
  p_read_loaded jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt_claim jsonb;
  action_context jsonb;
  creation_plan jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  projection jsonb;
  copy_plan jsonb;
  copy_targets jsonb := '[]'::jsonb;
  copy_target record;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  record_type_meta jsonb;
  reused_read_facts boolean := false;
begin
  if p_preview is null or p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  context_value := vortex_access.validated_human_request_context();
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'named_action', p_command_id, true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    projection := vortex_record.project_named_action_record_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id
    );
    -- #571: a deleting action's subject is soft-deleted, so it cannot be
    -- projected; its replay is the delete's own stored outcome.
    if projection ->> 'outcome' <> 'completed' then
      projection := coalesce(
        vortex_record.named_action_deleted_subject_replay_internal(
          p_command_id, p_action_owner_kind, p_action_owner_id,
          p_action_release_revision, p_action_id, p_record_type_id
        ),
        projection
      );
    end if;
    if projection ->> 'outcome' <> 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    return projection;
  end if;

  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  if coalesce((action_context ->> 'rulesUnsupported')::boolean, false)
    or pg_catalog.jsonb_typeof(action_context -> 'action' -> 'tasks') is distinct from 'array'
    or pg_catalog.jsonb_array_length(action_context -> 'action' -> 'tasks') not between 1 and 10
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(
        action_context -> 'action' -> 'tasks'
      ) item(value)
      where item.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')
    ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  creation_plan := vortex_record.named_action_creation_plan_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, null, action_context
  );
  if creation_plan ->> 'outcome' <> 'planned' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  -- A preview of a record its caller has just read in this invocation reuses
  -- that read's facts when they are exactly the facts the named loader would
  -- build: the record alone, with no inherited owner, no edge and no
  -- relationship route on any of the action's permissions. Only the fixed
  -- record adapter can pass them; the action's own decision is still made below.
  record_type_meta := p_read_loaded -> 'recordTypeMeta';
  if p_preview and p_read_loaded ->> 'outcome' = 'loaded'
    and not (p_read_loaded ? 'previewInstallationId')
    and (p_read_loaded ->> 'isSystemProjection')::boolean is false
    and p_read_loaded -> 'context' = context_value
    and pg_catalog.jsonb_typeof(record_type_meta) = 'object'
    and pg_catalog.lower(record_type_meta ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and coalesce(record_type_meta ->> 'ownershipMode', '') <> 'inherited'
    and p_read_loaded #> '{facts,binding}' = action_context #> '{declaration,recordBinding}'
    and pg_catalog.jsonb_array_length(p_read_loaded #> '{facts,records}') = 1
    and p_read_loaded #>> '{facts,records,0,recordScope,recordId}' = pg_catalog.lower(p_record_id::text)
    and p_read_loaded #> '{facts,edges}' = '[]'::jsonb
    and pg_catalog.jsonb_typeof(action_context #> '{declaration,requiredPermissions}') = 'array'
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(action_context #> '{declaration,requiredPermissions}') as required(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_read_loaded -> 'accessPermissions'
            -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes') = 'array'
          then p_read_loaded -> 'accessPermissions'
            -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes'
          else '[{"kind": "relationship"}]'::jsonb end
      ) as route(value)
      where route.value ->> 'kind' = 'relationship'
    ) then
    loaded := pg_catalog.jsonb_build_object(
      'outcome', 'loaded',
      'declaration', action_context -> 'declaration',
      'facts', p_read_loaded -> 'facts',
      'concurrencyNumber', p_read_loaded -> 'concurrencyNumber',
      'fieldValues', p_read_loaded -> 'fieldValues'
    );
    reused_read_facts := true;
  else
    loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id,
      case when p_preview then null else p_expected_concurrency_number end
    );
  end if;
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  if p_preview and (loaded ->> 'concurrencyNumber')::bigint <>
      p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  -- Read facts reused above keep the record types their read decision
  -- validated in this invocation; the named loader's own facts are validated in full.
  decision := vortex_access.evaluate_record_access_with_validated_types_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts', null,
    case when reused_read_facts then loaded #> '{facts,recordTypes}' end
  );
  if decision ->> 'outcome' <> 'allowed' then
    if p_preview then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'refused'
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused_recorded', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
  -- Use the same locked copy plan the writer re-derives. Only rows with an
  -- actual new edge are evaluated; a no-op copy does not save its target.
  copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_inputs, action_context
  );
  if copy_plan ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  for copy_target in
    select (item.value ->> 'targetRecordId')::uuid as record_id,
      pg_catalog.jsonb_object_agg(
        item.value ->> 'fromFieldId', item.value -> 'value'
      ) as submitted_values
    from pg_catalog.jsonb_array_elements(
      coalesce(copy_plan -> 'copies', '[]'::jsonb)
    ) item(value)
    group by 1
    order by 1
  loop
    target_meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'update'
    );
    target_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', copy_target.record_id, null, null::jsonb
    );
    if target_loaded ->> 'outcome' is distinct from 'loaded' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_copy_target_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    target_decision := vortex_access.evaluate_organization_record_access_internal(
      target_meta -> 'declaration', copy_target.record_id,
      (target_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', target_meta -> 'declaration' -> 'recordBinding'
      )
    );
    if target_decision ->> 'outcome' is distinct from 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_object_keys(copy_target.submitted_values) field_id
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements_text(
          vortex_record.decide_record_field_bounds_internal(target_decision)
            -> 'changeableFieldIds'
        ) allowed(value)
        where pg_catalog.lower(allowed.value) = pg_catalog.lower(field_id)
      )
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    copy_targets := copy_targets || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordId', copy_target.record_id,
        'existingValues', target_loaded -> 'fieldValues',
        'submittedValues', copy_target.submitted_values
      )
    );
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', case when p_preview then 'previewed' else 'prepared' end,
    'action', action_context -> 'action',
    'validationContractVersion', action_context -> 'validationContractVersion',
    'recordType', action_context -> 'recordType',
    -- #578: the owning Module release's rules for the subject, evaluated by Record.
    'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
      (action_context ->> 'moduleRootId')::uuid,
      (action_context ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'createTargets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'ordinal', item.value -> 'ordinal',
          'recordTypeId', item.value -> 'recordTypeId',
          'recordType', item.value -> 'recordType',
          'beforeSaveRules', item.value -> 'beforeSaveRules'
        ) order by (item.value ->> 'ordinal')::integer
      )
      from pg_catalog.jsonb_array_elements(creation_plan -> 'createTargets') item(value)
    ), '[]'::jsonb),
    'copyTargets', copy_targets,
    'recordId', p_record_id,
    'existingValues', loaded -> 'fieldValues',
    -- A singleton required permission was decided by the named-action access
    -- check above. The Record port may use it for a choice gated by that exact
    -- permission; a multi-permission declaration grants no such shortcut.
    'singleRequiredPermissionId', case
      when pg_catalog.jsonb_array_length(
        loaded #> '{declaration,requiredPermissions}'
      ) = 1 then loaded #> '{declaration,requiredPermissions,0,permissionId}'
      else 'null'::jsonb
    end,
    'readableFieldIds', bounds -> 'readableFieldIds',
    'changeableFieldIds', bounds -> 'changeableFieldIds',
    'eventDescriptors', action_context -> 'eventDescriptors',
    'actorOrganizationAccountId', context_value -> 'organizationAccountId',
    'correlationId', context_value -> 'correlationId'
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_named_action_set_announce_internal(
  boolean, uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_named_action_set_announce_internal(
  boolean, uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, uuid, jsonb
) is
  'Private named-action preparation: replays or refuses by command receipt, then returns the facts, permission decision and bounds of the exact installed action, writing nothing; a preview may reuse the read facts its fixed adapter caller loaded for the same record in this invocation when they are exactly the facts the named loader would build.';

-- project_named_action_record_internal
CREATE OR REPLACE FUNCTION vortex_record.project_named_action_record_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, null
  );
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') item(value)
  loop
    if loaded -> 'columns' ? field_id and loaded -> 'fieldValues' ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, loaded -> 'fieldValues' -> field_id
      );
    end if;
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed', 'recordId', p_record_id,
    'concurrencyNumber', loaded -> 'concurrencyNumber',
    'values', values_value,
    'correlationId', loaded -> 'context' -> 'correlationId',
    'backgroundDelivery', 'pending', 'replayed', true
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$$;
alter function vortex_record.project_named_action_record_internal(text,uuid,bigint,uuid,uuid,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.project_named_action_record_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid) FROM PUBLIC;

-- prepare_named_action_relationship_copies_internal
create or replace function vortex_record.prepare_named_action_relationship_copies_internal(
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_subject_record_type_id uuid,
  p_subject_record_id uuid,
  p_inputs jsonb,
  p_action_context jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  action_context jsonb;
  subject_meta jsonb;
  loaded jsonb;
  decision jsonb;
  readable_field_ids jsonb;
  catalogue jsonb;
  change_value jsonb;
  task_ordinal bigint;
  input_candidate jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_concurrency bigint;
  relationship_text text;
  relationship_value jsonb;
  edge_row record;
  existing_row record;
  edge_type_id uuid;
  planned_keys text[] := array[]::text[];
  copies jsonb := '[]'::jsonb;
  lock_row record;
begin
  if p_subject_record_type_id is null or p_subject_record_id is null
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Relationship copy is invalid';
  end if;
  -- The caller resolved this exact installed action once for its whole step.
  action_context := p_action_context;
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(
      action_context -> 'action' -> 'tasks'
    ) item(value)
    where item.value ->> 'type' = 'record.changes'
  ) then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  subject_meta := vortex_record.resolve_record_action_context_internal(
    p_subject_record_type_id, 'update'
  );

  -- What the actor can currently read of the subject under this named action.
  -- The subject is authorised by the installed action, never by ordinary
  -- update authority, exactly as its own writer decides it.
  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_subject_record_type_id, p_subject_record_id, null
  );
  if loaded ->> 'outcome' is distinct from 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_subject_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' is distinct from 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  readable_field_ids := vortex_record.decide_record_field_bounds_internal(decision)
    -> 'readableFieldIds';
  if pg_catalog.jsonb_typeof(readable_field_ids) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'Relationship copy field bounds are unavailable';
  end if;

  -- Discover every target and copy first, then lock: a target row lock is the
  -- first lock class, so it is taken as soon as the target is known.
  for change_value, task_ordinal in
    select change.value, task.ordinality
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks')
      with ordinality as task(value, ordinality)
    cross join lateral pg_catalog.jsonb_array_elements(
      task.value -> 'properties' -> 'changes'
    ) with ordinality as change(value, ordinality)
    where task.value ->> 'type' = 'record.changes'
    order by task.ordinality, change.ordinality
  loop
    -- The target is the declared `record_reference` input's record link, the
    -- one value shape that input accepts.
    input_candidate := p_inputs -> (change_value ->> 'targetInputKey');
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'inputs') item(value)
      where item.value ->> 'key' = change_value ->> 'targetInputKey'
        and item.value ->> 'type' = 'record_reference'
    ) or pg_catalog.jsonb_typeof(input_candidate) is distinct from 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;
    if not (input_candidate ?& array['recordTypeId', 'recordId'])
      or input_candidate - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
      or not coalesce(pg_catalog.pg_input_is_valid(input_candidate ->> 'recordTypeId', 'uuid'), false)
      or not coalesce(pg_catalog.pg_input_is_valid(input_candidate ->> 'recordId', 'uuid'), false) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;
    target_type_id := (input_candidate ->> 'recordTypeId')::uuid;
    target_record_id := (input_candidate ->> 'recordId')::uuid;
    -- The copied relationships are the subject's own, so only another record of
    -- the subject's record type can hold them.
    if target_type_id <> p_subject_record_type_id
      or target_record_id = p_subject_record_id then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_copy_target_unavailable'
      );
    end if;

    -- L1: the target row, exclusively, before any linked row or edge identity.
    target_concurrency := null;
    execute pg_catalog.format(
      'select stored.concurrency_number from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active'' for update',
      subject_meta ->> 'table'
    ) into target_concurrency using organization_id_value, target_record_id;
    if target_concurrency is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_copy_target_unavailable'
      );
    end if;

    for relationship_text in
      select distinct pg_catalog.lower(item.value #>> '{}')
      from pg_catalog.jsonb_array_elements(change_value -> 'relationshipIds') item(value)
      order by 1
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(
        action_context -> 'recordType' -> 'relationships'
      ) item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') = relationship_text
        and pg_catalog.lower(item.value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_subject_record_type_id::text);
      if relationship_value is null
        or relationship_value ->> 'cardinality' is distinct from 'many_to_one'
        or not exists (
          select 1 from pg_catalog.jsonb_array_elements_text(readable_field_ids) readable(value)
          where pg_catalog.lower(readable.value) =
            pg_catalog.lower(relationship_value ->> 'fromFieldId')
        )
        -- The plan copies the subject's edge as it stands before this command
        -- writes the subject, which is only the authored order's edge when no
        -- earlier record.set_fields task sets that same link.
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks')
            with ordinality as earlier(value, ordinality)
          cross join lateral pg_catalog.jsonb_object_keys(
            earlier.value -> 'properties' -> 'values'
          ) key(field_key)
          where earlier.ordinality < task_ordinal
            and earlier.value ->> 'type' = 'record.set_fields'
            and pg_catalog.lower(key.field_key) =
              pg_catalog.lower(relationship_value ->> 'fromFieldId')
        ) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_copy_unavailable'
        );
      end if;

      catalogue := coalesce(catalogue, vortex_record.relationship_total_catalogue_internal());
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') type_item(value)
        cross join pg_catalog.jsonb_array_elements(type_item.value -> 'fields') field_item(value)
        where field_item.value ->> 'type' = 'total'
          and pg_catalog.lower(field_item.value #>> '{settings,relationshipId}') = relationship_text
      ) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
        );
      end if;

      -- Two changes may name the same target and relationship; it is copied once.
      if (target_record_id::text || ':' || relationship_text) = any (planned_keys) then
        continue;
      end if;
      planned_keys := pg_catalog.array_append(
        planned_keys, target_record_id::text || ':' || relationship_text
      );

      select edge.to_storage_contract_id, edge.to_record_id into edge_row
      from vortex_record.relationship_edges as edge
      where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
        and edge.from_organisation_id = organization_id_value
        and edge.from_storage_contract_id = (subject_meta ->> 'storageContractId')::uuid
        and edge.from_record_id = p_subject_record_id;
      -- A relationship the subject has not set has nothing to copy.
      if not found then continue; end if;
      select catalogue_row.record_type_id into edge_type_id
      from vortex_record.storage_catalogue as catalogue_row
      where catalogue_row.storage_contract_id = edge_row.to_storage_contract_id;
      if edge_type_id is null
        or not vortex_record.relationship_declares_target_internal(
          relationship_value, edge_type_id
        ) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_copy_unavailable'
        );
      end if;

      select edge.to_storage_contract_id, edge.to_record_id into existing_row
      from vortex_record.relationship_edges as edge
      where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
        and edge.from_organisation_id = organization_id_value
        and edge.from_storage_contract_id = (subject_meta ->> 'storageContractId')::uuid
        and edge.from_record_id = target_record_id;
      if found then
        -- Never delete or re-point an existing edge: the same edge is already
        -- the desired state, any other refuses the whole command.
        if existing_row.to_storage_contract_id = edge_row.to_storage_contract_id
          and existing_row.to_record_id = edge_row.to_record_id then
          continue;
        end if;
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_copy_would_replace'
        );
      end if;

      copies := copies || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'targetRecordTypeId', target_type_id,
        'targetRecordId', target_record_id,
        'relationshipId', (relationship_value ->> 'relationshipId')::uuid,
        'fromFieldId', (relationship_value ->> 'fromFieldId')::uuid,
        'value', pg_catalog.jsonb_build_object(
          'recordTypeId', edge_type_id, 'recordId', edge_row.to_record_id
        )
      ));
    end loop;
  end loop;

  -- Every linked row's share lock, in one canonical order, still ahead of
  -- every counter, data version and edge identity (#858).
  for lock_row in
    select distinct
      (copy.value #>> '{value,recordTypeId}')::uuid as record_type_id,
      (copy.value #>> '{value,recordId}')::uuid as record_id
    from pg_catalog.jsonb_array_elements(copies) copy(value)
    order by 1, 2
  loop
    perform vortex_record.lock_relationship_target_row_internal(
      lock_row.record_type_id, lock_row.record_id, organization_id_value
    );
  end loop;

  return pg_catalog.jsonb_build_object('outcome', 'planned', 'copies', copies);
end
$function$;

alter function vortex_record.prepare_named_action_relationship_copies_internal(text,uuid,bigint,uuid,uuid,uuid,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_named_action_relationship_copies_internal(
  text, uuid, bigint, uuid, uuid, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_named_action_relationship_copies_internal(
  text, uuid, bigint, uuid, uuid, uuid, jsonb, jsonb
) to vortex_record_adapter;
comment on function vortex_record.prepare_named_action_relationship_copies_internal(
  text, uuid, bigint, uuid, uuid, uuid, jsonb, jsonb
) is
  'Private named-action step: re-derives every record.changes task from the installed action its caller resolved and the supplied inputs, locks every target row and then every linked row in canonical order before any counter, data version or edge identity, and plans only the selected, declared, readable many-to-one subject edges the target does not already hold. Returns null when the action has no such task, a refused outcome for a request it cannot honour, and raises only on a broken invariant.';

-- prepare_named_action_command_totals
create or replace function vortex_record.prepare_named_action_command_totals(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_creations jsonb,
  p_activity_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  catalogue jsonb;
  root_type jsonb;
  creation_count integer;
  before_closure jsonb;
  after_closure jsonb;
  link_targets jsonb;
  lock_plan jsonb;
  lock_entry jsonb;
  locked_value jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  source_field_id text;
  proposed_target jsonb;
  creation jsonb;
  rule_module_root_id uuid;
  rule_release_revision bigint;
  access_loaded jsonb;
  access_decision jsonb;
  parent_read jsonb;
  access_bounds jsonb := pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) <> 'object'
    or pg_catalog.jsonb_typeof(coalesce(p_creations, '[]'::jsonb)) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  creation_count := pg_catalog.jsonb_array_length(coalesce(p_creations, '[]'::jsonb));
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  if vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
  end if;
  -- A set-only action still uses the terminal writer's total probe. A command
  -- with creations carries the exact release's rules for every closure record
  -- to the existing Record evaluator before any row is written.
  if creation_count = 0
    and coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  -- Authorize the subject without a row lock before discovering or locking any
  -- concrete dependency, through the installed named declaration. Executing a
  -- permitted action still requires no ordinary read or update authority.
  access_loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, null
  );
  if access_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(access_loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if (access_loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  access_decision := vortex_access.evaluate_organization_record_access_internal(
    access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
  );
  if access_decision ->> 'outcome' <> 'allowed' then
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'refused'
    );
    return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
  end if;
  access_bounds := vortex_record.decide_record_field_bounds_internal(access_decision);

  before_closure := vortex_record.named_action_command_closure_internal(
    catalogue, p_record_type_id, p_record_id, p_submitted_values, p_creations
  );
  link_targets := vortex_record.named_action_command_link_targets_internal(
    catalogue, p_record_type_id, p_submitted_values, p_creations
  );
  if before_closure is null or link_targets is null then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
  end if;

  -- One canonical row pass over the union of closure records (`for update`) and
  -- concrete link targets (`for share`). Taking both here, in one ascending
  -- concrete identity order, is what keeps a later `for share` inside the edge
  -- writer from queueing behind an exclusive waiter while this command already
  -- holds a resource that waiter needs.
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'storageContractId', grouped.storage_contract_id,
      'recordId', grouped.record_id,
      'recordTypeId', grouped.record_type_id,
      'mode', case when grouped.exclusive then 'update' else 'share' end
    ) order by grouped.storage_contract_id, grouped.record_id
  ), '[]'::jsonb)
  into lock_plan
  from (
    select entry.storage_contract_id, entry.record_id, entry.record_type_id,
      pg_catalog.bool_or(entry.exclusive) as exclusive
    from (
      select (item.value ->> 'storageContractId')::uuid as storage_contract_id,
        (item.value ->> 'recordId')::uuid as record_id,
        (item.value ->> 'recordTypeId')::uuid as record_type_id,
        true as exclusive
      from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value)
      where item.value ? 'recordId'
      union all
      select (item.value ->> 'storageContractId')::uuid,
        (item.value ->> 'recordId')::uuid,
        (item.value ->> 'recordTypeId')::uuid,
        false
      from pg_catalog.jsonb_array_elements(link_targets) item(value)
    ) entry
    group by entry.storage_contract_id, entry.record_id, entry.record_type_id
  ) grouped;

  for lock_entry in
    select item.value
    from pg_catalog.jsonb_array_elements(lock_plan) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    if lock_entry ->> 'mode' = 'update' then
      locked_value := vortex_record.relationship_total_record_snapshot_internal(
        catalogue, (lock_entry ->> 'recordTypeId')::uuid,
        (lock_entry ->> 'recordId')::uuid, true
      );
      if locked_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'restart');
      end if;
    elsif not vortex_record.share_lock_named_action_target_internal(
      catalogue, (lock_entry ->> 'recordTypeId')::uuid, (lock_entry ->> 'recordId')::uuid
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
  end loop;

  -- A creation's link target is an ordinary record and keeps the ordinary read
  -- requirement. Deciding it here, under the lock and before any write, turns
  -- an unreadable target into a clean refusal instead of a late rollback. The
  -- command's own subject is excluded: the named authority decided above is
  -- sufficient for it, and requiring ordinary read would contradict #50.
  for lock_entry in
    select item.value
    from pg_catalog.jsonb_array_elements(link_targets) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    if (lock_entry ->> 'recordTypeId')::uuid = p_record_type_id
      and (lock_entry ->> 'recordId')::uuid = p_record_id then
      continue;
    end if;
    target_loaded := vortex_record.load_record_access_facts_internal(
      (lock_entry ->> 'recordTypeId')::uuid, 'read',
      (lock_entry ->> 'recordId')::uuid, null, null::jsonb
    );
    if target_loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
    target_decision := vortex_access.evaluate_organization_record_access_internal(
      target_loaded -> 'declaration', (lock_entry ->> 'recordId')::uuid,
      target_loaded -> 'facts'
    );
    if target_decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
  end loop;

  after_closure := vortex_record.named_action_command_closure_internal(
    catalogue, p_record_type_id, p_record_id, p_submitted_values, p_creations
  );
  if after_closure is null then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  if (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value))
       is distinct from
       (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  if vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if (
    select (item.value ->> 'concurrencyNumber')::bigint
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where item.value ->> 'recordKey' = 'root'
  ) <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  access_loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if access_loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  access_decision := vortex_access.evaluate_organization_record_access_internal(
    access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
  );
  if access_decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  access_bounds := vortex_record.decide_record_field_bounds_internal(access_decision);

  -- `not_required` is decided over the union of the subject type and every
  -- creation target type, and only after the locks above, so a command that
  -- needs no total still acquires its resources in the canonical order.
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    join pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
      on true
    where field.value ->> 'type' = 'total'
  ) and not exists (
    select 1
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where pg_catalog.jsonb_array_length(
      coalesce(item.value -> 'recordType' -> 'relationships', '[]'::jsonb)
    ) > 0
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'not_required');
  end if;

  for prepared_record in
    select item.value
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    order by case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
      item.value ->> 'recordKey'
  loop
    begin
      select storage.module_root_id into strict rule_module_root_id
      from vortex_record.storage_catalogue storage
      where storage.storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
        and storage.record_type_id = (prepared_record ->> 'recordTypeId')::uuid
        and storage.state = 'active';
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_STORAGE_LOOKUP_FAILED',
          detail = pg_catalog.format('storage=%s type=%s cause=%s',
            prepared_record ->> 'storageContractId',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    begin
      select (item.value ->> 'moduleReleaseRevision')::bigint
        into strict rule_release_revision
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where (item.value ->> 'recordTypeId')::uuid =
        (prepared_record ->> 'recordTypeId')::uuid;
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_RELEASE_LOOKUP_FAILED',
          detail = pg_catalog.format('type=%s cause=%s',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    if prepared_record ->> 'recordKey' <> 'root' and prepared_record ? 'recordId' then
      select row_read.projection into parent_read
      from vortex_record.read_record_projection_internal(
        (prepared_record ->> 'recordTypeId')::uuid,
        (prepared_record ->> 'recordId')::uuid
      ) as row_read;
    else
      parent_read := null;
    end if;
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb,
      'canRead', prepared_record ->> 'recordKey' = 'root'
        or not (prepared_record ? 'recordId')
        or coalesce(parent_read ->> 'outcome' = 'allowed', false),
      'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
        rule_module_root_id,
        rule_release_revision,
        (prepared_record ->> 'recordTypeId')::uuid
      )
    );
    for total_field in
      select field.value
      from pg_catalog.jsonb_array_elements(prepared_record -> 'recordType' -> 'fields') field(value)
      where field.value ->> 'type' = 'total'
      order by field.value ->> 'fieldId'
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
        pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      source_records := '[]'::jsonb;
      if prepared_record ? 'recordId' then
        for edge_value in
          select edge.* from vortex_record.relationship_edges edge
          where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
            and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
            and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
            and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
            and edge.from_organisation_id = context_organization_id
            and edge.to_organisation_id = context_organization_id
            and edge.from_application_root_id is not distinct from case
              when source_type ->> 'storageScope' = 'application_contained'
                then context_application_id else null end
            and edge.to_application_root_id is not distinct from case
              when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
                then context_application_id else null end
          order by edge.from_storage_contract_id, edge.from_record_id
        loop
          source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, false
          );
          if source_snapshot is null
          and vortex_record.relationship_total_source_is_retained_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, context_organization_id, context_application_id
          ) then
          continue;
        end if;
        if source_snapshot is null then
            return pg_catalog.jsonb_build_object('outcome', 'restart');
          end if;
          select item.value ->> 'recordKey' into source_key
          from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
          where item.value ->> 'recordTypeId' = source_snapshot ->> 'recordTypeId'
            and item.value ->> 'recordId' = source_snapshot ->> 'recordId';
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'fieldValues', source_snapshot -> 'existingValues'
            ) || case when source_key is null then '{}'::jsonb
              else pg_catalog.jsonb_build_object('recordKey', source_key) end
          );
        end loop;
      end if;

      -- Replace the command source's old membership with its proposed one.
      if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text) then
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        select item.value -> 'existingValues' -> source_field_id into proposed_target
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if p_submitted_values ? source_field_id then
          proposed_target := p_submitted_values -> source_field_id;
        end if;
        source_records := coalesce((
          select pg_catalog.jsonb_agg(item.value order by item.ordinality)
          from pg_catalog.jsonb_array_elements(source_records) with ordinality item(value, ordinality)
          where item.value ->> 'recordKey' is distinct from 'root'
        ), '[]'::jsonb);
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and proposed_target ->> 'recordTypeId' = prepared_record ->> 'recordTypeId'
          and proposed_target ->> 'recordId' = prepared_record ->> 'recordId' then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('recordKey', 'root', 'fieldValues', '{}'::jsonb)
          );
        end if;
      end if;

      -- Each creation that links to this parent through this relationship joins
      -- its membership. A created record has no edges yet, so nothing is
      -- removed; the evaluator substitutes its computed values by record key.
      for creation in
        select item.value
        from pg_catalog.jsonb_array_elements(coalesce(p_creations, '[]'::jsonb))
          with ordinality item(value, ordinality)
        order by item.ordinality
      loop
        if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') <>
          pg_catalog.lower((creation ->> 'recordTypeId')::uuid::text) then
          continue;
        end if;
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        proposed_target := creation -> 'values' -> source_field_id;
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and pg_catalog.lower(proposed_target ->> 'recordTypeId') =
            pg_catalog.lower(prepared_record ->> 'recordTypeId')
          and pg_catalog.lower(proposed_target ->> 'recordId') =
            pg_catalog.lower(prepared_record ->> 'recordId') then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'recordKey', 'create:' || (creation ->> 'ordinal'),
              'fieldValues', '{}'::jsonb
            )
          );
        end if;
      end loop;

      prepared_record := pg_catalog.jsonb_set(
        prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision',
            'records', source_records
          )
        )
      );
    end loop;
    prepared_records := prepared_records || pg_catalog.jsonb_build_array(prepared_record);
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', access_bounds -> 'readableFieldIds',
    'records', prepared_records
  );
exception
  when check_violation or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_named_action_command_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,text,uuid,bigint,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) is
  'Private named-action command preflight: one merged total closure over the subject and every creation, locked once in canonical concrete identity order. Writes nothing.';

-- prepare_relationship_total_save
create or replace function vortex_record.prepare_relationship_total_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  catalogue jsonb;
  root_type jsonb;
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  locked_value jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  source_field_id text;
  proposed_target jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  access_loaded jsonb;
  access_decision jsonb;
  parent_read jsonb;
  access_bounds jsonb := pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
  rule_module_root_id uuid;
  rule_release_revision bigint;
begin
  if p_operation not in ('create', 'update')
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'update' and p_selected_group_id is not null)
    or pg_catalog.jsonb_typeof(p_submitted_values) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  -- Receipt resolution remains owned by prepare_base_record_save. Merely seeing
  -- an existing identity here avoids dependency reads or locks on replays and
  -- changed-input duplicates.
  if vortex_record.command_receipt_exists_internal('record_save', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null then return pg_catalog.jsonb_build_object('outcome', 'defer'); end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements_text(
      coalesce(catalogue -> 'applicationRuleSubjectRecordTypeIds', '[]'::jsonb)
    ) subject(record_type_id)
    where pg_catalog.lower(subject.record_type_id) = pg_catalog.lower(p_record_type_id::text)
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(root_type -> 'fields') field(value)
    where field.value ->> 'type' = 'total'
  ) and pg_catalog.jsonb_array_length(root_type -> 'relationships') = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'not_required');
  end if;

  -- Authorize the old source without a row lock before discovering or locking
  -- any concrete dependency. A denied update is deferred to the base prepare,
  -- which owns the existing content-free refusal Activity.
  if p_operation = 'update' then
    access_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, null, null::jsonb
    );
    if access_loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(access_loaded -> 'declaration') <> 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'defer');
    end if;
    if (access_loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    access_decision := vortex_access.evaluate_organization_record_access_internal(
      access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
    );
    if access_decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', context_organization_id,
        array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
    end if;
    access_bounds := vortex_record.decide_record_field_bounds_internal(access_decision);
  end if;

  before_closure := vortex_record.discover_relationship_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
  );
  if before_closure is null then return pg_catalog.jsonb_build_object('outcome', 'defer'); end if;
  -- Application-owned rules have no executable Module rule set. Defer to the
  -- base writer, which refuses a total change that cannot evaluate them.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') record(value)
    join pg_catalog.jsonb_array_elements_text(
      coalesce(catalogue -> 'applicationRuleSubjectRecordTypeIds', '[]'::jsonb)
    ) subject(record_type_id)
      on pg_catalog.lower(subject.record_type_id) =
        pg_catalog.lower(record.value ->> 'recordTypeId')
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  -- Dynamic physical rows are locked in one canonical concrete identity order.
  for record_value in
    select item.value
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value)
    where item.value ? 'recordId'
    order by (item.value ->> 'storageContractId')::uuid,
      (item.value ->> 'recordId')::uuid
  loop
    locked_value := vortex_record.relationship_total_record_snapshot_internal(
      catalogue,
      (record_value ->> 'recordTypeId')::uuid,
      (record_value ->> 'recordId')::uuid,
      true
    );
    if locked_value is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  end loop;

  after_closure := vortex_record.discover_relationship_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
  );
  if after_closure is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  if (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value))
       is distinct from
       (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  -- A concurrent exact or changed-input duplicate may have completed while
  -- this transaction waited for the source/parent locks. Let the existing
  -- receipt owner distinguish replay from command-identity conflict.
  if vortex_record.command_receipt_exists_internal('record_save', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if p_operation = 'update' and (
    select (item.value ->> 'concurrencyNumber')::bigint
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where item.value ->> 'recordKey' = 'root'
  ) <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;

  if p_operation = 'update' then
    access_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
    );
    if access_loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
    access_decision := vortex_access.evaluate_organization_record_access_internal(
      access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
    );
    if access_decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
    access_bounds := vortex_record.decide_record_field_bounds_internal(access_decision);
  end if;

  -- Materialize only the declared aggregate sources for each locked affected
  -- record. The initial source's proposed move replaces its old membership in
  -- this transaction-visible snapshot.
  for prepared_record in
    select item.value
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    order by case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
      item.value ->> 'recordKey'
  loop
    begin
      select storage.module_root_id into strict rule_module_root_id
      from vortex_record.storage_catalogue storage
      where storage.storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
        and storage.record_type_id = (prepared_record ->> 'recordTypeId')::uuid
        and storage.state = 'active';
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_STORAGE_LOOKUP_FAILED',
          detail = pg_catalog.format('storage=%s type=%s cause=%s',
            prepared_record ->> 'storageContractId',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    begin
      select (item.value ->> 'moduleReleaseRevision')::bigint
        into strict rule_release_revision
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where (item.value ->> 'recordTypeId')::uuid =
        (prepared_record ->> 'recordTypeId')::uuid;
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_RELEASE_LOOKUP_FAILED',
          detail = pg_catalog.format('type=%s cause=%s',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    if prepared_record ->> 'recordKey' <> 'root' then
      -- Use the established exact-record read path while the parent is locked.
      select row_read.projection into parent_read
      from vortex_record.read_record_projection_internal(
        (prepared_record ->> 'recordTypeId')::uuid,
        (prepared_record ->> 'recordId')::uuid
      ) as row_read;
    else
      parent_read := null;
    end if;
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb,
      'canRead', prepared_record ->> 'recordKey' = 'root'
        or coalesce(parent_read ->> 'outcome' = 'allowed', false),
      'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
        rule_module_root_id, rule_release_revision,
        (prepared_record ->> 'recordTypeId')::uuid
      )
    );
    for total_field in
      select field.value
      from pg_catalog.jsonb_array_elements(prepared_record -> 'recordType' -> 'fields') field(value)
      where field.value ->> 'type' = 'total'
      order by field.value ->> 'fieldId'
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
        pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then return pg_catalog.jsonb_build_object('outcome', 'refused'); end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then return pg_catalog.jsonb_build_object('outcome', 'refused'); end if;
      source_records := '[]'::jsonb;
      for edge_value in
        select edge.* from vortex_record.relationship_edges edge
        where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
          and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
          and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
          and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
          and edge.from_organisation_id = context_organization_id
          and edge.to_organisation_id = context_organization_id
          and edge.from_application_root_id is not distinct from case
            when source_type ->> 'storageScope' = 'application_contained'
              then context_application_id else null end
          and edge.to_application_root_id is not distinct from case
            when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
              then context_application_id else null end
        order by edge.from_storage_contract_id, edge.from_record_id
      loop
        source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
          catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
          edge_value.from_record_id, false
        );
        if source_snapshot is null
          and vortex_record.relationship_total_source_is_retained_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, context_organization_id, context_application_id
          ) then
          continue;
        end if;
        if source_snapshot is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
        select item.value ->> 'recordKey' into source_key
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordTypeId' = source_snapshot ->> 'recordTypeId'
          and item.value ->> 'recordId' = source_snapshot ->> 'recordId';
        source_records := source_records || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'fieldValues', source_snapshot -> 'existingValues'
          ) || case when source_key is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('recordKey', source_key) end
        );
      end loop;

      -- Replace the command source's old membership with its proposed one.
      if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text) then
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        select item.value -> 'existingValues' -> source_field_id into proposed_target
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if p_submitted_values ? source_field_id then proposed_target := p_submitted_values -> source_field_id; end if;
        source_records := coalesce((
          select pg_catalog.jsonb_agg(item.value order by item.ordinality)
          from pg_catalog.jsonb_array_elements(source_records) with ordinality item(value, ordinality)
          where item.value ->> 'recordKey' is distinct from 'root'
        ), '[]'::jsonb);
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and proposed_target ->> 'recordTypeId' = prepared_record ->> 'recordTypeId'
          and proposed_target ->> 'recordId' = prepared_record ->> 'recordId' then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('recordKey', 'root', 'fieldValues', '{}'::jsonb)
          );
        end if;
      end if;
      prepared_record := pg_catalog.jsonb_set(
        prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision',
            'records', source_records
          )
        )
      );
    end loop;
    prepared_records := prepared_records || pg_catalog.jsonb_build_array(prepared_record);
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', access_bounds -> 'readableFieldIds',
    'records', prepared_records
  );
exception
  when check_violation or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Private Stage 2B preflight: discovers old/proposed concrete total closure, locks it canonically, re-reads it, and returns only declared evaluator inputs.';

-- change_record
create or replace function vortex_record.change_record(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_submitted_field_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  meta jsonb;
  context_value jsonb;
  columns_value jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_values jsonb;
  proposed_facts jsonb;
  proposed_records jsonb;
  entry_key text;
  entry_value jsonb;
  column_entry jsonb;
  field_type text;
  storage_type text;
  submitted_id uuid;
  assignments text[] := array[]::text[];
  update_sql text;
  changed_rows integer;
  new_concurrency_number bigint;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_final_values is null
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or (not (loaded ? 'previewInstallationId')
      and pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  context_value := loaded -> 'context';
  columns_value := loaded -> 'columns';

  if loaded ? 'previewInstallationId' then
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'update'
    );
    bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (meta ->> 'storageContractId')::uuid,
      meta -> 'recordType'
    );
    if bounds is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
  else
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
  end if;
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);

  foreach submitted_id in array p_submitted_field_ids loop
    if not (columns_value ? pg_catalog.lower(submitted_id::text)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  proposed_values := loaded -> 'fieldValues';
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    column_entry := columns_value -> entry_key;
    if column_entry is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    field_type := column_entry ->> 'type';
    storage_type := column_entry ->> 'databaseValueType';
    if field_type in ('link', 'link_to_one_of_several') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'link_change_unsupported'
      );
    end if;
    if not vortex_record.canonical_record_value_matches(
      entry_value, field_type, storage_type
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'value_invalid'
      );
    end if;

    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
    assignments := pg_catalog.array_append(
      assignments,
      pg_catalog.format(
        '%I = %s',
        column_entry ->> 'token',
        case
          when pg_catalog.jsonb_typeof(entry_value) = 'null' then 'null'
          else case storage_type
            when 'decimal' then pg_catalog.format('%L::numeric', entry_value #>> '{}')
            when 'timestamp_with_time_zone' then
              pg_catalog.format('%L::timestamptz', entry_value #>> '{}')
            when 'date' then pg_catalog.format('%L::date', entry_value #>> '{}')
            when 'integer' then pg_catalog.format('%L::bigint', entry_value #>> '{}')
            when 'boolean' then pg_catalog.format('%L::boolean', entry_value #>> '{}')
            when 'json' then pg_catalog.format('%L::jsonb', entry_value::text)
            else pg_catalog.format('%L::text', entry_value #>> '{}')
          end
        end
      )
    );
  end loop;

  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  proposed_facts := (loaded -> 'facts')
    || pg_catalog.jsonb_build_object('records', proposed_records);

  if not (loaded ? 'previewInstallationId') then
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, proposed_facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'proposed_record_refused'
      );
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
  end if;

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %s%sconcurrency_number = stored.concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       definition_revision = $4
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $5
     returning stored.concurrency_number',
    loaded ->> 'table',
    pg_catalog.array_to_string(assignments, ','),
    case when pg_catalog.cardinality(assignments) = 0 then '' else ', ' end
  );

  execute update_sql
  into new_concurrency_number
  using (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (loaded ->> 'moduleReleaseRevision')::bigint,
    p_expected_concurrency_number;

  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001',
      message = 'Record change did not apply to exactly one row';
  end if;

  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, proposed_values -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', p_record_id,
    'concurrencyNumber', new_concurrency_number,
    'values', values_value
  );
end
$function$;
alter function vortex_record.change_record(uuid,uuid,bigint,jsonb,uuid[]) owner to vortex_record_adapter;


alter function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[])
  owner to vortex_record_adapter;

revoke all on function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[]) is
  'Fixed owner-only record update primitive. It checks one live record decision or the exact owner preview address, validates values and field bounds before writing, enforces concurrency, and returns only its permitted field projection.';

-- change_record_by_named_action_internal
create or replace function vortex_record.change_record_by_named_action_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  context_value jsonb;
  columns_value jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_values jsonb;
  proposed_facts jsonb;
  proposed_records jsonb;
  entry_key text;
  entry_value jsonb;
  column_entry jsonb;
  field_type text;
  storage_type text;
  submitted_id uuid;
  assignments text[] := array[]::text[];
  update_sql text;
  changed_rows integer;
  saved_record_id uuid;
  new_concurrency_number bigint;
  notice_sequence bigint;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  -- The next number must still fit the column's own range, so the highest
  -- accepted expected number is one below its maximum.
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_final_values is null
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  context_value := loaded -> 'context';
  columns_value := loaded -> 'columns';

  -- The old row's own update decision, and the changeable set it carries.
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);

  -- Every submitted field must be a field of the exact installed definition and
  -- inside that changeable set. The first one outside it refuses the whole
  -- change, before any value is cast and before any statement writes.
  foreach submitted_id in array p_submitted_field_ids loop
    if not (columns_value ? pg_catalog.lower(submitted_id::text)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  -- Every final value must name a field of that same definition: an unknown
  -- identifier and a system column are the same refusal, because neither is a
  -- field of this record type.
  proposed_values := loaded -> 'fieldValues';
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    column_entry := columns_value -> entry_key;
    if column_entry is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    field_type := column_entry ->> 'type';
    storage_type := column_entry ->> 'databaseValueType';

    -- Link fields carry relationship edges, and edge writes are S2's. Refusing
    -- with a fixed code keeps a link change from being silently dropped.
    if field_type in ('link', 'link_to_one_of_several') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'link_change_unsupported'
      );
    end if;

    if not vortex_record.canonical_record_value_matches(
      entry_value, field_type, storage_type
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'value_invalid'
      );
    end if;

    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
    assignments := pg_catalog.array_append(
      assignments,
      pg_catalog.format(
        '%I = %s',
        column_entry ->> 'token',
        case
          when pg_catalog.jsonb_typeof(entry_value) = 'null' then 'null'
          else case storage_type
            when 'decimal' then pg_catalog.format('%L::numeric', entry_value #>> '{}')
            when 'timestamp_with_time_zone' then
              pg_catalog.format('%L::timestamptz', entry_value #>> '{}')
            when 'date' then pg_catalog.format('%L::date', entry_value #>> '{}')
            when 'integer' then pg_catalog.format('%L::bigint', entry_value #>> '{}')
            when 'boolean' then pg_catalog.format('%L::boolean', entry_value #>> '{}')
            when 'json' then pg_catalog.format('%L::jsonb', entry_value::text)
            else pg_catalog.format('%L::text', entry_value #>> '{}')
          end
        end
      )
    );
  end loop;

  -- The proposed row's own update decision. Values that move the record out of
  -- every route the caller holds are refused here, after the old row admitted
  -- them and before anything is written.
  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  proposed_facts := (loaded -> 'facts')
    || pg_catalog.jsonb_build_object('records', proposed_records);

  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, proposed_facts
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'proposed_record_refused'
    );
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);

  -- The write: the typed columns, the next concurrency number, and the change
  -- stamp from the verified context and the installed binding. Owner columns
  -- and lifecycle state are not writable here.
  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %s%sconcurrency_number = stored.concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       definition_revision = $4
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $5
     returning stored.record_id, stored.concurrency_number',
    loaded ->> 'table',
    pg_catalog.array_to_string(assignments, ', '),
    case when pg_catalog.cardinality(assignments) = 0 then '' else ', ' end
  );

  execute update_sql
  into saved_record_id, new_concurrency_number
  using (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (loaded ->> 'moduleReleaseRevision')::bigint,
    p_expected_concurrency_number;

  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001',
      message = 'Record change did not apply to exactly one row';
  end if;

  if loaded #>> '{actionContext,storageScope}' = 'application_contained' then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_platform.publish_change_notice(
        (context_value ->> 'organizationId')::uuid,
        (context_value ->> 'applicationRootId')::uuid,
        p_record_type_id, saved_record_id, new_concurrency_number, 'changed',
        notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
      );
    exception
      when others then
        -- Invalidation is advisory; a lost notice must not refuse the scalar write.
        null;
    end;
  end if;

  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, proposed_values -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', saved_record_id,
    'concurrencyNumber', new_concurrency_number,
    'values', values_value
  );
end
$function$;

alter function vortex_record.change_record_by_named_action_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) owner to vortex_record_adapter;
revoke all on function vortex_record.change_record_by_named_action_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.change_record_by_named_action_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) to vortex_record_adapter;
comment on function vortex_record.change_record_by_named_action_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) is null;

-- authorize_created_records_for_command_internal
create or replace function vortex_record.authorize_created_records_for_command_internal(
  p_creations jsonb,
  p_created_records jsonb,
  p_original_context jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  safe_integer_max constant bigint := 9007199254740991;
  current_context jsonb;
  meta jsonb;
  meta_context jsonb;
  loaded jsonb;
  loaded_context jsonb;
  facts jsonb;
  record_fact jsonb;
  record_scope jsonb;
  decision jsonb;
  bounds jsonb;
  creation jsonb;
  created_value jsonb;
  saved_tuple jsonb;
  submitted_field text;
  returned_field text;
  submitted_id uuid;
  changeable_id text;
  ordinal_key text;
  ordinal_value integer;
  record_type_id_value uuid;
  record_id_value uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  account_id_value uuid;
  correlation_id_value uuid;
  module_root_id_value uuid;
  storage_contract_id_value uuid;
  module_release_revision_value bigint;
  definition_revision_value bigint;
  storage_scope_value text;
  actual_concurrency_number bigint;
  expected_record_scope jsonb;
  ordinals integer[] := array[]::integer[];
  seen_map_ordinals integer[] := array[]::integer[];
  seen_record_ids uuid[] := array[]::uuid[];
  result_tuples jsonb := '[]'::jsonb;
  matching_target_count integer;
  eligible_value boolean;
begin
  if pg_catalog.jsonb_typeof(p_creations) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_created_records) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_original_context) is distinct from 'object'
    or not (p_original_context ?& array[
      'organizationId', 'applicationRootId', 'organizationAccountId', 'correlationId'
    ])
    or p_original_context - array[
      'organizationId', 'applicationRootId', 'organizationAccountId', 'correlationId'
    ]::text[] <> '{}'::jsonb then
    raise exception using errcode = '22023',
      message = 'Named action creation authority input is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_creations) = 0
    or (select pg_catalog.count(*)
        from pg_catalog.jsonb_object_keys(p_created_records)) <>
      pg_catalog.jsonb_array_length(p_creations) then
    raise exception using errcode = '22023',
      message = 'Named action creation authority input is invalid';
  end if;
  if pg_catalog.jsonb_typeof(p_original_context -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_original_context -> 'applicationRootId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_original_context -> 'organizationAccountId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_original_context -> 'correlationId') is distinct from 'string'
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'organizationId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'applicationRootId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'organizationAccountId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'correlationId', 'uuid'), true) then
    raise exception using errcode = '42501',
      message = 'Named action creation context is unavailable';
  end if;
  organization_id_value := (p_original_context ->> 'organizationId')::uuid;
  application_root_id_value := (p_original_context ->> 'applicationRootId')::uuid;
  account_id_value := (p_original_context ->> 'organizationAccountId')::uuid;
  correlation_id_value := (p_original_context ->> 'correlationId')::uuid;
  if organization_id_value = nil_uuid or application_root_id_value = nil_uuid
    or account_id_value = nil_uuid or correlation_id_value = nil_uuid then
    raise exception using errcode = '42501',
      message = 'Named action creation context is unavailable';
  end if;

  current_context := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(current_context) is distinct from 'object'
    or pg_catalog.jsonb_typeof(current_context -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(current_context -> 'applicationRootId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(current_context -> 'organizationAccountId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(current_context -> 'correlationId') is distinct from 'string'
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'organizationId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'applicationRootId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'organizationAccountId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'correlationId', 'uuid'), true)
    or (current_context ->> 'organizationId')::uuid is distinct from organization_id_value
    or (current_context ->> 'applicationRootId')::uuid is distinct from application_root_id_value
    or (current_context ->> 'organizationAccountId')::uuid is distinct from account_id_value
    or (current_context ->> 'correlationId')::uuid is distinct from correlation_id_value then
    raise exception using errcode = '42501',
      message = 'Named action creation context changed';
  end if;

  -- Validate and retain each canonical ordinal before using it as an object key.
  for creation in
    select item.value from pg_catalog.jsonb_array_elements(p_creations) item(value)
  loop
    if pg_catalog.jsonb_typeof(creation) is distinct from 'object'
      or not (creation ?& array['ordinal', 'recordTypeId', 'values', 'finalValues'])
      or creation - array['ordinal', 'recordTypeId', 'values', 'finalValues']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(creation -> 'ordinal') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(creation ->> 'ordinal', 'integer'), true)
      or pg_catalog.jsonb_typeof(creation -> 'recordTypeId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(creation ->> 'recordTypeId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(creation -> 'values') is distinct from 'object'
      or pg_catalog.jsonb_typeof(creation -> 'finalValues') is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Named action creation authority input is invalid';
    end if;
    ordinal_value := (creation ->> 'ordinal')::integer;
    record_type_id_value := (creation ->> 'recordTypeId')::uuid;
    if ordinal_value < 0 or record_type_id_value = nil_uuid
      or ordinal_value = any (ordinals) then
      raise exception using errcode = '22023',
        message = 'Named action creation ordinal is invalid';
    end if;
    ordinals := pg_catalog.array_append(ordinals, ordinal_value);
  end loop;

  -- A JSON object can contain text keys such as "01" and "1" that cast to the
  -- same integer. Admit only the exact decimal form of each declared ordinal.
  for ordinal_key in
    select item.key from pg_catalog.jsonb_object_keys(p_created_records) item(key)
  loop
    if coalesce(not pg_catalog.pg_input_is_valid(ordinal_key, 'integer'), true) then
      raise exception using errcode = '22023',
        message = 'Named action creation result key is invalid';
    end if;
    ordinal_value := ordinal_key::integer;
    if ordinal_value < 0 or ordinal_key is distinct from ordinal_value::text
      or not (ordinal_value = any (ordinals))
      or ordinal_value = any (seen_map_ordinals) then
      raise exception using errcode = '22023',
        message = 'Named action creation result key is invalid';
    end if;
    seen_map_ordinals := pg_catalog.array_append(seen_map_ordinals, ordinal_value);
  end loop;
  if pg_catalog.cardinality(seen_map_ordinals) <> pg_catalog.cardinality(ordinals) then
    raise exception using errcode = '22023',
      message = 'Named action creation result set is incomplete';
  end if;

  for creation in
    select item.value
    from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
    order by (item.value ->> 'ordinal')::integer
  loop
    ordinal_value := (creation ->> 'ordinal')::integer;
    record_type_id_value := (creation ->> 'recordTypeId')::uuid;
    created_value := p_created_records -> ordinal_value::text;
    if pg_catalog.jsonb_typeof(created_value) is distinct from 'object'
      or not (created_value ?& array['recordId', 'storageContractId', 'values', '_savedTuple'])
      or created_value - array['recordId', 'storageContractId', 'values', '_savedTuple']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(created_value -> 'recordId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(created_value ->> 'recordId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(created_value -> 'storageContractId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(created_value ->> 'storageContractId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(created_value -> 'values') is distinct from 'object'
      or pg_catalog.jsonb_typeof(created_value -> '_savedTuple') is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Named action creation result is invalid';
    end if;
    record_id_value := (created_value ->> 'recordId')::uuid;
    storage_contract_id_value := (created_value ->> 'storageContractId')::uuid;
    saved_tuple := created_value -> '_savedTuple';
    if record_id_value = nil_uuid or storage_contract_id_value = nil_uuid
      or pg_catalog.jsonb_typeof(saved_tuple) is distinct from 'object'
      or not (saved_tuple ?& array[
        'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
        'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
        'storageScope', 'actorId', 'correlationId', 'eligible'
      ])
      or saved_tuple - array[
        'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
        'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
        'storageScope', 'actorId', 'correlationId', 'eligible'
      ]::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(saved_tuple -> 'recordId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'recordId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'concurrencyNumber') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'concurrencyNumber', 'bigint'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'organizationId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'organizationId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'applicationRootId') not in ('string', 'null')
      or (pg_catalog.jsonb_typeof(saved_tuple -> 'applicationRootId') = 'string'
        and coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'applicationRootId', 'uuid'), true))
      or pg_catalog.jsonb_typeof(saved_tuple -> 'moduleRootId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'moduleRootId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'recordTypeId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'recordTypeId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'storageContractId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'storageContractId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'moduleReleaseRevision') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'moduleReleaseRevision', 'bigint'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'storageScope') is distinct from 'string'
      or pg_catalog.jsonb_typeof(saved_tuple -> 'actorId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'actorId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'correlationId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'correlationId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'eligible') is distinct from 'boolean' then
      raise exception using errcode = '22023',
        message = 'Named action creation tuple is invalid';
    end if;

    if (saved_tuple ->> 'recordId')::uuid is distinct from record_id_value
      or (saved_tuple ->> 'recordTypeId')::uuid is distinct from record_type_id_value
      or (saved_tuple ->> 'storageContractId')::uuid is distinct from storage_contract_id_value
      or (saved_tuple ->> 'organizationId')::uuid is distinct from organization_id_value
      or (saved_tuple ->> 'actorId')::uuid is distinct from account_id_value
      or (saved_tuple ->> 'correlationId')::uuid is distinct from correlation_id_value
      or (saved_tuple ->> 'concurrencyNumber')::bigint not between 1 and safe_integer_max
      or (saved_tuple ->> 'moduleReleaseRevision')::bigint not between 1 and safe_integer_max
      or (saved_tuple ->> 'moduleRootId')::uuid = nil_uuid
      or (saved_tuple ->> 'storageScope') not in ('application_contained', 'organization_shared')
      or ((saved_tuple ->> 'storageScope') = 'application_contained'
        and (saved_tuple ->> 'applicationRootId')::uuid is distinct from application_root_id_value)
      or ((saved_tuple ->> 'storageScope') = 'organization_shared'
        and saved_tuple -> 'applicationRootId' is distinct from 'null'::jsonb)
      or (saved_tuple ->> 'eligible')::boolean is distinct from
        ((saved_tuple ->> 'storageScope') = 'application_contained') then
      raise exception using errcode = '42501',
        message = 'Named action creation tuple context changed';
    end if;
    if record_id_value = any (seen_record_ids) then
      raise exception using errcode = '22023',
        message = 'Named action creation identity is duplicated';
    end if;
    seen_record_ids := pg_catalog.array_append(seen_record_ids, record_id_value);

    meta := vortex_record.resolve_record_action_context_internal(record_type_id_value, 'create');
    if pg_catalog.jsonb_typeof(meta) is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'context') is distinct from 'object'
      or meta ? 'previewInstallationId'
      or pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'columns') is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'moduleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'storageContractId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'moduleReleaseRevision') is distinct from 'number'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'organizationId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'applicationRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'organizationAccountId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'correlationId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'recordType' -> 'recordTypeId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'recordType' -> 'storageScope') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'table') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'declaration' -> 'recordBinding') is distinct from 'object'
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'organizationId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'applicationRootId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'organizationAccountId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'correlationId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'recordType' ->> 'recordTypeId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(
        meta -> 'declaration' -> 'recordBinding' ->> 'moduleRootId', 'uuid'
      ), true)
      or coalesce(not pg_catalog.pg_input_is_valid(
        meta -> 'declaration' -> 'recordBinding' ->> 'recordTypeId', 'uuid'
      ), true)
      or coalesce(not pg_catalog.pg_input_is_valid(
        meta -> 'declaration' -> 'recordBinding' ->> 'storageContractId', 'uuid'
      ), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'moduleRootId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'storageContractId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'moduleReleaseRevision', 'bigint'), true)
      or meta ->> 'storageScope' is distinct from saved_tuple ->> 'storageScope'
      or (meta ->> 'moduleRootId')::uuid is distinct from (saved_tuple ->> 'moduleRootId')::uuid
      or (meta ->> 'storageContractId')::uuid is distinct from storage_contract_id_value
      or (meta ->> 'moduleReleaseRevision')::bigint is distinct from
        (saved_tuple ->> 'moduleReleaseRevision')::bigint
      or (meta -> 'context' ->> 'organizationId')::uuid is distinct from organization_id_value
      or (meta -> 'context' ->> 'applicationRootId')::uuid is distinct from application_root_id_value
      or (meta -> 'context' ->> 'organizationAccountId')::uuid is distinct from account_id_value
      or (meta -> 'context' ->> 'correlationId')::uuid is distinct from correlation_id_value
      or (meta -> 'recordType' ->> 'recordTypeId')::uuid is distinct from record_type_id_value
      or (meta -> 'recordType' ->> 'storageScope') is distinct from saved_tuple ->> 'storageScope'
      or (meta -> 'declaration' -> 'recordBinding' ->> 'moduleRootId')::uuid is distinct from
        (saved_tuple ->> 'moduleRootId')::uuid
      or (meta -> 'declaration' -> 'recordBinding' ->> 'recordTypeId')::uuid is distinct from
        record_type_id_value
      or (meta -> 'declaration' -> 'recordBinding' ->> 'storageContractId')::uuid is distinct from
        storage_contract_id_value
      or meta -> 'declaration' -> 'recordBinding' ->> 'storageScope' is distinct from
        saved_tuple ->> 'storageScope' then
      raise exception using errcode = '42501',
        message = 'Named action creation installation is unavailable';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_each(creation -> 'finalValues') expected(key, value)
      where not (created_value -> 'values' ? expected.key)
        or (created_value -> 'values' -> expected.key) is distinct from expected.value
    ) then
      raise exception using errcode = '55000',
        message = 'Named action creation values changed';
    end if;
    for returned_field in
      select key from pg_catalog.jsonb_object_keys(created_value -> 'values') as field(key)
    loop
      if coalesce(not pg_catalog.pg_input_is_valid(returned_field, 'uuid'), true)
        or not (meta -> 'columns' ? pg_catalog.lower(returned_field)) then
        raise exception using errcode = '55000',
          message = 'Named action creation values are unavailable';
      end if;
      if not (creation -> 'finalValues' ? returned_field)
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') field(value)
          where pg_catalog.lower(field.value ->> 'fieldId') =
              pg_catalog.lower(returned_field)
            and field.value ->> 'type' = 'reference_number'
        ) then
        raise exception using errcode = '55000',
          message = 'Named action creation generated value is unavailable';
      end if;
    end loop;

    loaded := vortex_record.load_record_access_facts_internal(
      record_type_id_value, 'create', record_id_value, null, null::jsonb
    );
    if pg_catalog.jsonb_typeof(loaded) is distinct from 'object'
      or loaded ->> 'outcome' is distinct from 'loaded'
      or loaded ? 'previewInstallationId'
      or pg_catalog.jsonb_typeof(loaded -> 'context') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'organizationId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'applicationRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'organizationAccountId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'correlationId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'organizationId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'applicationRootId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'organizationAccountId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'correlationId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'declaration' -> 'recordBinding') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'facts') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'records') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'recordTypes') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'relationships') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'sharingConditions') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'edges') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'binding') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'columns') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'table') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'concurrencyNumber') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded ->> 'concurrencyNumber', 'bigint'), true)
      or pg_catalog.jsonb_typeof(loaded -> 'definitionRevision') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded ->> 'definitionRevision', 'bigint'), true)
      or pg_catalog.jsonb_typeof(loaded -> 'moduleReleaseRevision') is distinct from 'number'
      or pg_catalog.jsonb_typeof(loaded -> 'moduleReleaseRevision') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded ->> 'moduleReleaseRevision', 'bigint'), true)
      or (loaded -> 'context' ->> 'organizationId')::uuid is distinct from organization_id_value
      or (loaded -> 'context' ->> 'applicationRootId')::uuid is distinct from application_root_id_value
      or (loaded -> 'context' ->> 'organizationAccountId')::uuid is distinct from account_id_value
      or (loaded -> 'context' ->> 'correlationId')::uuid is distinct from correlation_id_value
      or loaded -> 'facts' -> 'binding' is distinct from
        meta -> 'declaration' -> 'recordBinding'
      or loaded -> 'declaration' -> 'recordBinding' is distinct from
        meta -> 'declaration' -> 'recordBinding'
      or loaded ->> 'table' is distinct from meta ->> 'table'
      or (loaded ->> 'moduleReleaseRevision')::bigint is distinct from
        (meta ->> 'moduleReleaseRevision')::bigint
      or (loaded ->> 'moduleReleaseRevision')::bigint is distinct from
        (saved_tuple ->> 'moduleReleaseRevision')::bigint then
      raise exception using errcode = '42501',
        message = 'Named action creation facts are unavailable';
    end if;
    if exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) or exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'relationships') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) or exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'sharingConditions') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) or exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'edges') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) then
      raise exception using errcode = '55000',
        message = 'Named action creation graph facts are malformed';
    end if;
    actual_concurrency_number := (loaded ->> 'concurrencyNumber')::bigint;
    definition_revision_value := (loaded ->> 'definitionRevision')::bigint;
    if actual_concurrency_number not between 1 and safe_integer_max then
      raise exception using errcode = '55000',
        message = 'Named action creation revision is unavailable';
    end if;
    if definition_revision_value not between 1 and safe_integer_max
      or definition_revision_value is distinct from
        (saved_tuple ->> 'moduleReleaseRevision')::bigint then
      raise exception using errcode = '42501',
        message = 'Named action creation definition changed';
    end if;

    matching_target_count := 0;
    record_fact := null;
    for record_fact in
      select item.value from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') item(value)
    loop
      if pg_catalog.jsonb_typeof(record_fact) is distinct from 'object'
        or pg_catalog.jsonb_typeof(record_fact -> 'recordScope') is distinct from 'object'
        or pg_catalog.jsonb_typeof(record_fact -> 'fieldValues') is distinct from 'object' then
        raise exception using errcode = '55000',
          message = 'Named action creation target facts are malformed';
      end if;
      if pg_catalog.jsonb_typeof(record_fact -> 'recordScope' -> 'recordId') = 'string'
        and coalesce(pg_catalog.pg_input_is_valid(
          record_fact -> 'recordScope' ->> 'recordId', 'uuid'
        ), false)
        and (record_fact -> 'recordScope' ->> 'recordId')::uuid = record_id_value then
        matching_target_count := matching_target_count + 1;
      end if;
    end loop;
    if matching_target_count <> 1 then
      raise exception using errcode = '42501',
        message = 'Named action creation target is unavailable';
    end if;

    -- Re-read the one exact saved target from the returned fact set and compare
    -- its complete loader-produced scope; related graph facts never substitute.
    select item.value into strict record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') item(value)
    where item.value -> 'recordScope' ->> 'recordId' = record_id_value::text;
    record_scope := record_fact -> 'recordScope';
    expected_record_scope := pg_catalog.jsonb_build_object(
      'storageScope', saved_tuple ->> 'storageScope',
      'organizationId', organization_id_value,
      'moduleRootId', (saved_tuple ->> 'moduleRootId')::uuid,
      'recordTypeId', record_type_id_value,
      'storageContractId', storage_contract_id_value,
      'recordId', record_id_value
    ) || case when saved_tuple ->> 'storageScope' = 'application_contained'
      then pg_catalog.jsonb_build_object('applicationRootId', application_root_id_value)
      else '{}'::jsonb end;
    if record_scope is distinct from expected_record_scope
      or pg_catalog.jsonb_typeof(record_fact -> 'fieldValues') is distinct from 'object'
      or record_fact ->> 'lifecycleState' is distinct from 'active' then
      raise exception using errcode = '42501',
        message = 'Named action creation target scope changed';
    end if;

    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta -> 'declaration' -> 'recordBinding'
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', record_id_value, facts
    );
    if pg_catalog.jsonb_typeof(decision) is distinct from 'object'
      or decision ->> 'outcome' is distinct from 'allowed' then
      raise exception using errcode = '42501',
        message = 'Named action creation authority is unavailable';
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
    if pg_catalog.jsonb_typeof(bounds) is distinct from 'object'
      or pg_catalog.jsonb_typeof(bounds -> 'readableFieldIds') is distinct from 'array'
      or pg_catalog.jsonb_typeof(bounds -> 'changeableFieldIds') is distinct from 'array'
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
          or coalesce(not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid'), true)
      )
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
          or coalesce(not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid'), true)
          or not (bounds -> 'readableFieldIds' ? (item.value #>> '{}'))
      ) then
      raise exception using errcode = '55000',
        message = 'Named action creation field bounds are unavailable';
    end if;
    for submitted_field in
      select key from pg_catalog.jsonb_object_keys(creation -> 'values') as field(key)
    loop
      if coalesce(not pg_catalog.pg_input_is_valid(submitted_field, 'uuid'), true) then
        raise exception using errcode = '22023',
          message = 'Named action creation field is invalid';
      end if;
      submitted_id := submitted_field::uuid;
      changeable_id := pg_catalog.lower(submitted_id::text);
      if not (meta -> 'columns' ? changeable_id)
        or not exists (
          select 1
          from pg_catalog.jsonb_array_elements_text(bounds -> 'changeableFieldIds') item(value)
          where pg_catalog.lower(item.value) = changeable_id
        ) then
        raise exception using errcode = '42501',
          message = 'Named action creation field is not changeable';
      end if;
    end loop;

    eligible_value := (saved_tuple ->> 'eligible')::boolean;
    result_tuples := result_tuples || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ordinal', ordinal_value,
        'recordId', record_id_value,
        'concurrencyNumber', actual_concurrency_number,
        'organizationId', organization_id_value,
        'applicationRootId', saved_tuple -> 'applicationRootId',
        'moduleRootId', (saved_tuple ->> 'moduleRootId')::uuid,
        'recordTypeId', record_type_id_value,
        'storageContractId', storage_contract_id_value,
        'moduleReleaseRevision', (loaded ->> 'moduleReleaseRevision')::bigint,
        'storageScope', saved_tuple ->> 'storageScope',
        'correlationId', correlation_id_value,
        'eligible', eligible_value
      )
    );
  end loop;

  if pg_catalog.jsonb_array_length(result_tuples) <> pg_catalog.cardinality(ordinals)
    or pg_catalog.cardinality(seen_record_ids) <> pg_catalog.cardinality(ordinals) then
    raise exception using errcode = '55000',
      message = 'Named action creation authority result is incomplete';
  end if;
  return result_tuples;
end
$function$;
alter function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb) owner to vortex_record_adapter;


alter function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb)
  to vortex_record_adapter;

comment on function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb) is
  'Private named-action whole-graph ordinary CREATE authorization barrier over the complete inserted set; revalidates the original HUMAN context, installed scope, actual loader target and revision, current Access decision and submitted field bounds, returning ordered final saved tuples for the terminal receipt and created-notice seam.';

-- apply_settings_record_changes_internal
create or replace function vortex_record.apply_settings_record_changes_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  read_decision jsonb;
  read_bounds jsonb;
  record_type_value jsonb;
  field_item jsonb;
  field_id text;
  field_key text;
  field_type text;
  database_type text;
  field_value jsonb;
  candidate_values jsonb;
  core_values jsonb := '{}'::jsonb;
  extension_values jsonb := '{}'::jsonb;
  changed_field_ids uuid[] := array[]::uuid[];
  receipt_claim jsonb;
  access_result jsonb;
  projection jsonb;
  event_result jsonb;
  correlation_id_value uuid;
  application_root_id_value uuid;
  notice_sequence bigint;
  failure_sqlstate text;
  failure_message text;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id is null
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
    if p_command_id is not null then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
  record_type_value := meta -> 'recordType';
  if record_type_value ->> 'key' is distinct from 'organization_settings'
    or record_type_value #>> '{systemProjection,protectedView}' is distinct from
      'organization_runtime_settings'
    or not coalesce((record_type_value -> 'standardActions') ? 'update', false)
    or not vortex_definition.is_system_projection_module_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta -> 'context' ->> 'organizationId')::uuid
    ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;

  correlation_id_value := (meta -> 'context' ->> 'correlationId')::uuid;
  application_root_id_value := (meta -> 'context' ->> 'applicationRootId')::uuid;
  if p_record_id is distinct from (meta -> 'context' ->> 'organizationId')::uuid then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'read', p_record_id, null, null::jsonb
  );
  if loaded ->> 'outcome' <> 'loaded' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;
  read_decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if read_decision ->> 'outcome' is distinct from 'allowed' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;
  read_bounds := vortex_record.decide_record_field_bounds_internal(read_decision);
  if exists (
    select 1
    from (
      select supplied.key
      from pg_catalog.jsonb_object_keys(p_submitted_values) as supplied(key)
      union
      select supplied.key
      from pg_catalog.jsonb_object_keys(p_final_values) as supplied(key)
    ) as supplied
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        read_bounds -> 'readableFieldIds'
      ) as readable(field_id)
      where pg_catalog.lower(readable.field_id) = pg_catalog.lower(supplied.key)
    )
  ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'field_refused',
      'correlationId', correlation_id_value
    );
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_final_values) as supplied(key)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(supplied.key)
    )
  ) or exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_submitted_values) as supplied(key)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(supplied.key)
    )
  ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid',
      'correlationId', correlation_id_value
    );
  end if;

  candidate_values := (loaded -> 'fieldValues') || p_final_values;
  for field_item in
    select item.value
    from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
    order by item.value ->> 'fieldId'
  loop
    field_id := pg_catalog.lower(field_item ->> 'fieldId');
    field_key := field_item ->> 'key';
    field_type := field_item ->> 'type';
    database_type := meta #>> array['columns', field_id, 'databaseValueType'];
    if database_type is null then
      raise exception using errcode = '55000',
        message = 'Organization settings field storage is unavailable';
    end if;

    if (field_item ->> 'required')::boolean
      and (not (candidate_values ? field_id)
        or pg_catalog.jsonb_typeof(candidate_values -> field_id) = 'null') then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'required_field_missing',
        'correlationId', correlation_id_value
      );
    end if;
    if not (p_final_values ? field_id) then
      continue;
    end if;

    field_value := p_final_values -> field_id;
    if field_key in ('organization_id', 'revision')
      or field_type in (
        'reference_number', 'table', 'link', 'link_to_one_of_several', 'total',
        'attachment', 'calculation'
      )
      or not vortex_record.canonical_record_value_matches(
        field_value, field_type, database_type
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;

    if field_type = 'choice'
      and pg_catalog.jsonb_typeof(field_value) <> 'null'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(field_item #> '{settings,options}') as option(value)
        where option.value ->> 'value' = field_value #>> '{}'
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;
    if field_type = 'several_choices'
      and pg_catalog.jsonb_typeof(field_value) <> 'null'
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(field_value) as selected(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(field_item #> '{settings,options}') as option(value)
          where option.value ->> 'value' = selected.value
        )
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;
    if field_type in ('text', 'long_text', 'choice', 'email_address', 'phone_number', 'web_address')
      and field_item #> '{settings,maxLength}' is not null
      and pg_catalog.jsonb_typeof(field_value) = 'string'
      and pg_catalog.char_length(field_value #>> '{}') >
        (field_item #>> '{settings,maxLength}')::integer then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;

    if field_key in (
      'language', 'time_zone', 'currency', 'date_format', 'number_format',
      'default_application_root_id'
    ) then
      core_values := core_values || pg_catalog.jsonb_build_object(field_key, field_value);
    else
      extension_values := extension_values || pg_catalog.jsonb_build_object(field_key, field_value);
    end if;
  end loop;

  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(p_final_values) as key;

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt_claim ->> 'status' = 'completed' then
      projection := vortex_record.read_record(p_record_type_id, p_record_id);
      if projection ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', correlation_id_value
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'saved',
        'recordId', projection -> 'recordId',
        'concurrencyNumber', projection -> 'concurrencyNumber',
        'values', projection -> 'values',
        'correlationId', correlation_id_value,
        'backgroundDelivery', 'pending',
        'replayed', true
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'none' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'reasonCode', 'command_pending',
        'correlationId', correlation_id_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid',
      'correlationId', correlation_id_value
    );
  end if;

  if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'reasonCode', 'record_revision_conflict',
      'concurrencyNumber', loaded -> 'concurrencyNumber',
      'correlationId', correlation_id_value
    );
  end if;

  access_result := vortex_access.change_organization_settings_record_internal(
    p_record_id, p_expected_concurrency_number, core_values, extension_values
  );
  if access_result ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return access_result || pg_catalog.jsonb_build_object(
      'reasonCode', coalesce(access_result ->> 'reasonCode', 'access_conflict'),
      'correlationId', correlation_id_value
    );
  end if;
  if access_result ->> 'outcome' <> 'saved' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', coalesce(access_result ->> 'reasonCode', 'access_refused'),
      'correlationId', correlation_id_value
    );
  end if;

  perform vortex_record.append_base_save_activity_internal(
    p_activity_id, 'update', p_record_id, changed_field_ids, 'completed'
  );
  event_result := vortex_platform.append_record_occurrences(
    (meta ->> 'storageContractId')::uuid,
    p_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'changed', 'recordTypeId', p_record_type_id
      ),
      'payload', pg_catalog.jsonb_build_object(
        'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      )
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Organization settings Event append failed';
  end if;

  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id, p_record_id,
    (access_result ->> 'concurrencyNumber')::bigint,
    'Organization settings record save receipt is stale'
  );
  projection := vortex_record.read_record(p_record_type_id, p_record_id);
  if projection ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '55000',
      message = 'Saved organisation settings projection is unavailable';
  end if;
  begin
    notice_sequence := pg_catalog.nextval(
      'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
    );
    perform vortex_platform.publish_change_notice(
      p_record_id, application_root_id_value, p_record_type_id,
      p_record_id, (access_result ->> 'concurrencyNumber')::bigint, 'changed',
      notice_sequence, notice_sequence, correlation_id_value
    );
  exception when others then
    -- Invalidation is advisory after the protected settings change completes,
    -- but its failure is logged with the cause so a stale view can be diagnosed.
    raise warning 'RECORD_INVALIDATION_FAILED settings record %: % %',
      p_record_id, sqlstate, sqlerrm;
  end;
  return pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', 'pending',
    'replayed', false
  );
exception
  when serialization_failure or deadlock_detected then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Organization settings record save conflicted: % (%)', failure_message, failure_sqlstate;
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'database_conflict_' || failure_sqlstate,
      'correlationId', correlation_id_value
    );
  when no_data_found or too_many_rows or insufficient_privilege or check_violation
    or object_not_in_prerequisite_state or invalid_text_representation then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Organization settings record save refused: % (%)', failure_message, failure_sqlstate;
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'database_refused_' || failure_sqlstate,
      'correlationId', correlation_id_value
    );
end
$function$;
alter function vortex_record.apply_settings_record_changes_internal(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid) owner to vortex_record_adapter;


revoke all on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) to vortex_record_adapter;

comment on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) is
  'Internal settings change reached only through apply_record_changes: rechecks the installed system projection, protected permission and revision, then writes once with one Activity, Event and change notice.';

alter function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) owner to vortex_record_adapter;

drop function vortex_record.project_derived_readable_field_ids_internal(jsonb, uuid, uuid, jsonb, jsonb, jsonb);
drop function vortex_record.total_inputs_readable_internal(jsonb, uuid, uuid, jsonb, jsonb);
drop function vortex_record.read_derived_field_ids_for_exact_record_internal(uuid, uuid, jsonb, jsonb);
drop function vortex_record.filter_calculated_readable_field_ids(jsonb, uuid, jsonb);

reset role;
