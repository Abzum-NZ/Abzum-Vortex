set local role vortex_owner;

alter table vortex_definition.installation_bindings drop constraint installation_bindings_state_check;
update vortex_definition.installation_bindings set state = 'active', binding_revision = binding_revision + 1 where state = 'draining';
alter table vortex_definition.installation_bindings add constraint installation_bindings_state_check check (state = any (array['provisioned'::text, 'active'::text, 'detached'::text]));
drop function vortex_definition.drain_installation(uuid, uuid, bigint, jsonb);

create or replace function vortex_definition.append_application_installation_activity_internal(
  p_activity_id uuid,
  p_application_root_id uuid,
  p_action text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action is null
    or p_action not in (
      'activate_application_installation', 'withdraw_application_installation'
    ) then
    raise exception using errcode = '22023',
      message = 'Application installation Activity input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  append_result := vortex_record.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id,
    pg_catalog.statement_timestamp(),
    'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    p_action,
    array[p_application_root_id]::uuid[],
    array[]::uuid[],
    vortex_platform.channel(),
    (context_value ->> 'correlationId')::uuid,
    'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Application installation Activity is stale';
  end if;
end
$function$;

revoke all on function vortex_definition.append_application_installation_activity_internal(
  uuid, uuid, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.append_application_installation_activity_internal(
  uuid, uuid, text
) to vortex_owner;

comment on function vortex_definition.append_application_installation_activity_internal(
  uuid, uuid, text
) is
  'Private content-free Activity composer for one protected Application installation lifecycle change.';

alter function vortex_definition.append_application_installation_activity_internal(p_activity_id uuid, p_application_root_id uuid, p_action text) owner to vortex_owner;

create or replace function vortex_definition.provision_module_installation_storage(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_module_root_id uuid,
  p_module_release_revision bigint,
  p_expected_binding_revision bigint
)
returns table (
  state text,
  changed boolean,
  binding_revision bigint,
  application_root_id uuid,
  application_release_revision bigint,
  module_root_id uuid,
  module_release_revision bigint,
  storage_contract_ids uuid[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  permission_decision record;
  delegation_decision record;
  checked_context jsonb;
  application_release vortex_definition.releases%rowtype;
  stored_binding vortex_definition.installation_bindings%rowtype;
  provision record;
  next_binding_revision bigint;
  binding_exists boolean;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991
    or p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_module_release_revision not between 1 and 9007199254740991
    or (p_expected_binding_revision is not null
      and p_expected_binding_revision not between 1 and 9007199254740991) then
    raise exception using errcode = '22023', message = 'Module installation storage command is invalid';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission',
        vortex_access.required_platform_permission('platform.organization.applications.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501', message = 'Module installation authority is unavailable';
  end if;

  select evaluated.* into strict delegation_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install_scope',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission',
        vortex_access.required_platform_permission('platform.organization.applications.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    )
  ) as evaluated;
  if delegation_decision.outcome is distinct from 'eligible'
    or delegation_decision.organization_id <> permission_decision.organization_id
    or delegation_decision.organization_account_id <> permission_decision.organization_account_id
    or delegation_decision.access_version <> permission_decision.access_version
    or delegation_decision.correlation_id <> permission_decision.correlation_id then
    raise exception using errcode = '42501', message = 'Module installation delegation is unavailable';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '40001', message = 'Module installation context changed';
  end if;

  -- The binding identity is locked before its row can exist. Storage lineage
  -- locks are acquired later by the Record helper in canonical UUID order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_definition.binding:' || permission_decision.organization_id::text || ':' ||
        p_application_root_id::text || ':' || p_module_root_id::text,
      0
    )
  );

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_application_root_id
    and release.release_revision = p_application_release_revision
    and root.kind = 'application'
    and root.organization_id = permission_decision.organization_id;
  if application_release.validation_contract_version <> all (vortex_definition.accepted_contract_version('application'))
    or application_release.compilation_output #>> '{kind}' <> 'application'
    or application_release.compilation_output #>> '{canonical,envelope,rootId}'
      <> p_application_root_id::text
    or application_release.compilation_output #>> '{validationContractVersion}' <> all (vortex_definition.accepted_contract_version('application')) then
    raise exception using errcode = '23514', message = 'Exact Application release is unavailable';
  end if;
  if not exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as edge
    where edge.target_root_id = p_module_root_id
      and edge.target_release_revision = p_module_release_revision
  ) then
    raise exception using errcode = '23514', message = 'Exact application Module binding is unavailable';
  end if;

  select binding.* into stored_binding
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = permission_decision.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = p_module_root_id
  for update;
  binding_exists := found;

  if binding_exists then
    if stored_binding.state = 'active'
      or (
        p_expected_binding_revision is null
        and (
          stored_binding.application_release_revision <> p_application_release_revision
          or stored_binding.module_release_revision <> p_module_release_revision
          or stored_binding.state <> 'provisioned'
        )
      )
      or (
        p_expected_binding_revision is not null
        and stored_binding.binding_revision <> p_expected_binding_revision
      ) then
      raise exception using errcode = '40001', message = 'Module installation binding changed';
    end if;
  end if;
  if not binding_exists and p_expected_binding_revision is not null then
    raise exception using errcode = '40001', message = 'Module installation binding is unavailable';
  end if;

  select storage.* into strict provision
  from vortex_record.provision_exact_module_storage(
    p_module_root_id, p_module_release_revision
  ) as storage;

  if binding_exists
    and stored_binding.application_release_revision = p_application_release_revision
    and stored_binding.module_release_revision = p_module_release_revision
    and stored_binding.state = 'provisioned' then
    if stored_binding.storage_contract_ids <> provision.storage_contract_ids then
      raise exception using errcode = '55000', message = 'Stored Module installation evidence is incompatible';
    end if;
    return query select stored_binding.state, false, stored_binding.binding_revision,
      stored_binding.application_root_id, stored_binding.application_release_revision,
      stored_binding.module_root_id, stored_binding.module_release_revision,
      stored_binding.storage_contract_ids;
    return;
  end if;

  if binding_exists then
    if stored_binding.binding_revision = 9007199254740991 then
      raise exception using errcode = '22003', message = 'Module installation binding revision is exhausted';
    end if;
    next_binding_revision := stored_binding.binding_revision + 1;
    update vortex_definition.installation_bindings as binding
    set binding_revision = next_binding_revision,
        application_release_revision = p_application_release_revision,
        module_release_revision = p_module_release_revision,
        state = 'provisioned',
        storage_contract_ids = provision.storage_contract_ids,
        changed_at = pg_catalog.statement_timestamp()
    where binding.organization_id = permission_decision.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = p_module_root_id
      and binding.binding_revision = p_expected_binding_revision;
    if not found then
      raise exception using errcode = '40001', message = 'Module installation binding changed';
    end if;
  else
    next_binding_revision := 1;
    insert into vortex_definition.installation_bindings (
      organization_id, application_root_id, module_root_id, binding_revision,
      application_release_revision, module_release_revision, state,
      storage_contract_ids
    ) values (
      permission_decision.organization_id, p_application_root_id, p_module_root_id, 1,
      p_application_release_revision, p_module_release_revision, 'provisioned',
      provision.storage_contract_ids
    );
  end if;

  return query select 'provisioned'::text, true, next_binding_revision,
    p_application_root_id, p_application_release_revision, p_module_root_id,
    p_module_release_revision, provision.storage_contract_ids;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Module installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module installation evidence is ambiguous';
end
$function$;

alter function vortex_definition.provision_module_installation_storage(uuid,bigint,uuid,bigint,bigint) owner to vortex_owner;

revoke all on function vortex_definition.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) to vortex_request;
comment on function vortex_definition.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) is 'Protected exact-release storage provisioning; commits only an inactive Module binding.';

create or replace function vortex_definition.read_owned_module_publication(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  publication jsonb;
  invalid_field_key boolean;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
  if p_application_root_id is null or not exists (
    select 1 from vortex_definition.roots as root
    where root.root_id = p_application_root_id and root.kind = 'application'
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
  ) then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  -- A broken current-release pointer is a storage defect, never an empty publication.
  if exists (
    select 1 from vortex_definition.roots as root
    left join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = root.current_release_revision
    where root.owner_application_root_id = p_application_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'module' and root.current_release_revision is not null
      and (release.root_id is null
        or pg_catalog.jsonb_typeof(release.compilation_output #> '{canonical,content,recordTypes}') is distinct from 'array')
  ) then
    raise exception using errcode = '23514', message = 'Owned Module publication is inconsistent';
  end if;

  if exists (
    select 1 from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,recordTypes}'
    ) as record(value)
    where root.owner_application_root_id = p_application_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'module'
      and (pg_catalog.jsonb_typeof(record.value -> 'key') is distinct from 'string'
        or pg_catalog.length(record.value ->> 'key') not between 1 and 40
        or (record.value ->> 'key') !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
        or pg_catalog.jsonb_typeof(record.value -> 'fields') is distinct from 'array')
  ) then
    raise exception using errcode = '23514', message = 'Owned Module publication record is inconsistent';
  end if;

  -- Storage remains published even when a later release removes it. Preview plans
  -- live on preview_installations, so only real publications contribute here.
  with records as materialized (
    select root.key as module_key, record.value as record, record.ordinality
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,recordTypes}'
    ) with ordinality as record(value, ordinality)
    where root.owner_application_root_id = p_application_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'module'
  ), fields as materialized (
    select module_key, record ->> 'key' as record_key,
      records.ordinality as record_ordinality, field.value, field.ordinality
    from records cross join lateral pg_catalog.jsonb_array_elements(record -> 'fields')
      with ordinality as field(value, ordinality)
  )
  select pg_catalog.jsonb_build_object(
    'recordTypes', coalesce((select pg_catalog.jsonb_agg(qualified_key order by qualified_key collate "C")
      from (select distinct module_key || ':' || (record ->> 'key') as qualified_key from records) as names
    ), '[]'::jsonb),
    'fields', coalesce((select pg_catalog.jsonb_agg(qualified_key order by qualified_key collate "C")
      from (select distinct module_key || ':' || record_key || '.' || (value ->> 'key') as qualified_key from fields) as names
    ), '[]'::jsonb)
  ), exists (
    select 1 from fields
    where pg_catalog.jsonb_typeof(value -> 'key') is distinct from 'string'
      or pg_catalog.length(value ->> 'key') not between 1 and 40
      or (value ->> 'key') !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
  ) into publication, invalid_field_key;
  if invalid_field_key then
    raise exception using errcode = '23514', message = 'Owned Module publication field is inconsistent';
  end if;

  -- Only actual contribution targets count. A dependency on the owner alone is not a use.
  -- Include current published contributors and older releases still bound to an installation.
  with owned_points as (
    select distinct root.root_id, root.key as module_key,
      point.value ->> 'extensionPointId' as point_id, point.value ->> 'key' as point_key
    from vortex_definition.roots as root
    join vortex_definition.releases as release on release.root_id = root.root_id
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,extensionPoints}'
    ) as point(value)
    where root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.owner_application_root_id = p_application_root_id and root.kind = 'module'
  ), contributor_releases as (
    select root.root_id, root.current_release_revision as release_revision
    from vortex_definition.roots as root
    where root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'module' and root.current_release_revision is not null
    union
    select binding.module_root_id, binding.module_release_revision
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = (checked_context ->> 'organizationId')::uuid
      and binding.state in ('provisioned', 'active')
  ), uses as (
    select distinct point.module_key, point.point_key,
      contribution.value ->> 'kind' as kind,
      release.compilation_output #>> '{canonical,content,name}' as contributor_name
    from contributor_releases as contributor
    join vortex_definition.releases as release
      on release.root_id = contributor.root_id and release.release_revision = contributor.release_revision
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,contributions}'
    ) as contribution(value)
    join owned_points as point
      on point.root_id::text = contribution.value #>> '{targetModule,moduleRootId}'
      and point.point_id = contribution.value ->> 'targetExtensionPointId'
  )
  select publication || pg_catalog.jsonb_build_object('extensionPointUses', coalesce(
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleKey', module_key, 'extensionPointKey', point_key,
      'kind', kind, 'contributorName', contributor_name
    ) order by module_key collate "C", point_key collate "C", contributor_name collate "C", kind collate "C"),
    '[]'::jsonb
  )) into publication from uses;
  return publication;
end
$function$;

revoke all on function vortex_definition.read_owned_module_publication(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_owned_module_publication(uuid) to vortex_request;
alter function vortex_definition.read_owned_module_publication(uuid) owner to vortex_owner;

create or replace function vortex_definition.remove_installation_runtime_bundles_internal(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  bundle_list jsonb;
  bundles_removed bigint;
  bundle_parts_removed bigint;
  access_plans_removed bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Runtime bundle uninstall command is invalid';
  end if;

  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;

  if not exists (
    select 1
    from vortex_definition.roots as root
    where root.root_id = p_application_root_id
      and root.organization_id = authority.organization_id
      and root.kind = 'application'
  ) then
    raise exception using errcode = 'P0002',
      message = 'Application installation is unavailable';
  end if;

  perform 1
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = authority.organization_id
    and binding.application_root_id = p_application_root_id
  order by binding.module_root_id
  for update;

  if exists (
    select 1
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.state = 'active'
  ) then
    raise exception using errcode = '40001',
      message = 'Runtime bundles cannot be removed while the installation is active';
  end if;

  delete from vortex_definition.installation_runtime_bundle_parts as part
  where part.organization_id = authority.organization_id
    and part.application_root_id = p_application_root_id;
  get diagnostics bundle_parts_removed = row_count;

  with removed_bundles as (
    delete from vortex_definition.installation_runtime_bundles as bundle
    where bundle.organization_id = authority.organization_id
      and bundle.application_root_id = p_application_root_id
    returning bundle.application_release_revision, bundle.bundle_format_version
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'applicationReleaseRevision', removed.application_release_revision,
          'bundleFormatVersion', removed.bundle_format_version
        ) order by removed.application_release_revision, removed.bundle_format_version
      ),
      '[]'::jsonb
    ),
    pg_catalog.count(*)
  into bundle_list, bundles_removed
  from removed_bundles as removed;

  delete from vortex_record.installation_access_plans as plan
  where plan.organization_id = authority.organization_id
    and plan.application_root_id = p_application_root_id;
  get diagnostics access_plans_removed = row_count;

  return pg_catalog.jsonb_build_object(
    'bundles', bundle_list,
    'bundlePartsRemoved', bundle_parts_removed,
    'accessPlansRemoved', access_plans_removed
  );
end
$function$;
alter function vortex_definition.remove_installation_runtime_bundles_internal(uuid) owner to vortex_owner;


alter function vortex_definition.remove_installation_runtime_bundles_internal(uuid)
  owner to vortex_owner;
revoke all on function vortex_definition.remove_installation_runtime_bundles_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.remove_installation_runtime_bundles_internal(uuid)
  to vortex_request;
comment on function vortex_definition.remove_installation_runtime_bundles_internal(uuid) is
  'Lists and removes all runtime bundle registrations and access plans for one authorised installation after its bindings are detached.';

create or replace function vortex_definition.remove_abandoned_runtime_bundles_internal(
  p_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  abandoned_bundle_ttl constant interval := interval '7 days';
  maximum_batch_size constant integer := 100;
  candidate_key record;
  bundle_row vortex_definition.installation_runtime_bundles%rowtype;
  removed_bundle_keys jsonb := '[]'::jsonb;
  bundles_removed bigint := 0;
  bundle_parts_removed bigint := 0;
  access_plans_removed bigint := 0;
  orphaned_access_plans_removed bigint := 0;
  changed_rows bigint;
begin
  if p_limit is null or p_limit < 1 or p_limit > maximum_batch_size then
    raise exception using errcode = '22023',
      message = 'Runtime bundle cleanup batch is invalid';
  end if;

  for candidate_key in
    select bundle.organization_id, bundle.application_root_id,
      bundle.application_release_revision, bundle.bundle_format_version
    from vortex_definition.installation_runtime_bundles as bundle
    where not exists (
      select 1
      from vortex_definition.installation_bindings as binding
      where binding.organization_id = bundle.organization_id
        and binding.application_root_id = bundle.application_root_id
        and binding.application_release_revision = bundle.application_release_revision
        and binding.state = 'active'
    )
      and (
        exists (
          select 1
          from vortex_definition.installation_bindings as later_binding
          where later_binding.organization_id = bundle.organization_id
            and later_binding.application_root_id = bundle.application_root_id
            and later_binding.application_release_revision > bundle.application_release_revision
            and later_binding.state = 'active'
        )
        or (
          bundle.built_at <= pg_catalog.statement_timestamp() - abandoned_bundle_ttl
          and not exists (
            select 1
            from vortex_definition.installation_bindings as previous_binding
            where previous_binding.organization_id = bundle.organization_id
              and previous_binding.application_root_id = bundle.application_root_id
              and previous_binding.application_release_revision = bundle.application_release_revision
              and previous_binding.state = 'detached'
          )
        )
      )
    order by bundle.built_at, bundle.organization_id, bundle.application_root_id,
      bundle.application_release_revision, bundle.bundle_format_version
    limit p_limit
  loop
    perform 1
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = candidate_key.organization_id
      and binding.application_root_id = candidate_key.application_root_id
    order by binding.module_root_id
    for update;

    select bundle.* into bundle_row
    from vortex_definition.installation_runtime_bundles as bundle
    where bundle.organization_id = candidate_key.organization_id
      and bundle.application_root_id = candidate_key.application_root_id
      and bundle.application_release_revision = candidate_key.application_release_revision
      and bundle.bundle_format_version = candidate_key.bundle_format_version
    for update of bundle skip locked;
    if not found then
      continue;
    end if;

    if exists (
      select 1
      from vortex_definition.installation_bindings as binding
      where binding.organization_id = bundle_row.organization_id
        and binding.application_root_id = bundle_row.application_root_id
        and binding.application_release_revision = bundle_row.application_release_revision
          and binding.state = 'active'
    ) then
      continue;
    end if;

    if not exists (
        select 1
        from vortex_definition.installation_bindings as later_binding
        where later_binding.organization_id = bundle_row.organization_id
          and later_binding.application_root_id = bundle_row.application_root_id
          and later_binding.application_release_revision > bundle_row.application_release_revision
            and later_binding.state = 'active'
      ) and (
        bundle_row.built_at > pg_catalog.statement_timestamp() - abandoned_bundle_ttl
        or exists (
          select 1
          from vortex_definition.installation_bindings as previous_binding
          where previous_binding.organization_id = bundle_row.organization_id
            and previous_binding.application_root_id = bundle_row.application_root_id
            and previous_binding.application_release_revision = bundle_row.application_release_revision
            and previous_binding.state = 'detached'
        )
      ) then
      continue;
    end if;

    delete from vortex_definition.installation_runtime_bundle_parts as part
    where part.organization_id = bundle_row.organization_id
      and part.application_root_id = bundle_row.application_root_id
      and part.application_release_revision = bundle_row.application_release_revision
      and part.bundle_format_version = bundle_row.bundle_format_version;
    get diagnostics changed_rows = row_count;
    bundle_parts_removed := bundle_parts_removed + changed_rows;

    delete from vortex_definition.installation_runtime_bundles as bundle
    where bundle.organization_id = bundle_row.organization_id
      and bundle.application_root_id = bundle_row.application_root_id
      and bundle.application_release_revision = bundle_row.application_release_revision
      and bundle.bundle_format_version = bundle_row.bundle_format_version;
    get diagnostics changed_rows = row_count;
    if changed_rows = 1 then
      bundles_removed := bundles_removed + 1;
      removed_bundle_keys := removed_bundle_keys || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'organizationId', bundle_row.organization_id,
          'applicationRootId', bundle_row.application_root_id,
          'applicationReleaseRevision', bundle_row.application_release_revision
        )
      );
    end if;
  end loop;

  delete from vortex_record.installation_access_plans as plan
  where plan.plan_key in (
    select candidate.plan_key
    from vortex_record.installation_access_plans as candidate
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements(removed_bundle_keys) as removed(bundle_key)
      where (removed.bundle_key ->> 'organizationId')::uuid = candidate.organization_id
        and (removed.bundle_key ->> 'applicationRootId')::uuid = candidate.application_root_id
        and (removed.bundle_key ->> 'applicationReleaseRevision')::bigint =
          candidate.application_release_revision
    )
      and not exists (
        select 1
        from vortex_definition.installation_runtime_bundles as remaining
        where remaining.organization_id = candidate.organization_id
          and remaining.application_root_id = candidate.application_root_id
          and remaining.application_release_revision = candidate.application_release_revision
      )
      and not exists (
        select 1
        from vortex_definition.installation_bindings as binding
        where binding.organization_id = candidate.organization_id
          and binding.application_root_id = candidate.application_root_id
          and binding.application_release_revision = candidate.application_release_revision
          and binding.state = 'active'
      )
    order by candidate.plan_key
    limit p_limit
  );
  get diagnostics changed_rows = row_count;
  access_plans_removed := access_plans_removed + changed_rows;

  delete from vortex_record.installation_access_plans as plan
  where plan.plan_key in (
    select candidate.plan_key
    from vortex_record.installation_access_plans as candidate
    where candidate.created_at <= pg_catalog.statement_timestamp() - abandoned_bundle_ttl
      and not exists (
        select 1
        from vortex_definition.installation_runtime_bundles as bundle
        where bundle.organization_id = candidate.organization_id
          and bundle.application_root_id = candidate.application_root_id
          and bundle.application_release_revision = candidate.application_release_revision
      )
      and not exists (
        select 1
        from vortex_definition.installation_bindings as binding
        where binding.organization_id = candidate.organization_id
          and binding.application_root_id = candidate.application_root_id
          and binding.application_release_revision = candidate.application_release_revision
          and binding.state = 'active'
      )
    order by candidate.plan_key
    limit p_limit
  );
  get diagnostics changed_rows = row_count;
  orphaned_access_plans_removed := changed_rows;

  return pg_catalog.jsonb_build_object(
    'bundlesRemoved', bundles_removed,
    'bundlePartsRemoved', bundle_parts_removed,
    'accessPlansRemoved', access_plans_removed,
    'orphanedAccessPlansRemoved', orphaned_access_plans_removed
  );
end
$function$;
alter function vortex_definition.remove_abandoned_runtime_bundles_internal(integer) owner to vortex_owner;


alter function vortex_definition.remove_abandoned_runtime_bundles_internal(integer)
  owner to vortex_owner;
revoke all on function vortex_definition.remove_abandoned_runtime_bundles_internal(integer)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.remove_abandoned_runtime_bundles_internal(integer)
  to vortex_runtime;
comment on function vortex_definition.remove_abandoned_runtime_bundles_internal(integer) is
  'Removes one bounded batch of expired never-activated or superseded runtime bundles and orphaned access plans.';

reset role;
