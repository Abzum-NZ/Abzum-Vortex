create or replace function vortex_record.read_record_capabilities_page_internal(
  p_record_type_id uuid,
  p_rows jsonb,
  p_envelope jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  row_item jsonb;
  row_index integer := 0;
  record_id uuid;
  compact boolean;
  read_facts jsonb;
  read_bounds jsonb;
  readable_field_ids jsonb;
  read_declaration jsonb;
  permission_by_id jsonb;
  target_meta jsonb;
  required_permissions jsonb;
  action_kind text;
  simple_action boolean;
  use_exact_row boolean;
  row_jobs jsonb[];
  job_list jsonb[] := array[]::jsonb[];
  jobs jsonb := '[]'::jsonb;
  decisions jsonb := '[]'::jsonb;
  bounds_by_route jsonb := '{}'::jsonb;
  bounds_key text;
  update_bounds jsonb;
  results jsonb[] := array[]::jsonb[];
  row_result jsonb;
  decision_item jsonb;
  action_decision jsonb;
  changeable_field_ids jsonb;
  changeable_by_key jsonb := '{}'::jsonb;
  changeable_key text;
  actions text[];
  envelope_jobs jsonb[];
  envelope_exact boolean;
  projection_meta jsonb;
  decisions_by_row jsonb := '{}'::jsonb;
begin
  if p_record_type_id is null or pg_catalog.jsonb_typeof(p_rows) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_rows) > 200
    or (p_envelope is not null and pg_catalog.jsonb_typeof(p_envelope) is distinct from 'object') then
    raise exception using errcode = '22023', message = 'Page capability input is invalid';
  end if;

  for row_item in
    select item.value from pg_catalog.jsonb_array_elements(p_rows) as item(value)
  loop
    row_index := row_index + 1;
    -- A row carries its complete read facts, or (from the page read pass) its
    -- compact record scope, whose page-wide part is the one page envelope.
    compact := pg_catalog.jsonb_typeof(row_item) = 'object' and row_item ? 'record'
      and not (row_item ? 'readFacts');
    if pg_catalog.jsonb_typeof(row_item) is distinct from 'object'
      or not (row_item ?& array['recordId', 'readBounds'])
      or not vortex_platform.is_non_nil_uuid(row_item ->> 'recordId')
      or (compact and (p_envelope is null
        or pg_catalog.jsonb_typeof(row_item -> 'record') is distinct from 'object'
        or row_item #>> '{record,record,recordScope,recordId}'
          is distinct from pg_catalog.lower(row_item ->> 'recordId')))
      or (not compact and pg_catalog.jsonb_typeof(row_item -> 'readFacts') is distinct from 'object')
      or pg_catalog.jsonb_typeof(row_item -> 'readBounds') is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Page capability input is invalid';
    end if;
    record_id := (row_item ->> 'recordId')::uuid;
    read_facts := case when compact then p_envelope else row_item -> 'readFacts' end;
    read_bounds := row_item -> 'readBounds';
    readable_field_ids := read_bounds -> 'readableFieldIds';
    if pg_catalog.jsonb_typeof(readable_field_ids) is distinct from 'array' then
      raise exception using errcode = '22023', message = 'Page capability bounds are invalid';
    end if;

    -- The read projection already made the exact record decision over these
    -- facts. Reuse that validated closure only for simple action routes. Every
    -- compact row shares the page envelope, so its jobs are worked out once.
    row_jobs := null;
    if compact and envelope_exact is not null then
      use_exact_row := envelope_exact;
      row_jobs := envelope_jobs;
    else
      read_declaration := read_facts -> 'declaration';
      permission_by_id := read_facts -> 'accessPermissions';
      target_meta := read_facts -> 'recordTypeMeta';
      use_exact_row := read_facts ? 'previewInstallationId'
        or (read_facts ->> 'isSystemProjection')::boolean is distinct from false
        or pg_catalog.jsonb_typeof(read_declaration) is distinct from 'object'
        or pg_catalog.jsonb_typeof(permission_by_id) is distinct from 'object'
        or pg_catalog.jsonb_typeof(target_meta) is distinct from 'object'
        or (target_meta ->> 'recordTypeId')::uuid is distinct from p_record_type_id
        or coalesce(target_meta ->> 'ownershipMode', '') not in
          ('none', 'organization_account', 'group')
        or read_declaration -> 'recordBinding' is distinct from
          pg_catalog.jsonb_build_object(
            'moduleRootId', target_meta -> 'moduleRootId',
            'recordTypeId', target_meta -> 'recordTypeId',
            'storageContractId', target_meta -> 'storageContractId',
            'storageScope', target_meta -> 'storageScope'
          );
      row_jobs := array[]::jsonb[];
      if not use_exact_row then
        foreach action_kind in array array['update', 'delete', 'restore'] loop
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'applicationRootId', (read_facts -> 'context' ->> 'applicationRootId')::uuid,
              'ownerKind', declared.value ->> 'ownerKind',
              'ownerId', (declared.value ->> 'ownerId')::uuid,
              'permissionId', declared.key::uuid
            )
            order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
          )
          into required_permissions
          from pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
          where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
            and declared.value ->> 'actionKind' = action_kind
            and (declared.value ->> 'namedAction') is null
            and (
              declared.value ->> 'ownerKind' = 'application'
              or (declared.value ->> 'ownerId')::uuid = (target_meta ->> 'moduleRootId')::uuid
            );
          select not exists (
            select 1
            from pg_catalog.jsonb_array_elements(required_permissions) as required(value)
            join pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
              on declared.key = pg_catalog.lower(required.value ->> 'permissionId')
            where pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}')
                is distinct from 'array'
              or exists (
                select 1
                from pg_catalog.jsonb_array_elements(
                  case when pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}') = 'array'
                    then declared.value #> '{recordScope,routes}'
                    else '[]'::jsonb end
                ) as route(value)
                where coalesce(route.value ->> 'kind', '') not in
                  ('all_records', 'ownership', 'direct_share')
              )
          ) into simple_action;
          if not simple_action then
            use_exact_row := true;
            exit;
          end if;
          if required_permissions is not null then
            row_jobs := pg_catalog.array_append(row_jobs, pg_catalog.jsonb_build_object(
              'actionKind', action_kind,
              'requiredPermissions', required_permissions
            ));
          end if;
        end loop;
      end if;
      if compact then
        envelope_exact := use_exact_row;
        envelope_jobs := row_jobs;
      end if;
    end if;
    if use_exact_row then
      -- A protected projection's action context depends only on the record
      -- type and the installation: resolved once for the page.
      if (read_facts ->> 'isSystemProjection')::boolean and projection_meta is null then
        projection_meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
      end if;
      row_result := vortex_record.read_record_capabilities_internal(
        p_record_type_id, record_id,
        case when compact
          then vortex_record.read_record_page_row_facts_internal(p_envelope, row_item -> 'record')
          else read_facts end,
        read_bounds,
        case when (read_facts ->> 'isSystemProjection')::boolean then projection_meta end
      );
      if row_result is null then
        raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
      end if;
      results := pg_catalog.array_append(results, row_result);
    else
      select pg_catalog.array_cat(job_list, coalesce(pg_catalog.array_agg(
          job.value || pg_catalog.jsonb_build_object('rowIndex', row_index) order by job.ordinality),
          array[]::jsonb[]))
      into job_list
      from pg_catalog.unnest(row_jobs) with ordinality as job(value, ordinality);
      results := pg_catalog.array_append(results, 'null'::jsonb);
    end if;
  end loop;

  jobs := pg_catalog.to_jsonb(job_list);
  if jobs <> '[]'::jsonb then
    decisions := vortex_access.evaluate_organization_record_access_page_internal(p_rows, jobs, p_envelope);
    -- The same permission contributions have the same field policy. Resolve
    -- each distinct update contribution set once, then reuse its bounds for
    -- every row admitted through that set.
    select coalesce(pg_catalog.jsonb_object_agg(
      distinct_decision.bounds_key,
      vortex_access.resolve_record_field_bounds_internal(distinct_decision.decision)
    ), '{}'::jsonb)
    into bounds_by_route
    from (
      select distinct on (
        pg_catalog.jsonb_build_array(
          item.value -> 'decision' -> 'organizationId',
          item.value -> 'decision' -> 'matchedContributions'
        )::text
      )
        pg_catalog.jsonb_build_array(
          item.value -> 'decision' -> 'organizationId',
          item.value -> 'decision' -> 'matchedContributions'
        )::text as bounds_key,
        item.value -> 'decision' as decision
      from pg_catalog.jsonb_array_elements(decisions) as item(value)
      where item.value ->> 'actionKind' = 'update'
        and item.value -> 'decision' ->> 'outcome' = 'allowed'
    ) as distinct_decision;
  end if;

  -- Each row's decisions, in decision order, looked up once per row.
  select coalesce(pg_catalog.jsonb_object_agg(grouped.row_key, grouped.items), '{}'::jsonb)
  into decisions_by_row
  from (
    select item.value ->> 'rowIndex' as row_key,
      pg_catalog.jsonb_agg(item.value order by item.ordinality) as items
    from pg_catalog.jsonb_array_elements(decisions) with ordinality as item(value, ordinality)
    group by item.value ->> 'rowIndex'
  ) as grouped;

  for row_index in 1..pg_catalog.jsonb_array_length(p_rows) loop
    if results[row_index] <> 'null'::jsonb then
      continue;
    end if;
    row_item := p_rows -> (row_index - 1);
    readable_field_ids := row_item -> 'readBounds' -> 'readableFieldIds';
    actions := array[]::text[];
    changeable_field_ids := '[]'::jsonb;
    for decision_item in
      select item.value
      from pg_catalog.jsonb_array_elements(coalesce(decisions_by_row -> row_index::text, '[]'::jsonb))
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      action_kind := decision_item ->> 'actionKind';
      action_decision := decision_item -> 'decision';
      if action_decision ->> 'outcome' = 'allowed' then
        actions := pg_catalog.array_append(actions, action_kind);
        if action_kind = 'update' then
          bounds_key := pg_catalog.jsonb_build_array(
            action_decision -> 'organizationId',
            action_decision -> 'matchedContributions'
          )::text;
          update_bounds := bounds_by_route -> bounds_key;
          if update_bounds is null then
            raise exception using errcode = '55000',
              message = 'Page update field bounds are unavailable';
          end if;
          -- The same update bounds and readable fields give the same
          -- changeable fields: worked out once per distinct pair.
          changeable_key := pg_catalog.md5(bounds_key || readable_field_ids::text);
          changeable_field_ids := changeable_by_key -> changeable_key;
          if changeable_field_ids is null then
            changeable_field_ids := coalesce((
              select pg_catalog.jsonb_agg(projected.value order by projected.value)
              from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
              where exists (
                select 1
                from pg_catalog.jsonb_array_elements_text(
                  update_bounds -> 'changeableFieldIds'
                ) as changeable(value)
                where pg_catalog.lower(changeable.value) = pg_catalog.lower(projected.value)
              )
            ), '[]'::jsonb);
            changeable_by_key := changeable_by_key
              || pg_catalog.jsonb_build_object(changeable_key, changeable_field_ids);
          end if;
        end if;
      end if;
    end loop;
    if pg_catalog.jsonb_array_length(changeable_field_ids) = 0 then
      actions := pg_catalog.array_remove(actions, 'update');
    end if;
    results[row_index] := pg_catalog.jsonb_build_object(
      'changeableFieldIds', changeable_field_ids,
      'actions', pg_catalog.to_jsonb(actions)
    );
  end loop;
  return pg_catalog.to_jsonb(results);
end
$function$;

create or replace function vortex_record.read_record_capabilities_page_internal(
  p_record_type_id uuid,
  p_rows jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select vortex_record.read_record_capabilities_page_internal(p_record_type_id, p_rows, null::jsonb)
$function$;

alter function vortex_record.read_record_capabilities_page_internal(uuid,jsonb,jsonb)
  owner to vortex_record_adapter;
alter function vortex_record.read_record_capabilities_page_internal(uuid,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_capabilities_page_internal(uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_record.read_record_capabilities_page_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_capabilities_page_internal(uuid,jsonb,jsonb) is
  'Private list capability pass: evaluates simple action declarations across readable page rows together, while complex routes use their exact single-record path; a row from the page read pass carries only its compact record scope and shares the one page envelope, so the action jobs and the page-wide facts are worked out once for the page.';
comment on function vortex_record.read_record_capabilities_page_internal(uuid,jsonb) is
  'Private list capability pass over rows that each carry their complete read facts; delegates to the envelope variant.';
