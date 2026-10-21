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
