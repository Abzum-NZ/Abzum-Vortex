-- #3265, #3196: route-based column visibility that honours direct shares without record scans.

set local role vortex_record_adapter;

create or replace function vortex_record.decide_visible_produced_field_ids_internal(
  p_plan jsonb, p_record_type_id uuid, p_field_ids jsonb
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select vortex_record.decide_produced_field_ids_internal(
    p_plan, p_record_type_id, p_field_ids, '[]'::jsonb
  )
$function$;

alter function vortex_record.decide_visible_produced_field_ids_internal(jsonb, uuid, jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.decide_visible_produced_field_ids_internal(jsonb, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.decide_visible_produced_field_ids_internal(jsonb, uuid, jsonb)
  to vortex_owner;

comment on function vortex_record.decide_visible_produced_field_ids_internal(jsonb, uuid, jsonb) is
  'Owner-only entry to the one produced-field rule for the column decision: a calculation or total the reader cannot fully read is withheld from the field identities it is given.';

set local role vortex_owner;

drop function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb);
drop function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb);

create or replace function vortex_record.resolve_record_type_visible_field_ids_internal(
  p_record_type_id uuid, p_plan jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb := vortex_access.validated_human_request_context();
  checked_at timestamptz := pg_catalog.clock_timestamp();
  declaration jsonb;
  binding jsonb;
  eligibility jsonb;
  candidate jsonb;
  source_value jsonb;
  route jsonb;
  catalogue_entry vortex_access.permission_catalogue_entries%rowtype;
  policy_readable text[];
  routes jsonb;
  visible text[] := array[]::text[];
  share_only_fallback text[] := array[]::text[];
  share_loaded boolean := false;
  share_seen boolean := false;
  share_readable text[] := array[]::text[];
begin
  -- Owner-only: the decision below is local to this call. No GUC, temporary
  -- table or argument can supply or retain an access decision.
  declaration := vortex_record.record_type_read_declaration_internal(
    p_plan, p_record_type_id, (ctx ->> 'applicationRootId')::uuid
  );
  if declaration is null then
    return '[]'::jsonb;
  end if;
  binding := declaration -> 'recordBinding';
  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    declaration, ctx, checked_at
  );
  if eligibility ->> 'outcome' is distinct from 'eligible' then
    return '[]'::jsonb;
  end if;

  -- A column is decided by access route, never record by record: it is visible
  -- when at least one (permission, route) pair the reader holds exposes it. An
  -- all-records, ownership or relationship route exposes its permission's
  -- declared readable fields. A direct-share route can only narrow them to the
  -- fields of the shares the reader holds now, so the set read is bounded by
  -- those shares and never by the size of the table. An unknown route kind
  -- contributes nothing.
  for candidate in
    select listed.value
    from pg_catalog.jsonb_array_elements(
      coalesce(eligibility -> 'eligiblePermissions', '[]'::jsonb)
    ) as listed(value)
  loop
    source_value := candidate -> 'source';
    -- The meaning the caller's role accepted, at the registration revision the
    -- eligibility names; its registration must still be active.
    select entry.* into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and entry.registration_revision <= registration.revision
      and registration.state = 'active'
    where entry.organization_id = (ctx ->> 'organizationId')::uuid
      and entry.registration_revision = (candidate ->> 'registrationRevision')::bigint
      and entry.application_root_id = (candidate #>> '{permission,applicationRootId}')::uuid
      and entry.owner_kind = candidate #>> '{permission,ownerKind}'
      and entry.owner_id = (candidate #>> '{permission,ownerId}')::uuid
      and entry.permission_id = (candidate #>> '{permission,permissionId}')::uuid;
    if not found then
      raise exception using errcode = '22023',
        message = 'Record field visibility found no catalogue entry';
    end if;
    if catalogue_entry.source_kind is distinct from (source_value ->> 'kind')
      or catalogue_entry.source_definition_key is distinct from (source_value ->> 'definitionKey')
      or catalogue_entry.source_root_id is distinct from (source_value ->> 'rootId')::uuid
      or catalogue_entry.source_version is distinct from (source_value ->> 'releaseVersion')
      or catalogue_entry.source_revision is distinct from (source_value ->> 'releaseRevision')::bigint
      or catalogue_entry.source_validation_contract_version
        is distinct from (source_value ->> 'validationContractVersion') then
      raise exception using errcode = '22023',
        message = 'Record field visibility found a superseded permission source';
    end if;
    -- No declared field policy contributes no field, as the record decision does.
    select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), array[]::text[])
    into policy_readable
    from pg_catalog.jsonb_array_elements_text(
      coalesce(catalogue_entry.field_policy -> 'readableFieldIds', '[]'::jsonb)
    ) as field(value);
    if pg_catalog.cardinality(policy_readable) = 0 then
      continue;
    end if;
    routes := candidate -> 'recordScope' -> 'routes';
    if pg_catalog.jsonb_typeof(routes) is distinct from 'array' then
      continue;
    end if;
    for route in select item.value from pg_catalog.jsonb_array_elements(routes) as item(value)
    loop
      case route ->> 'kind'
        when 'all_records', 'ownership', 'relationship' then
          visible := visible || policy_readable;
          continue;
        when 'direct_share' then
          null;
        else
          continue;
      end case;
      if not share_loaded then
        select pg_catalog.count(*) > 0,
          coalesce(pg_catalog.array_agg(distinct pg_catalog.lower(field.value::text))
            filter (where field.value is not null), array[]::text[])
        into share_seen, share_readable
        from vortex_access.organization_direct_record_shares as share
        left join lateral pg_catalog.unnest(share.readable_field_ids) as field(value) on true
        where share.organization_id = (ctx ->> 'organizationId')::uuid
          and share.storage_scope = binding ->> 'storageScope'
          and share.application_scope_id = coalesce(case
            when binding ->> 'storageScope' = 'application_contained'
              then (declaration -> 'target' ->> 'applicationRootId')::uuid
            else null::uuid
          end, '00000000-0000-0000-0000-000000000000'::uuid)
          and share.module_root_id = (binding ->> 'moduleRootId')::uuid
          and share.record_type_id = (binding ->> 'recordTypeId')::uuid
          and share.storage_contract_id = (binding ->> 'storageContractId')::uuid
          and share.state = 'active'
          and share.starts_at <= checked_at
          and (share.expires_at is null or share.expires_at > checked_at)
          and (
            (share.recipient_kind = 'organization_account'
              and share.organization_account_id = (ctx ->> 'organizationAccountId')::uuid)
            or (share.recipient_kind = 'group' and exists (
              select 1
              from vortex_access.organization_group_memberships as membership
              join vortex_access.organization_groups as organization_group
                on organization_group.organization_id = membership.organization_id
                and organization_group.group_id = membership.group_id
                and organization_group.state = 'active'
              where membership.organization_id = share.organization_id
                and membership.group_id = share.group_id
                and membership.organization_account_id = (ctx ->> 'organizationAccountId')::uuid
                and membership.state = 'live'
                and membership.starts_at <= checked_at
                and (membership.expires_at is null or membership.expires_at > checked_at)
            ))
          );
        share_loaded := true;
      end if;
      -- With no current share the route admits no record and adds no column;
      -- its declared fields are kept only as the share-only fallback below.
      if share_seen then
        visible := visible || array(
          select shared.value from pg_catalog.unnest(policy_readable) as shared(value)
          where shared.value = any (share_readable)
        );
      else
        share_only_fallback := share_only_fallback || policy_readable;
      end if;
    end loop;
  end loop;

  -- A reader whose only routes are shares, none current, still sees the
  -- declared columns over an empty result; any other route's columns win.
  if pg_catalog.cardinality(visible) = 0 then
    visible := share_only_fallback;
  end if;

  -- The upper bound, then the one rule for produced fields: a calculation or
  -- total the reader cannot fully read stays withheld.
  return vortex_record.decide_visible_produced_field_ids_internal(
    p_plan, p_record_type_id,
    coalesce((
      select pg_catalog.jsonb_agg(ids.value order by ids.value)
      from (select distinct listed.value from pg_catalog.unnest(visible) as listed(value)) as ids
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_record.resolve_record_type_visible_field_ids_internal(uuid, jsonb)
  owner to vortex_owner;
revoke all on function vortex_record.resolve_record_type_visible_field_ids_internal(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_record.resolve_record_type_visible_field_ids_internal(uuid, jsonb) is
  'Owner-only column visibility of one record type for the validated human context, decided by access route: the declared readable fields of each eligible permission route, narrowed by the fields of the current direct shares on a share route (a share route with no current share adds nothing unless no route yields a column), then by the produced-field rule. It reads no record, so its cost is bounded by routes and shares.';

create or replace function vortex_record.read_record_type_visible_field_ids(p_record_type_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  return vortex_record.resolve_record_type_visible_field_ids_internal(
    p_record_type_id,
    vortex_record.resolve_installation_access_plan_internal(
      vortex_definition.read_current_active_installation()
    )
  );
end
$function$;

alter function vortex_record.read_record_type_visible_field_ids(uuid) owner to vortex_owner;
revoke all on function vortex_record.read_record_type_visible_field_ids(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.read_record_type_visible_field_ids(uuid) to vortex_request;
comment on function vortex_record.read_record_type_visible_field_ids(uuid) is
  'The columns of one record type the validated human context may read now, by access route; field identities only, resolved once before a grid or picker reads its rows.';

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
  formatting jsonb;
  omitted integer := 0;
  omitted_sorts integer := 0;
  omitted_formatting integer := 0;
  document jsonb := p_document;
begin
  if not (p_document ? 'filters') and not (p_document ? 'sort') and not (p_document ? 'formatting') then
    return pg_catalog.jsonb_build_object(
      'document', document, 'hiddenFilters', 0, 'hiddenSorts', 0, 'hiddenFormatting', 0);
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
      -- A saved operand stays only on a field every record the reader reaches exposes (the query
      -- engine's field bounds, including direct-share restrictions) and the reader's column
      -- decision (the visible fields) offers.
      eligibility := vortex_access.resolve_record_read_field_bounds_internal(declaration);
      select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), '{}'::text[])
      into readable
      from pg_catalog.jsonb_array_elements_text(eligibility -> 'readableFieldIds') as field(value)
      where coalesce(p_visible_fields -> pg_catalog.lower(record_type_id::text), '[]'::jsonb)
        ? pg_catalog.lower(field.value);
    end if;
  end if;
  if p_document ? 'filters' then
    select coalesce(pg_catalog.jsonb_agg(filter.value order by filter.ordinal), '[]'::jsonb)
    into filters
    from pg_catalog.jsonb_array_elements(p_document -> 'filters')
      with ordinality as filter(value, ordinal)
    where pg_catalog.lower(filter.value ->> 'fieldId') = any(readable);
    omitted := pg_catalog.jsonb_array_length(p_document -> 'filters') - pg_catalog.jsonb_array_length(filters);
    document := document - 'filters';
    if pg_catalog.jsonb_array_length(filters) > 0 then
      document := document || pg_catalog.jsonb_build_object('filters', filters);
    end if;
  end if;
  if p_document ? 'sort' then
    select coalesce(pg_catalog.jsonb_agg(sort.value order by sort.ordinal), '[]'::jsonb)
    into sorts
    from pg_catalog.jsonb_array_elements(p_document -> 'sort')
      with ordinality as sort(value, ordinal)
    where pg_catalog.lower(sort.value ->> 'fieldId') = any(readable);
    omitted_sorts := pg_catalog.jsonb_array_length(p_document -> 'sort') - pg_catalog.jsonb_array_length(sorts);
    document := document - 'sort';
    if pg_catalog.jsonb_array_length(sorts) > 0 then
      document := document || pg_catalog.jsonb_build_object('sort', sorts);
    end if;
  end if;
  if p_document ? 'formatting' then
    -- A rule leaves with everything it stores (its comparison values and targets) unless every
    -- field it reads, in its condition or its cells, is one this viewer can read now.
    select coalesce(pg_catalog.jsonb_agg(rule.value order by rule.ordinal), '[]'::jsonb)
    into formatting
    from pg_catalog.jsonb_array_elements(p_document -> 'formatting')
      with ordinality as rule(value, ordinal)
    where vortex_platform.grid_view_condition_field_ids_internal(rule.value -> 'condition', 1) is not null
      and not exists (
        select 1
        from pg_catalog.unnest(
          vortex_platform.grid_view_condition_field_ids_internal(rule.value -> 'condition', 1)
          || array(select pg_catalog.lower(cell.value)
            from pg_catalog.jsonb_array_elements_text(rule.value -> 'target' -> 'fields') as cell(value))
        ) as used(field_id)
        where used.field_id <> all (readable)
      );
    omitted_formatting := pg_catalog.jsonb_array_length(p_document -> 'formatting')
      - pg_catalog.jsonb_array_length(formatting);
    document := document - 'formatting';
    if pg_catalog.jsonb_array_length(formatting) > 0 then
      document := document || pg_catalog.jsonb_build_object('formatting', formatting);
    end if;
  end if;
  if omitted > 0 or omitted_sorts > 0 or omitted_formatting > 0 then
    raise log 'Grid view state omitted code=GRID_VIEW_FIELDS_WITHHELD filters=% sorts=% formatting=%',
      omitted, omitted_sorts, omitted_formatting;
  end if;
  return pg_catalog.jsonb_build_object(
    'document', document, 'hiddenFilters', omitted, 'hiddenSorts', omitted_sorts,
    'hiddenFormatting', omitted_formatting);
end
$function$;

revoke all on function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb, jsonb)
  owner to vortex_owner;
comment on function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb, jsonb) is
  'Removes saved filter values, sorts and formatting rules outside the reader''s current column decision and field bounds before a selected document leaves the database; owner-only, with counts for the omission notice.';

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
  access_plan := vortex_record.resolve_installation_access_plan_internal(installation);
  -- One column decision per record type of this layout request, by access route, from the plan
  -- resolved once here; it stays a local value and never enters caller-writable state.
  for record_type_id in select distinct id from pg_catalog.unnest(p_record_type_ids) as requested(id)
  loop
    visible_fields := visible_fields || pg_catalog.jsonb_build_object(
      pg_catalog.lower(record_type_id::text),
      vortex_record.resolve_record_type_visible_field_ids_internal(record_type_id, access_plan)
    );
  end loop;

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
  'Reads the current person''s current layouts and visible named views, and decides the readable columns of the requested record types by access route, and narrows authored default documents through the same current field bounds, in one bounded call.';

alter function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb, uuid[]) owner to vortex_owner;

create or replace function vortex_platform.save_grid_view(
  p_page_id uuid,
  p_placement_id uuid,
  p_query_id uuid,
  p_view_id uuid,
  p_expected_revision bigint,
  p_name text,
  p_document jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  stored vortex_platform.grid_views%rowtype;
  held_found boolean;
  owned_count bigint;
  installation jsonb;
  access_plan jsonb;
  record_type_id uuid;
  field_types jsonb;
  field_nulls jsonb;
  format_rule jsonb;
  written_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_page_id is null or not vortex_platform.is_non_nil_uuid(p_page_id::text)
    or p_placement_id is null or not vortex_platform.is_non_nil_uuid(p_placement_id::text)
    or p_query_id is null or not vortex_platform.is_non_nil_uuid(p_query_id::text)
    or (p_view_id is null) <> (p_expected_revision is null)
    or (p_view_id is not null and not vortex_platform.is_non_nil_uuid(p_view_id::text))
    or (p_expected_revision is not null
      and p_expected_revision not between 1 and 9007199254740990)
    -- A new view needs a name and a document; a change may leave either as it is.
    or (p_view_id is null and (p_name is null or p_document is null))
    or (p_name is not null and (p_name <> pg_catalog.btrim(p_name)
      or pg_catalog.char_length(p_name) not between 1 and 80))
    or (p_document is not null
      and not vortex_platform.grid_view_document_valid_internal(p_document, 'named_view')) then
    raise exception using errcode = '22023', message = 'Grid view save is invalid';
  end if;

  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;

  -- A personal rule reads fields that exist and that the author can read now; the projection that
  -- recipients receive is the check, so a rule it would omit for the author is refused here.
  if p_document is not null and p_document ? 'formatting' then
    installation := vortex_definition.read_current_active_installation();
    access_plan := vortex_record.resolve_installation_access_plan_internal(installation);
    select distinct (query.value #>> '{recordType,recordTypeId}')::uuid into record_type_id
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as binding(value)
    join vortex_definition.releases as release
      on release.root_id = (binding.value ->> 'moduleRootId')::uuid
      and release.release_revision = (binding.value ->> 'moduleReleaseRevision')::bigint
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,queries}') as query(value)
    where (query.value ->> 'queryId')::uuid = p_query_id;
    -- Record-type listings use their record type as the query identity.
    if record_type_id is null and access_plan -> 'recordTypes' ? p_query_id::text then
      record_type_id := p_query_id;
    end if;
    if (vortex_platform.grid_view_document_for_viewer_internal(
        p_query_id, p_document, installation, access_plan,
        case when record_type_id is null then '{}'::jsonb else pg_catalog.jsonb_build_object(
          pg_catalog.lower(record_type_id::text),
          vortex_record.resolve_record_type_visible_field_ids_internal(record_type_id, access_plan)
        ) end) ->> 'hiddenFormatting')::integer > 0 then
      return pg_catalog.jsonb_build_object('outcome', 'formatting_refused', 'cause', 'field_not_readable');
    end if;
    select pg_catalog.jsonb_object_agg(field.value ->> 'fieldId', case
        when kind.value in ('whole_number', 'decimal_number', 'money', 'yes_no', 'date', 'date_time')
          then kind.value
        when kind.value = 'several_choices' then 'text_collection'
        when kind.value in ('link', 'link_to_one_of_several') then 'record_reference'
        when kind.value in ('table', 'attachment') then 'opaque_json'
        else 'text' end),
      pg_catalog.jsonb_object_agg(field.value ->> 'fieldId', 'null'::jsonb)
    into field_types, field_nulls
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as binding(value)
    join vortex_definition.releases as release
      on release.root_id = (binding.value ->> 'moduleRootId')::uuid
      and release.release_revision = (binding.value ->> 'moduleReleaseRevision')::bigint
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,recordTypes}') as record_type(value)
    cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
    cross join lateral (select case when field.value ->> 'type' in ('calculation', 'total')
      then field.value #>> '{settings,resultType}' else field.value ->> 'type' end) as kind(value)
    where (record_type.value ->> 'recordTypeId')::uuid = record_type_id;
    for format_rule in select value from pg_catalog.jsonb_array_elements(p_document -> 'formatting')
    loop
      begin
        perform vortex_access.evaluate_query_condition_internal(
          format_rule -> 'condition', field_types, field_nulls,
          '{"today":"date","start_of_week":"date","end_of_week":"date","start_of_month":"date","end_of_month":"date"}'::jsonb,
          '{"today":null,"start_of_week":null,"end_of_week":null,"start_of_month":null,"end_of_month":null}'::jsonb,
          true);
      exception when invalid_parameter_value then
        return pg_catalog.jsonb_build_object('outcome', 'formatting_refused', 'cause', 'rule_invalid');
      end;
    end loop;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    scope.organization_id::text || ':' || scope.application_root_id::text || ':' ||
    p_page_id::text || ':' || p_placement_id::text || ':views',
    0
  ));

  if p_view_id is null then
    select pg_catalog.count(*) into owned_count
    from vortex_platform.grid_views as owned
    where owned.organization_id = scope.organization_id
      and owned.organization_account_id = scope.organization_account_id
      and owned.application_root_id = scope.application_root_id
      and owned.page_id = p_page_id
      and owned.placement_id = p_placement_id
      and owned.kind = 'named_view';
    if owned_count >= 50 then
      return pg_catalog.jsonb_build_object('outcome', 'limit');
    end if;
    insert into vortex_platform.grid_views (
      view_id, tenant_id, organization_id, organization_account_id, application_root_id,
      page_id, placement_id, kind, query_id, revision, release_revision, name, scope,
      document, created_at, updated_at
    ) values (
      pg_catalog.gen_random_uuid(), scope.tenant_id, scope.organization_id,
      scope.organization_account_id, scope.application_root_id, p_page_id, p_placement_id,
      'named_view', p_query_id,
      pg_catalog.nextval('vortex_platform.grid_view_revision_seq'::regclass),
      scope.release_revision, p_name, 'personal', p_document, written_at, written_at
    )
    returning * into stored;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved', 'viewId', stored.view_id, 'revision', stored.revision);
  end if;

  -- Only a view the person owns or that is shared with them can be named at all.
  if not vortex_platform.grid_view_visible_internal(
    scope.organization_id, scope.organization_account_id, scope.application_root_id,
    p_page_id, p_placement_id, p_view_id
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;

  select held.* into stored
  from vortex_platform.grid_views as held
  where held.view_id = p_view_id
    and held.organization_id = scope.organization_id
  for update;
  held_found := found;
  if not held_found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;

  -- Only the owner, or someone who may share table views, changes a view.
  if stored.organization_account_id <> scope.organization_account_id
    and not vortex_platform.grid_view_may_share_internal() then
    return pg_catalog.jsonb_build_object('outcome', 'forbidden');
  end if;

  if stored.revision <> p_expected_revision then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'revision', stored.revision,
      'name', stored.name,
      'queryId', stored.query_id
    );
  end if;

  update vortex_platform.grid_views as held
  set query_id = case when p_document is null then held.query_id else p_query_id end,
    name = coalesce(p_name, held.name),
    document = coalesce(p_document, held.document),
    revision = pg_catalog.nextval('vortex_platform.grid_view_revision_seq'::regclass),
    release_revision = scope.release_revision,
    updated_at = written_at
  where held.view_id = stored.view_id
  returning held.* into stored;

  return pg_catalog.jsonb_build_object(
    'outcome', 'saved', 'viewId', stored.view_id, 'revision', stored.revision);
end
$function$;

revoke all on function vortex_platform.save_grid_view(uuid, uuid, uuid, uuid, bigint, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.save_grid_view(uuid, uuid, uuid, uuid, bigint, text, jsonb)
  to vortex_request;

comment on function vortex_platform.save_grid_view(uuid, uuid, uuid, uuid, bigint, text, jsonb) is
  'Creates a named grid view of the current person, or renames or replaces one at the expected revision (the owner, or someone who may share table views), or returns the stored revision as a conflict.';

alter function vortex_platform.save_grid_view(uuid, uuid, uuid, uuid, bigint, text, jsonb)
  owner to vortex_owner;

reset role;
