create or replace function vortex_access.list_application_role_templates_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer
set search_path = ''
set enable_sort = off
set max_parallel_workers_per_gather = 0
as $function$
declare
  scope_row record;
  candidate record;
  template_value jsonb;
  selected_template jsonb;
  source_role_id_value uuid;
  seen_role_ids uuid[];
  valid_roles boolean;
  after_record_id uuid;
  after_text text;
  emitted integer := 0;
  page_limit integer := coalesce(p_limit, 40);
  scan_sql text;
  comparison text;
  sort_column text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'source_role_id', 'application_root_id', 'key', 'label')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or page_limit not between 1 and 200 then
    raise exception using errcode = '22023',
      message = 'Application role template projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key in ('source_role_id', 'key', 'label') and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0)
          not in ('string', 'null')
      )) then
      raise exception using errcode = '22023',
        message = 'Application role template projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023',
        message = 'Application role template projection cursor is invalid';
    end;
    after_text := p_after -> 'sortKey' ->> 0;
    if p_sort_key = 'source_role_id'
      and after_text is distinct from after_record_id::text then
      raise exception using errcode = '22023',
        message = 'Application role template projection cursor is invalid';
    end if;
  end if;

  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "application_root_id": {"sql": "continuity.application_root_id::text", "database": "text", "filter": true},
      "key": {"sql": "continuity.key", "database": "text", "search": true},
      "label": {"sql": "continuity.label", "database": "text", "filter": true, "search": true}
    }$declared$::jsonb,
    6
  );
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_roles_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;

  comparison := case when p_direction = 'ascending' then '>' else '<' end;
  sort_column := case p_sort_key
    when 'key' then 'continuity.key collate "C"'
    when 'label' then 'continuity.label collate "C"'
    else null end;
  scan_sql := $scan$
    select continuity.application_root_id, continuity.source_role_id,
      continuity.key, continuity.label, continuity.continuity_revision,
      registration.revision as registration_revision,
      release.compilation_output #> '{canonical,content,roles}' as roles
    from vortex_access.application_role_template_continuities as continuity
    join vortex_access.permission_registrations as registration
      on registration.organization_id = continuity.organization_id
      and registration.registration_owner_id = continuity.application_root_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and registration.revision = continuity.last_processed_registration_revision
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = registration.organization_id
      and root.kind = 'application'
      and root.key = registration.source_definition_key
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
      and release.release_version = registration.source_version
      and release.validation_contract_version = registration.validation_contract_version
    where continuity.organization_id = $1
      and continuity.state = 'available'
      and ($2 is null or continuity.source_role_id = any($2))
      and release.application_address ->> 'kind' = 'application'
      and release.compilation_output ->> 'kind' = 'application'
      and exists (
        select 1 from vortex_definition.installation_bindings as binding
        where binding.organization_id = $1
          and binding.application_root_id = root.root_id
          and binding.application_release_revision = registration.source_revision
          and binding.state = 'active'
      )
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '');
  if p_after is not null and p_sort_key in ('record_id', 'source_role_id') then
    scan_sql := scan_sql || pg_catalog.format(
      ' and continuity.source_role_id %s $3', comparison
    );
  elsif p_after is not null and sort_column is not null then
    if after_text is null then
      scan_sql := scan_sql || pg_catalog.format(
        ' and ((%1$s is null and continuity.source_role_id %2$s $3)%3$s)',
        sort_column, comparison,
        case when p_direction = 'ascending'
          then pg_catalog.format(' or %s is not null', sort_column)
          else '' end
      );
    else
      scan_sql := scan_sql || pg_catalog.format(
        ' and ((%1$s, continuity.source_role_id) %2$s ($4 collate "C", $3)%3$s)',
        sort_column, comparison,
        case when p_direction = 'descending'
          then pg_catalog.format(' or %s is null', sort_column)
          else '' end
      );
    end if;
  elsif p_after is not null then
    -- The application root order has no cursor form.
    raise exception using errcode = '22023',
      message = 'Application role template projection cursor is invalid';
  end if;
  scan_sql := scan_sql || case when p_sort_key in ('record_id', 'source_role_id')
    then pg_catalog.format(' order by continuity.source_role_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    when sort_column is not null then pg_catalog.format(
      ' order by %s %s nulls %s, continuity.source_role_id %s',
      sort_column,
      case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'first' else 'last' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format(
      ' order by continuity.application_root_id %s, continuity.source_role_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    end;
  -- No limit in the scan: a candidate whose release roles fail validation is skipped, so the
  -- loop reads on until the page is full (the scan is an ordered index walk, so only the rows
  -- consumed are read).

  for candidate in execute scan_sql using scope_row.organization_id, p_record_ids,
    after_record_id, after_text, p_limit, predicate_plan -> 'parameters'
  loop
    if pg_catalog.jsonb_typeof(candidate.roles) is distinct from 'array' then
      continue;
    end if;
    -- Keep in step with maximumApplicationRoles; p_limit remains the independent page bound.
    if pg_catalog.jsonb_array_length(candidate.roles) not between 1 and 500 then
      continue;
    end if;
    seen_role_ids := array[]::uuid[];
    valid_roles := true;
    selected_template := null;
    -- The entire registered array must be valid even when only one role is read.
    for template_value in
      select template.value
      from pg_catalog.jsonb_array_elements(candidate.roles) as template(value)
    loop
      if pg_catalog.jsonb_typeof(template_value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(template_value -> 'roleId') is distinct from 'string'
        or not vortex_platform.is_non_nil_uuid(template_value ->> 'roleId')
        or pg_catalog.jsonb_typeof(template_value -> 'key') is distinct from 'string'
        or pg_catalog.char_length(template_value ->> 'key') not between 1 and 40
        or (template_value ->> 'key') !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
        or pg_catalog.jsonb_typeof(template_value -> 'name') is distinct from 'string'
        or pg_catalog.char_length(template_value ->> 'name') not between 1 and 60 then
        valid_roles := false;
        exit;
      end if;
      source_role_id_value := (template_value ->> 'roleId')::uuid;
      if source_role_id_value = any(seen_role_ids)
        or not vortex_definition.application_role_identity_is_exact_for_human_request_internal(
          candidate.application_root_id, source_role_id_value
        ) then
        valid_roles := false;
        exit;
      end if;
      seen_role_ids := pg_catalog.array_append(seen_role_ids, source_role_id_value);
      if source_role_id_value = candidate.source_role_id then
        selected_template := template_value;
      end if;
    end loop;
    if not valid_roles or selected_template is null then
      continue;
    end if;
    return query select scope_row.organization_id,
      candidate.source_role_id, candidate.registration_revision,
      pg_catalog.jsonb_build_object(
        'application_root_id', candidate.application_root_id,
        'source_role_id', candidate.source_role_id,
        'key', candidate.key,
        'label', candidate.label,
        'continuity_revision', candidate.continuity_revision
      );
    emitted := emitted + 1;
    exit when emitted >= page_limit;
  end loop;
end
$function$;

revoke all on function vortex_access.list_application_role_templates_projection(
  uuid[], text, text, jsonb, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_application_role_templates_projection(
  uuid[], text, text, jsonb, integer, jsonb
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_application_role_templates_projection(
  uuid[], text, text, jsonb, integer, jsonb
) owner to vortex_owner;

comment on function vortex_access.list_application_role_templates_projection(
  uuid[], text, text, jsonb, integer, jsonb
) is 'Returns one keyset page of registered application role templates, defaulting to 40 rows and limited to 200 rows.';
