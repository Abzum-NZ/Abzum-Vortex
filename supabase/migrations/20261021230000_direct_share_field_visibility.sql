set local role vortex_record_adapter;

create or replace function vortex_record.resolve_record_type_visible_field_ids_internal(
  p_record_type_id uuid, p_installation jsonb, p_plan jsonb,
  p_declaration jsonb, p_eligibility jsonb, p_possible_field_ids jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb := vortex_access.validated_human_request_context();
  meta jsonb := p_plan -> 'recordTypes' -> pg_catalog.lower(p_record_type_id::text);
  routes record;
  candidate record;
  candidate_ids uuid[];
  candidate_id uuid;
  after_id uuid;
  projection_rows jsonb;
  projection_row jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  bounds_key text;
  bounds_by_contribution jsonb := '{}'::jsonb;
  visible jsonb := '[]'::jsonb;
  scan_sql text;
begin
  -- Only the owning wrapper supplies this local decision. No GUC, temporary
  -- table or request argument can supply or retain an access decision.
  if p_eligibility ->> 'outcome' is distinct from 'eligible' then
    return visible;
  end if;
  select resolved.* into routes
  from vortex_access.resolve_record_read_scan_routes_internal(
    p_declaration, meta ->> 'ownershipMode'
  ) as resolved;
  scan_sql := pg_catalog.format(
    'select stored.record_id from record_data.%I as stored
     where stored.organisation_id = $1 and stored.lifecycle_state = ''active''
       and ($2::uuid is null or stored.record_id > $2)
       and (%L <> ''application_contained'' or stored.application_root_id = $3)
       and (not $4 or stored.owner_organisation_account_id = $5
         or stored.owner_group_id = any($6) or stored.record_id = any($7))
     order by stored.record_id limit 40', meta ->> 'table', meta ->> 'storageScope'
  );
  loop
    candidate_ids := '{}'::uuid[];
    projection_rows := '{}'::jsonb;
    if (meta ->> 'isSystemProjection')::boolean then
      -- Protected read models keep their existing bounded reader, never a
      -- scan of the composite view. Only access facts are consumed below.
      for candidate in
        select projected.* from vortex_record.read_system_projection_rows_internal(
          (meta ->> 'storageContractId')::uuid, null, 'record_id', 'ascending',
          case when after_id is null then null else
            pg_catalog.jsonb_build_object('recordId', after_id) end, 40, null::jsonb
        ) as projected
      loop
        candidate_ids := pg_catalog.array_append(candidate_ids, candidate.record_id);
        projection_rows := projection_rows || pg_catalog.jsonb_build_object(
          candidate.record_id::text, pg_catalog.to_jsonb(candidate));
      end loop;
    else
      for candidate in execute scan_sql using (ctx ->> 'organizationId')::uuid,
        after_id, (ctx ->> 'applicationRootId')::uuid, routes.restricted,
        routes.owner_account_id, routes.owner_group_ids, routes.shared_record_ids
      loop
        candidate_ids := pg_catalog.array_append(candidate_ids, candidate.record_id);
      end loop;
    end if;
    exit when pg_catalog.cardinality(candidate_ids) = 0;
    foreach candidate_id in array candidate_ids loop
      projection_row := projection_rows -> candidate_id::text;
      -- No off-screen field projection: the loader reads only operands
      -- required to decide access, including saved conditions and relations.
      loaded := vortex_record.load_record_access_facts_from_installation_internal(
        p_record_type_id, 'read', candidate_id, null, p_installation,
        projection_row, '[]'::jsonb
      );
      if loaded ->> 'outcome' is distinct from 'loaded' then
        continue;
      end if;
      decision := vortex_access.evaluate_organization_record_access_with_eligibility_internal(
        p_declaration, candidate_id, loaded -> 'facts', p_eligibility
      );
      if decision ->> 'outcome' = 'allowed' then
        bounds_key := (decision -> 'matchedContributions')::text;
        bounds := bounds_by_contribution -> bounds_key;
        if bounds is null then
          bounds := vortex_record.decide_record_field_bounds_internal(decision);
          bounds_by_contribution := bounds_by_contribution
            || pg_catalog.jsonb_build_object(bounds_key, bounds);
        end if;
        select coalesce(pg_catalog.jsonb_agg(ids.value order by ids.value), '[]'::jsonb)
        into visible from (
          select distinct field.value from pg_catalog.jsonb_array_elements(
            visible || (bounds -> 'readableFieldIds')
          ) as field(value)
        ) as ids;
        -- Once every potential field has an exact allowed witness there is
        -- nothing left to learn. There is no arbitrary scan cap that could
        -- hide a field readable only on a later record.
        if visible @> p_possible_field_ids then
          return visible;
        end if;
      end if;
    end loop;
    after_id := candidate_ids[pg_catalog.cardinality(candidate_ids)];
  end loop;
  return visible;
end
$function$;

alter function vortex_record.resolve_record_type_visible_field_ids_internal(uuid,jsonb,jsonb,jsonb,jsonb,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.resolve_record_type_visible_field_ids_internal(uuid,jsonb,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.resolve_record_type_visible_field_ids_internal(uuid,jsonb,jsonb,jsonb,jsonb,jsonb)
  to vortex_owner;
comment on function vortex_record.resolve_record_type_visible_field_ids_internal(uuid,jsonb,jsonb,jsonb,jsonb,jsonb) is
  'Owner-only existential column policy: unions the existing exact field decisions of current eligible records, including actual share contributions, without projecting off-screen values.';

set local role vortex_owner;

drop function vortex_platform.read_grid_views(uuid,uuid[],uuid[],jsonb);
drop function vortex_platform.grid_view_document_for_viewer_internal(uuid,jsonb,jsonb,jsonb);

create or replace function vortex_record.read_record_type_visible_field_ids(p_record_type_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb := vortex_access.validated_human_request_context();
  installation jsonb := vortex_definition.read_current_active_installation();
  plan jsonb := vortex_record.resolve_installation_access_plan_internal(installation);
  declaration jsonb;
  eligibility jsonb;
  possible_ids jsonb;
begin
  declaration := vortex_record.record_type_read_declaration_internal(
    plan, p_record_type_id, (ctx ->> 'applicationRootId')::uuid
  );
  if declaration is null then
    return '[]'::jsonb;
  end if;
  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    declaration, ctx, pg_catalog.clock_timestamp()
  );
  if eligibility ->> 'outcome' is distinct from 'eligible' then
    return '[]'::jsonb;
  end if;
  -- An upper bound only, used to stop after exact witnesses cover it. It is
  -- never itself returned as a visibility grant, and uses accepted revisions.
  select coalesce(pg_catalog.jsonb_agg(distinct field.value), '[]'::jsonb)
  into possible_ids
  from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions') as candidate(value)
  join vortex_access.permission_catalogue_entries as entry
    on entry.organization_id = (ctx ->> 'organizationId')::uuid
    and entry.registration_revision = (candidate.value ->> 'registrationRevision')::bigint
    and entry.application_root_id = (candidate.value #>> '{permission,applicationRootId}')::uuid
    and entry.owner_kind = candidate.value #>> '{permission,ownerKind}'
    and entry.owner_id = (candidate.value #>> '{permission,ownerId}')::uuid
    and entry.permission_id = (candidate.value #>> '{permission,permissionId}')::uuid
  cross join lateral pg_catalog.jsonb_array_elements(entry.field_policy -> 'readableFieldIds') as field(value);
  return vortex_record.resolve_record_type_visible_field_ids_internal(
    p_record_type_id, installation, plan, declaration, eligibility, possible_ids
  );
end
$function$;

alter function vortex_record.read_record_type_visible_field_ids(uuid) owner to vortex_owner;
revoke all on function vortex_record.read_record_type_visible_field_ids(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.read_record_type_visible_field_ids(uuid) to vortex_request;
comment on function vortex_record.read_record_type_visible_field_ids(uuid) is
  'Current installed record-type column visibility for the validated human context; returns field identities only, resolved once before grid reads. Distinct from conservative filter/sort bounds.';

create or replace function vortex_platform.grid_view_document_for_viewer_internal(
  p_query_id uuid, p_document jsonb, p_installation jsonb, p_plan jsonb, p_visible_fields jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type_id uuid;
  declaration jsonb;
  eligibility jsonb;
  readable text[] := '{}'::text[];
  filters jsonb;
  sorts jsonb;
  omitted integer;
  omitted_sorts integer;
  document jsonb := p_document;
begin
  if not (p_document ? 'filters' or p_document ? 'sort') then
    return pg_catalog.jsonb_build_object('document', document, 'hiddenFilters', 0, 'hiddenSorts', 0);
  end if;
  context_value := vortex_access.validated_human_request_context();
  -- Resolve only releases pinned by this validated installation, including record-type listings.
  select target.record_type_id into record_type_id
  from (
    select distinct (query.value #>> '{recordType,recordTypeId}')::uuid as record_type_id
    from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as binding(value)
    join vortex_definition.releases as release
      on release.root_id = (binding.value ->> 'moduleRootId')::uuid
      and release.release_revision = (binding.value ->> 'moduleReleaseRevision')::bigint
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,queries}'
    ) as query(value)
    where (query.value ->> 'queryId')::uuid = p_query_id
    union
    select p_query_id
    where p_plan -> 'recordTypes' ? pg_catalog.lower(p_query_id::text)
  ) as target;
  if record_type_id is not null then
    declaration := vortex_record.record_type_read_declaration_internal(
      p_plan, record_type_id, (context_value ->> 'applicationRootId')::uuid
    );
    if declaration is not null then
      -- Reuse the query engine's current field bounds, including direct-share restrictions.
      eligibility := vortex_access.resolve_record_read_field_bounds_internal(declaration);
      select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), '{}'::text[])
      into readable
      from pg_catalog.jsonb_array_elements_text(eligibility -> 'readableFieldIds') as field(value)
      where coalesce(p_visible_fields -> pg_catalog.lower(record_type_id::text), '[]'::jsonb)
        ? pg_catalog.lower(field.value);
    end if;
  end if;
  select coalesce(pg_catalog.jsonb_agg(filter.value order by filter.ordinal), '[]'::jsonb)
  into filters
  from pg_catalog.jsonb_array_elements(coalesce(p_document -> 'filters', '[]'::jsonb))
    with ordinality as filter(value, ordinal)
  where pg_catalog.lower(filter.value ->> 'fieldId') = any(readable);
  omitted := pg_catalog.jsonb_array_length(coalesce(p_document -> 'filters', '[]'::jsonb)) - pg_catalog.jsonb_array_length(filters);
  select coalesce(pg_catalog.jsonb_agg(sort.value order by sort.ordinal), '[]'::jsonb)
  into sorts
  from pg_catalog.jsonb_array_elements(coalesce(p_document -> 'sort', '[]'::jsonb))
    with ordinality as sort(value, ordinal)
  where pg_catalog.lower(sort.value ->> 'fieldId') = any(readable);
  omitted_sorts := pg_catalog.jsonb_array_length(coalesce(p_document -> 'sort', '[]'::jsonb)) - pg_catalog.jsonb_array_length(sorts);
  document := document - 'filters' - 'sort';
  if pg_catalog.jsonb_array_length(filters) > 0 then
    document := document || pg_catalog.jsonb_build_object('filters', filters);
  end if;
  if pg_catalog.jsonb_array_length(sorts) > 0 then
    document := document || pg_catalog.jsonb_build_object('sort', sorts);
  end if;
  if omitted > 0 or omitted_sorts > 0 then
    raise log 'Grid view state omitted code=GRID_VIEW_FIELDS_WITHHELD filters=% sorts=%', omitted, omitted_sorts;
  end if;
  return pg_catalog.jsonb_build_object('document', document, 'hiddenFilters', omitted, 'hiddenSorts', omitted_sorts);
end
$function$;

revoke all on function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb, jsonb)
  owner to vortex_owner;
comment on function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb, jsonb) is
  'Removes saved filters and sorts outside conservative current query field bounds before a selected document leaves the database; owner-only, with counts for the omission notice.';

create or replace function vortex_platform.read_grid_views(
  p_page_id uuid,
  p_placement_ids uuid[],
  p_selected_view_ids uuid[],
  p_default_views jsonb,
  p_record_type_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  targets record;
  shareable uuid[] := '{}'::uuid[];
  installation jsonb;
  access_plan jsonb;
  record_type_id uuid;
  visible_fields jsonb := '{}'::jsonb;
begin
  if p_page_id is null or not vortex_platform.is_non_nil_uuid(p_page_id::text)
    or p_placement_ids is null
    or pg_catalog.cardinality(p_placement_ids) not between 1 and 500
    or pg_catalog.array_position(p_placement_ids, null) is not null
    or p_selected_view_ids is null
    or pg_catalog.cardinality(p_selected_view_ids) > 500
    or pg_catalog.array_position(p_selected_view_ids, null) is not null
    or p_record_type_ids is null
    or pg_catalog.cardinality(p_record_type_ids) not between 1 and 500
    or pg_catalog.array_position(p_record_type_ids, null) is not null
    or p_default_views is null
    or pg_catalog.jsonb_typeof(p_default_views) is distinct from 'array'
 then
    raise exception using errcode = '22023', message = 'Grid view read is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_default_views) > 10000 or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_default_views) as supplied(value)
    where pg_catalog.jsonb_typeof(supplied.value) is distinct from 'object'
      or supplied.value - array['viewId', 'queryId', 'document'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(supplied.value -> 'viewId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(supplied.value -> 'queryId') is distinct from 'string'
      or not vortex_platform.is_non_nil_uuid(supplied.value ->> 'viewId')
      or not vortex_platform.is_non_nil_uuid(supplied.value ->> 'queryId')
      or not vortex_platform.grid_view_document_valid_internal(supplied.value -> 'document', 'named_view')
  ) then
    raise exception using errcode = '22023', message = 'Grid default view read is invalid';
  end if;
  if (select pg_catalog.count(distinct pg_catalog.lower(supplied.value ->> 'viewId'))
      from pg_catalog.jsonb_array_elements(p_default_views) as supplied(value))
    <> pg_catalog.jsonb_array_length(p_default_views) then
    raise exception using errcode = '22023', message = 'Grid default view identities are duplicated';
  end if;

  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;
  select viewer.* into strict targets from vortex_platform.grid_view_viewer_targets_internal(
    scope.organization_id, scope.organization_account_id, scope.application_root_id
  ) as viewer;

  if vortex_platform.grid_view_may_share_internal() then
    shareable := p_placement_ids;
  end if;

  installation := vortex_definition.read_current_active_installation();
  -- One live column decision per record type in this layout request, reused
  -- by every selected/default document. It never enters caller-writable state.
  for record_type_id in select distinct id from pg_catalog.unnest(p_record_type_ids) as requested(id)
  loop
    visible_fields := visible_fields || pg_catalog.jsonb_build_object(
      pg_catalog.lower(record_type_id::text),
      vortex_record.read_record_type_visible_field_ids(record_type_id)
    );
  end loop;
  if exists (select 1 from vortex_platform.grid_views as selected
    where selected.organization_id = scope.organization_id
      and selected.application_root_id = scope.application_root_id
      and selected.view_id = any(p_selected_view_ids) and (selected.document ? 'filters' or selected.document ? 'sort'))
    or exists (select 1 from pg_catalog.jsonb_array_elements(p_default_views) as supplied(value)
      where supplied.value -> 'document' ? 'filters' or supplied.value -> 'document' ? 'sort') then
    access_plan := vortex_record.resolve_installation_access_plan_internal(installation);
  end if;

  -- The person's current layouts and every named view they may see, for all the page's grids, in
  -- one bounded read. Only the views the address selected carry their document.
  return pg_catalog.jsonb_build_object(
    'visibleFields', visible_fields,
    'defaultDocuments', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('viewId', supplied.value ->> 'viewId')
        || vortex_platform.grid_view_document_for_viewer_internal(
          (supplied.value ->> 'queryId')::uuid, supplied.value -> 'document', installation, access_plan,
          visible_fields
        )
      )
      from pg_catalog.jsonb_array_elements(p_default_views) as supplied(value)
    ), '[]'::jsonb),
    'roleKeys', coalesce((
      select pg_catalog.jsonb_agg(distinct template.key)
      from vortex_access.organization_roles as role
      join vortex_access.application_role_template_continuities as template
        on template.organization_id = role.organization_id
        and template.application_root_id = coalesce(role.application_root_id, role.derived_application_root_id)
        and template.source_role_id = coalesce(role.source_role_id, role.derived_source_role_id)
        and template.state = 'available'
      where role.organization_id = scope.organization_id
        and template.application_root_id = scope.application_root_id
        and role.role_id = any(targets.role_ids)
    ), '[]'::jsonb),
    'shareablePlacementIds', pg_catalog.to_jsonb(shareable),
    'layouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'placementId', stored.placement_id,
        'queryId', stored.query_id,
        'revision', stored.revision,
        'basedOnViewId', stored.based_on_view_id,
        'layout', stored.document
      ) order by stored.placement_id)
      from vortex_platform.grid_views as stored
      where stored.organization_id = scope.organization_id
        and stored.organization_account_id = scope.organization_account_id
        and stored.application_root_id = scope.application_root_id
        and stored.page_id = p_page_id
        and stored.placement_id = any (p_placement_ids)
        and stored.kind = 'current_layout'
    ), '[]'::jsonb),
    'views', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'viewId', listed.view_id,
        'placementId', listed.placement_id,
        'queryId', listed.query_id,
        'name', listed.name,
        'scope', listed.scope,
        'mine', listed.organization_account_id = scope.organization_account_id,
        'revision', listed.revision,
        'shareOrganization', listed.share_organization,
        'shareRoleIds', listed.share_role_ids,
        'shareGroupIds', listed.share_group_ids
      ) || case when listed.view_id = any (p_selected_view_ids)
        then vortex_platform.grid_view_document_for_viewer_internal(
          listed.query_id, listed.document, installation, access_plan, visible_fields
        ) else '{}'::jsonb end
        order by listed.placement_id, pg_catalog.lower(listed.name), listed.view_id)
      from (
        select visible.*, pg_catalog.row_number() over (
          partition by visible.placement_id
          order by pg_catalog.lower(visible.name), visible.view_id
        ) as position
        from vortex_platform.grid_views as visible
        where visible.organization_id = scope.organization_id
          and visible.application_root_id = scope.application_root_id
          and visible.page_id = p_page_id
          and visible.placement_id = any (p_placement_ids)
          and visible.kind = 'named_view'
          and (visible.organization_account_id = scope.organization_account_id
            or (visible.scope = 'shared'
              and (visible.share_organization
                or visible.share_role_ids && targets.role_ids
                or visible.share_group_ids && targets.group_ids)))
      ) as listed
      where listed.position <= 200
    ), '[]'::jsonb)
  );
end
$function$;

revoke all on function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb, uuid[]) to vortex_request;

comment on function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb, uuid[]) is
  'Reads the current person''s current layouts and visible named views, and narrows authored default documents through the same current field bounds, in one bounded call.';

alter function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb, uuid[]) owner to vortex_owner;


reset role;
