-- FIX-APP-SURFACES-LINKS (#3862): one applications read.
--
-- The App Store's Applications page, the Landing Zone's application tiles and organisation
-- administration's installed applications all read this one projection, so no two surfaces can
-- disagree about which applications an organisation has or which versions are installed and
-- waiting. It gains the revision installed now (absent while nothing is installed) and whether the
-- application is the organisation's default one, which is what organisation administration lists,
-- and it sorts by the installed revision as the retired read did.
--
-- The retired installed-applications projection, its registration and its access to the record
-- adapter go in the same change: organisation administration's record type now reads this
-- projection, filtered to the applications that are installed. Stored storage contracts of older
-- releases keep their read-model key as history; the live registry no longer names it.
set role vortex_owner;

create or replace function vortex_access.list_application_store_entries_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer
set search_path = ''
set max_parallel_workers_per_gather = 0
as $function$
declare
  context_value jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  sort_column text;
  sort_sql text;
  keyset_sql text := '';
  after_text text;
  after_revision bigint;
  after_record_id uuid;
  comparison text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'key', 'name', 'release_revision')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key not in ('record_id', 'key') and p_limit is null) then
    raise exception using errcode = '22023',
      message = 'Application catalogue projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0)
          not in ('string', 'null')
      )) then
      raise exception using errcode = '22023',
        message = 'Application catalogue projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if p_sort_key = 'release_revision' then
        after_revision := after_text::bigint;
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '22023',
        message = 'Application catalogue projection cursor is invalid';
    end;
    if p_sort_key in ('key', 'release_revision') and after_text is null then
      raise exception using errcode = '22023',
        message = 'Application catalogue projection cursor is invalid';
    end if;
  end if;

  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "key": {"sql": "root.key", "database": "text", "filter": true, "search": true},
      "name": {"sql": "(latest.application_address ->> 'name')", "database": "text", "filter": true, "search": true},
      "release_revision": {"sql": "installed.release_revision", "database": "integer", "filter": true},
      "is_default": {"sql": "(root.root_id is not distinct from (select default_settings.default_application_root_id from vortex_identity.organization_runtime_settings as default_settings where default_settings.organization_id = root.organization_id))", "database": "boolean", "filter": true},
      "status": {"sql": "(case when installed.release_revision is null then 'available' when installed.release_revision < root.current_release_revision then 'update_available' else 'installed' end)", "database": "text", "filter": true}
    }$declared$::jsonb,
    6
  );
  begin
    context_value := vortex_access.validated_human_request_context();
  exception when insufficient_privilege then
    return;
  end;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_platform.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform 1 from vortex_access.resolve_human_organization_scope(
      actor_identity_id, visible_organization_id
    );
  exception when sqlstate '42501' or sqlstate 'P0002' then
    return;
  end;

  sort_column := case p_sort_key
    when 'key' then 'root.key'
    when 'name' then '(latest.application_address ->> ''name'')'
    when 'release_revision' then 'installed.release_revision'
    else 'root.root_id' end;
  comparison := case when p_direction = 'ascending' then '>' else '<' end;
  if p_after is not null then
    if p_sort_key = 'record_id' then
      keyset_sql := pg_catalog.format(' and root.root_id %s $4', comparison);
    elsif p_sort_key = 'name' and after_text is null then
      keyset_sql := case when p_direction = 'ascending'
        then ' and (((latest.application_address ->> ''name'') is null
            and root.root_id > $4)
          or (latest.application_address ->> ''name'') is not null)'
        else ' and (latest.application_address ->> ''name'') is null
          and root.root_id < $4' end;
    elsif p_sort_key = 'name' then
      keyset_sql := pg_catalog.format(
        ' and ((%s collate "C", root.root_id) %s ($3 collate "C", $4)%s)',
        sort_column, comparison,
        case when p_direction = 'descending'
          then ' or (latest.application_address ->> ''name'') is null'
          else '' end);
    elsif p_sort_key = 'release_revision' then
      keyset_sql := pg_catalog.format(
        ' and (installed.release_revision, root.root_id) %s ($3::bigint, $4)',
        comparison);
    else
      keyset_sql := pg_catalog.format(
        ' and (root.key collate "C", root.root_id) %s ($3 collate "C", $4)', comparison);
    end if;
  end if;
  sort_sql := pg_catalog.format('%s%s %s%s, %s %s',
    sort_column,
    case when p_sort_key in ('key', 'name') then ' collate "C"' else '' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end,
    case when p_sort_key = 'name' then
      case when p_direction = 'ascending' then ' nulls first' else ' nulls last' end
      else '' end,
    'root.root_id',
    case when p_direction = 'ascending' then 'asc' else 'desc' end);
  if p_sort_key = 'record_id' then
    sort_sql := pg_catalog.format('root.root_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end);
  end if;

  return query execute $scan$
    select $1, root.root_id, root.current_release_revision,
      pg_catalog.jsonb_build_object(
        'key', root.key,
        'name', latest.application_address ->> 'name',
        'icon', latest.application_address ->> 'icon',
        'is_system_application',
          root.application_origin_kind = 'platform_system_application',
        'description', latest.compilation_output #>> '{canonical,content,description}',
        'latest_version', latest.release_version,
        'latest_release_note', latest.release_note,
        'published_at', latest.published_at,
        'record_update_status', case
          when installed.release_revision is null then 'not_required'
          when backfill.occurrence_id is null then 'up_to_date'
          when backfill.terminally_failed_at is not null then 'failed'
          when backfill.acknowledged_at is not null or (
            (backfill.checkpoint ->> 'complete')::boolean
            and (backfill.checkpoint ->> 'releaseRevision')::bigint = installed.release_revision
          ) then 'up_to_date'
          when backfill.last_failure_code is not null then 'retrying'
          when backfill.claimed_at is null then 'pending'
          else 'updating' end,
        'records_processed', coalesce((backfill.checkpoint ->> 'processedCount')::bigint, 0),
        'installed_version', coalesce(installed.release_version, 'Not installed'),
        'release_revision', installed.release_revision,
        'is_default', root.root_id is not distinct from (
          select default_settings.default_application_root_id
          from vortex_identity.organization_runtime_settings as default_settings
          where default_settings.organization_id = root.organization_id),
        'status', case
          when installed.release_revision is null then 'available'
          when installed.release_revision < root.current_release_revision then 'update_available'
          else 'installed' end
      )
    from vortex_definition.roots as root
    join vortex_definition.releases as latest
      on latest.root_id = root.root_id
      and latest.release_revision = root.current_release_revision
    left join lateral (
      select release.release_revision, release.release_version
      from vortex_access.permission_registrations as registration
      join vortex_definition.releases as release
        on release.root_id = root.root_id
        and release.release_revision = registration.source_revision
        and release.release_version = registration.source_version
        and release.validation_contract_version = registration.validation_contract_version
      where registration.organization_id = root.organization_id
        and registration.registration_owner_id = root.root_id
        and registration.registration_kind = 'application'
        and registration.state = 'active'
        and registration.source_definition_key = root.key
        and exists (
          select 1 from vortex_definition.installation_bindings as binding
          where binding.organization_id = root.organization_id
            and binding.application_root_id = root.root_id
            and binding.application_release_revision = registration.source_revision
            and binding.state = 'active'
        )
      limit 1
    ) as installed on true
    left join lateral (
      select occurrence.occurrence_id, progress.terminally_failed_at, progress.acknowledged_at,
        progress.claimed_at, progress.last_failure_code, progress.checkpoint
      from vortex_platform.event_outbox as occurrence
      left join vortex_platform.consumer_occurrence_progress as progress
        on progress.occurrence_id = occurrence.occurrence_id
        and progress.consumer_key = 'installation-derived-values'
      where occurrence.organization_id = root.organization_id
        and occurrence.sequence_application_root_id = root.root_id
        and occurrence.occurrence_kind = 'installation_activated'
        and occurrence.record_sequence <= installed.release_revision
      -- Surface the work that blocks this installation, including an older failed
      -- activation in front of the current one. Once caught up, show the latest result.
      order by (progress.acknowledged_at is null) desc,
        case when progress.acknowledged_at is null then occurrence.record_sequence end asc,
        occurrence.record_sequence desc
      limit 1
    ) as backfill on true
    where root.organization_id = $1
      and root.kind = 'application'
      and root.current_release_revision is not null
      and ($2 is null or root.root_id = any($2))
      and latest.application_address ->> 'kind' = 'application'
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $5', sort_sql)
  using visible_organization_id, p_record_ids, after_text, after_record_id, p_limit,
    predicate_plan -> 'parameters';
end
$function$;

comment on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) is 'The organisation''s application catalogue: every Application it has, ordinary or platform system, the latest version and its release note, the version installed now if any, whether it is the default application, and the release revision installed.';

revoke all on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) owner to vortex_owner;

-- A stored release's authored source is the base of its next publication, and it is read back
-- through the current source contract; a stored draft is the same. Both still name the retired
-- read, so the forward migration rewrites that one value in place for every draft and every
-- release, recomputes each recorded fingerprint with the same canonical JSON the contract uses,
-- and verifies every recorded fingerprint before it touches anything. One read, one name.
create function pg_temp.application_store_canonical_json(p_value jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  result text;
  member text;
  first boolean := true;
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      result := '{';
      for member in
        select item.key from pg_catalog.jsonb_object_keys(p_value) as item(key)
        order by item.key collate "C"
      loop
        result := result || case when first then '' else ',' end
          || pg_catalog.to_json(member)::text || ':'
          || pg_temp.application_store_canonical_json(p_value -> member);
        first := false;
      end loop;
      return result || '}';
    when 'array' then
      return '[' || coalesce((
        select pg_catalog.string_agg(
          pg_temp.application_store_canonical_json(item.value), ',' order by item.ordinality
        )
        from pg_catalog.jsonb_array_elements(p_value) with ordinality as item(value, ordinality)
      ), '') || ']';
    when 'string' then
      return pg_catalog.to_json(p_value #>> '{}')::text;
    else
      return p_value::text;
  end case;
end
$function$;

create function pg_temp.application_store_fingerprint(p_value jsonb)
returns text
language sql
immutable
set search_path = ''
as $function$
  select 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(pg_temp.application_store_canonical_json(p_value), 'UTF8')
    ),
    'hex'
  )
$function$;

-- The one value this change retires, at any depth: the projection a record type reads.
create function pg_temp.application_store_source(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  rewritten jsonb;
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      select pg_catalog.jsonb_object_agg(
        member.key, pg_temp.application_store_source(member.value)
      ) into rewritten
      from pg_catalog.jsonb_each(p_value) as member(key, value);
      return coalesce(rewritten, '{}'::jsonb);
    when 'array' then
      select pg_catalog.jsonb_agg(
        pg_temp.application_store_source(item.value) order by item.ordinality
      ) into rewritten
      from pg_catalog.jsonb_array_elements(p_value) with ordinality as item(value, ordinality);
      return coalesce(rewritten, '[]'::jsonb);
    when 'string' then
      return case when p_value #>> '{}' = 'installed_applications'
        then '"application_store_entries"'::jsonb else p_value end;
    else
      return p_value;
  end case;
end
$function$;

do $convert$
declare
  stored record;
  converted jsonb;
begin
  for stored in
    select d.root_id, r.key, d.draft_source as source, d.source_fingerprint as fingerprint
    from vortex_definition.drafts as d
    join vortex_definition.roots as r on r.root_id = d.root_id
  loop
    if pg_temp.application_store_fingerprint(stored.source) is distinct from stored.fingerprint then
      raise exception 'The application read rewrite cannot verify the stored fingerprint of draft % (%)',
        stored.key, stored.root_id;
    end if;
  end loop;
  for stored in
    select release.root_id, root.key, release.release_revision, release.authored_source as source,
      release.authored_source_fingerprint as fingerprint
    from vortex_definition.releases as release
    join vortex_definition.roots as root on root.root_id = release.root_id
  loop
    if pg_temp.application_store_fingerprint(stored.source) is distinct from stored.fingerprint then
      raise exception 'The application read rewrite cannot verify the stored fingerprint of release % (%) revision %',
        stored.key, stored.root_id, stored.release_revision;
    end if;
  end loop;
  for stored in
    select d.root_id, d.draft_source
    from vortex_definition.drafts as d
    where d.draft_source::text like '%"installed_applications"%'
    order by d.root_id
  loop
    converted := pg_temp.application_store_source(stored.draft_source);
    update vortex_definition.drafts as d set
      draft_source = converted,
      source_fingerprint = pg_temp.application_store_fingerprint(converted),
      draft_revision = d.draft_revision + 1,
      updated_at = greatest(pg_catalog.statement_timestamp(), d.updated_at),
      restored_from_release_revision = null,
      restored_from_source_fingerprint = null,
      restored_by = null, restored_at = null, restore_correlation_id = null
    where d.root_id = stored.root_id;
  end loop;
end
$convert$;

alter table vortex_definition.releases disable trigger releases_append_only;

do $convert$
declare
  stored record;
  converted jsonb;
begin
  for stored in
    select release.root_id, release.release_revision, release.authored_source
    from vortex_definition.releases as release
    where release.authored_source::text like '%"installed_applications"%'
    order by release.root_id, release.release_revision
  loop
    converted := pg_temp.application_store_source(stored.authored_source);
    update vortex_definition.releases as release set
      authored_source = converted,
      authored_source_fingerprint = pg_temp.application_store_fingerprint(converted)
    where release.root_id = stored.root_id
      and release.release_revision = stored.release_revision;
  end loop;
end
$convert$;

alter table vortex_definition.releases enable trigger releases_append_only;

drop function pg_temp.application_store_source(jsonb);
drop function pg_temp.application_store_fingerprint(jsonb);
drop function pg_temp.application_store_canonical_json(jsonb);

-- The retired installed-applications read: its storage contracts move to the one applications
-- read (their installed views read it, and their record type definitions name it), then its
-- function, its registration and the record adapter's access to it go. No definition names the
-- key any more, and an installation that has not upgraded yet keeps reading its applications.
do $migration$
declare
  projection_view record;
  view_definition text;
begin
  for projection_view in
    select physical_table_token
    from vortex_record.storage_catalogue
    where protected_read_model_key = 'installed_applications'
  loop
    -- A lane installed after the one system-projection read path has no per-contract view; only
    -- an installation that still carries one is rewritten.
    if pg_catalog.to_regclass(
      pg_catalog.format('record_data.%I', projection_view.physical_table_token)
    ) is null then
      continue;
    end if;
    select pg_catalog.pg_get_viewdef(
      pg_catalog.to_regclass(
        pg_catalog.format('record_data.%I', projection_view.physical_table_token)
      ),
      true
    ) into view_definition;
    if view_definition is null
      or pg_catalog.strpos(
        view_definition, 'vortex_access.list_installed_applications_projection'
      ) = 0 then
      raise exception 'Installed projection view % does not use the expected reader',
        projection_view.physical_table_token;
    end if;
    execute pg_catalog.format(
      'create or replace view record_data.%I as %s',
      projection_view.physical_table_token,
      pg_catalog.replace(
        view_definition,
        'vortex_access.list_installed_applications_projection',
        'vortex_access.list_application_store_entries_projection'
      )
    );
  end loop;
end
$migration$;

update vortex_record.storage_catalogue
set protected_read_model_key = 'application_store_entries',
  record_type_definition = pg_catalog.jsonb_set(
    record_type_definition,
    '{systemProjection,protectedView}',
    '"application_store_entries"'::jsonb
  ),
  changed_at = pg_catalog.statement_timestamp()
where protected_read_model_key = 'installed_applications';

-- A protected read model's registration names the sort keys its reader pages by. The one
-- applications read pages by name and by the installed revision, which the retired read's
-- registration never had to say because its reader was the only one that listed applications.
update vortex_record.protected_read_model_views
set cursor_sort_keys = array['record_id', 'key', 'name', 'release_revision']::text[]
where protected_read_model_key = 'application_store_entries';

drop function if exists vortex_access.list_installed_applications_projection(
  uuid[], text, text, jsonb, integer, jsonb
);

delete from vortex_record.protected_read_model_views
where protected_read_model_key = 'installed_applications';

alter table vortex_record.protected_read_model_views
  drop constraint protected_read_model_views_protected_read_model_key_check;
alter table vortex_record.protected_read_model_views
  add constraint protected_read_model_views_protected_read_model_key_check
  check (protected_read_model_key = any (array[
    'people', 'organization_accounts', 'roles', 'groups', 'effective_assignments',
    'tenant_structure', 'organization_invitations', 'organization_runtime_settings',
    'permissions', 'role_activations', 'delegations', 'tenants',
    'tenant_administrators', 'application_role_templates', 'activity_entry',
    'application_store_entries', 'connection_instances'
  ]));

alter table vortex_record.storage_catalogue
  drop constraint storage_catalogue_protected_read_model_key_check;
alter table vortex_record.storage_catalogue
  add constraint storage_catalogue_protected_read_model_key_check
  check (
    (physical_schema_token = 'system_projection') = (protected_read_model_key is not null)
    and (protected_read_model_key is null or protected_read_model_key = any (array[
    'people', 'organization_accounts', 'roles', 'groups', 'effective_assignments',
    'tenant_structure', 'organization_invitations', 'organization_runtime_settings',
    'permissions', 'delegations', 'tenants',
    'tenant_administrators', 'application_role_templates', 'activity_entry',
    'application_store_entries', 'connection_instances'
    ]))
  );

reset role;
