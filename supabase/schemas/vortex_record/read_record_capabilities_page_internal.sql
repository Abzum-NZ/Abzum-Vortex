create or replace function vortex_record.read_record_capabilities_page_internal(
  p_record_type_id uuid,
  p_rows jsonb
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
  jobs jsonb := '[]'::jsonb;
  decisions jsonb := '[]'::jsonb;
  results jsonb := '[]'::jsonb;
  row_result jsonb;
  decision_item jsonb;
  action_decision jsonb;
  changeable_field_ids jsonb;
  actions text[];
begin
  if p_record_type_id is null or pg_catalog.jsonb_typeof(p_rows) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_rows) > 200 then
    raise exception using errcode = '22023', message = 'Page capability input is invalid';
  end if;

  for row_item in
    select item.value from pg_catalog.jsonb_array_elements(p_rows) as item(value)
  loop
    row_index := row_index + 1;
    if pg_catalog.jsonb_typeof(row_item) is distinct from 'object'
      or not (row_item ?& array['recordId', 'readFacts', 'readBounds'])
      or not vortex_platform.is_non_nil_uuid(row_item ->> 'recordId')
      or pg_catalog.jsonb_typeof(row_item -> 'readFacts') is distinct from 'object'
      or pg_catalog.jsonb_typeof(row_item -> 'readBounds') is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Page capability input is invalid';
    end if;
    record_id := (row_item ->> 'recordId')::uuid;
    read_facts := row_item -> 'readFacts';
    read_bounds := row_item -> 'readBounds';
    readable_field_ids := read_bounds -> 'readableFieldIds';
    if pg_catalog.jsonb_typeof(readable_field_ids) is distinct from 'array' then
      raise exception using errcode = '22023', message = 'Page capability bounds are invalid';
    end if;

    -- The read projection already made the exact record decision over these
    -- facts. Reuse that validated closure only for simple action routes.
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
          jobs := jobs || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'rowIndex', row_index,
            'actionKind', action_kind,
            'requiredPermissions', required_permissions
          ));
        end if;
      end loop;
    end if;
    if use_exact_row then
      -- Discard any simple jobs accumulated before a complex route was found.
      jobs := (
        select coalesce(pg_catalog.jsonb_agg(job.value order by job.ordinality), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(jobs) with ordinality as job(value, ordinality)
        where (job.value ->> 'rowIndex')::integer <> row_index
      );
      row_result := vortex_record.read_record_capabilities_internal(
        p_record_type_id, record_id, read_facts, read_bounds
      );
      if row_result is null then
        raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
      end if;
      results := results || pg_catalog.jsonb_build_array(row_result);
    else
      results := results || pg_catalog.jsonb_build_array('null'::jsonb);
    end if;
  end loop;

  if jobs <> '[]'::jsonb then
    decisions := vortex_access.evaluate_organization_record_access_page_internal(p_rows, jobs);
  end if;

  for row_index in 1..pg_catalog.jsonb_array_length(p_rows) loop
    if results -> (row_index - 1) <> 'null'::jsonb then
      continue;
    end if;
    row_item := p_rows -> (row_index - 1);
    readable_field_ids := row_item -> 'readBounds' -> 'readableFieldIds';
    actions := array[]::text[];
    changeable_field_ids := '[]'::jsonb;
    for decision_item in
      select item.value
      from pg_catalog.jsonb_array_elements(decisions)
        with ordinality as item(value, ordinality)
      where (item.value ->> 'rowIndex')::integer = row_index
      order by item.ordinality
    loop
      action_kind := decision_item ->> 'actionKind';
      action_decision := decision_item -> 'decision';
      if action_decision ->> 'outcome' = 'allowed' then
        actions := pg_catalog.array_append(actions, action_kind);
        if action_kind = 'update' then
          changeable_field_ids := coalesce((
            select pg_catalog.jsonb_agg(projected.value order by projected.value)
            from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
            where exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(
                vortex_access.resolve_record_field_bounds_internal(action_decision)
                  -> 'changeableFieldIds'
              ) as changeable(value)
              where pg_catalog.lower(changeable.value) = pg_catalog.lower(projected.value)
            )
          ), '[]'::jsonb);
        end if;
      end if;
    end loop;
    if pg_catalog.jsonb_array_length(changeable_field_ids) = 0 then
      actions := pg_catalog.array_remove(actions, 'update');
    end if;
    results := pg_catalog.jsonb_set(results, array[(row_index - 1)::text],
      pg_catalog.jsonb_build_object(
        'changeableFieldIds', changeable_field_ids,
        'actions', pg_catalog.to_jsonb(actions)
      ));
  end loop;
  return results;
end
$function$;

alter function vortex_record.read_record_capabilities_page_internal(uuid,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_capabilities_page_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_capabilities_page_internal(uuid,jsonb) is
  'Private list capability pass: evaluates simple action declarations across readable page rows together, while complex routes use their exact single-record path.';
