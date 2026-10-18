create or replace function vortex_definition.write_preview_shape_internal(
  p_preview_installation_id uuid,
  p_evolve boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_row vortex_definition.preview_installations%rowtype;
  module_pin record;
  owned_release record;
  application_content_value jsonb;
  system_projection_ids_value uuid[] := array[]::uuid[];
  resolved_modules_value jsonb := '[]'::jsonb;
  storage_identities_value jsonb := '[]'::jsonb;
  declared_permissions_value jsonb := '[]'::jsonb;
begin
  select preview.* into strict preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
  for no key update;

  -- The exact Module pins of the previewed Application release, through every Module dependency,
  -- each read from this preview's rehearsed releases first and the stored releases otherwise.
  for module_pin in
    with recursive edges as (
      select dependency.root_id, dependency.release_revision,
        dependency.target_root_id, dependency.target_release_revision
      from vortex_definition.release_dependencies as dependency
      where dependency.dependency_kind = 'module'
        and not exists (
          select 1 from vortex_definition.preview_releases as preview
          where preview.preview_installation_id = p_preview_installation_id
            and preview.root_id = dependency.root_id
            and preview.release_revision = dependency.release_revision
        )
      union all
      select preview.root_id, preview.release_revision,
        (dependency.value ->> 'target_root_id')::uuid,
        (dependency.value ->> 'target_release_revision')::bigint
      from vortex_definition.preview_releases as preview
      cross join lateral pg_catalog.jsonb_array_elements(preview.dependencies) as dependency(value)
      where preview.preview_installation_id = p_preview_installation_id
        and dependency.value ->> 'dependency_kind' = 'module'
    ), closure(module_root_id, module_release_revision) as (
      select edge.target_root_id, edge.target_release_revision
      from edges as edge
      where edge.root_id = preview_row.application_root_id
        and edge.release_revision = preview_row.application_release_revision
      union
      select edge.target_root_id, edge.target_release_revision
      from closure
      join edges as edge
        on edge.root_id = closure.module_root_id
        and edge.release_revision = closure.module_release_revision
    )
    select closure.module_root_id, closure.module_release_revision,
      coalesce(
        (select preview.release ->> 'release_version'
          from vortex_definition.preview_releases as preview
          where preview.preview_installation_id = p_preview_installation_id
            and preview.root_id = closure.module_root_id
            and preview.release_revision = closure.module_release_revision),
        (select release.release_version
          from vortex_definition.releases as release
          join vortex_definition.roots as root on root.root_id = release.root_id
          where release.root_id = closure.module_root_id
            and release.release_revision = closure.module_release_revision
            and root.kind = 'module'
            and root.organization_id = preview_row.organization_id)
      ) as release_version
    from closure
    order by closure.module_root_id, closure.module_release_revision
  loop
    if module_pin.module_root_id is null
      or module_pin.module_release_revision not between 1 and 9007199254740991
      or module_pin.release_version is null
      or resolved_modules_value @> pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('moduleRootId', module_pin.module_root_id)
      ) then
      raise exception using errcode = '23514',
        message = 'Preview Module pins are unavailable or ambiguous';
    end if;
    resolved_modules_value := resolved_modules_value || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', module_pin.module_root_id,
        'moduleReleaseRevision', module_pin.module_release_revision,
        'releaseVersion', module_pin.release_version
      )
    );
    -- An unchanged immutable Module pin already serves this exact validated release. Carry its
    -- storage identities forward without visiting or locking unrelated record types/fields.
    -- Draft-produced Module rows still go through the definition comparison below.
    if p_evolve and preview_row.resolved_modules @> pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('moduleRootId', module_pin.module_root_id,
        'moduleReleaseRevision', module_pin.module_release_revision)
    ) and not exists (
      select 1 from vortex_definition.preview_releases as release
      where release.preview_installation_id = p_preview_installation_id
        and release.root_id = module_pin.module_root_id
        and release.release_revision = module_pin.module_release_revision
    ) then
      storage_identities_value := storage_identities_value || (
        select coalesce(pg_catalog.jsonb_agg(identity.value), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(preview_row.storage_identities) as identity(value)
        where (identity.value ->> 'moduleRootId')::uuid = module_pin.module_root_id
          and (identity.value ->> 'moduleReleaseRevision')::bigint = module_pin.module_release_revision
      );
    else
    storage_identities_value := storage_identities_value || case when p_evolve
      then vortex_record.evolve_preview_module_storage(
        p_preview_installation_id, module_pin.module_root_id, module_pin.module_release_revision
      )
      else vortex_record.provision_preview_module_storage(
        p_preview_installation_id, module_pin.module_root_id, module_pin.module_release_revision
      )
    end;
    end if;
  end loop;
  if pg_catalog.jsonb_array_length(resolved_modules_value) = 0 then
    raise exception using errcode = '23514', message = 'Previewed Application binds no Module';
  end if;

  -- The preview's own permission registration: what the previewed Application and its own
  -- Modules declare, at the releases the preview runs, and the draft's roles, which only the
  -- builder who opened the preview holds. A used Module's permissions are not part of it.
  insert into vortex_access.preview_permission_registrations (
    preview_installation_id, organization_id, application_root_id, organization_account_id,
    system_projection_record_type_ids, owned_owner_ids, role_ids
  )
  select p_preview_installation_id, preview_row.organization_id, preview_row.application_root_id,
    preview_row.previewer_organization_account_id,
    array[]::uuid[],
    pg_catalog.array_append(
      coalesce(pg_catalog.array_agg(owned.module_root_id order by owned.module_root_id), array[]::uuid[]),
      preview_row.application_root_id
    ),
    array[]::uuid[]
  from (
    select (pin.value ->> 'moduleRootId')::uuid as module_root_id
    from pg_catalog.jsonb_array_elements(resolved_modules_value) as pin(value)
    join vortex_definition.roots as root
      on root.root_id = (pin.value ->> 'moduleRootId')::uuid
    where root.organization_id = preview_row.organization_id
      and root.kind = 'module'
      and root.owner_application_root_id = preview_row.application_root_id
  ) as owned
  on conflict (preview_installation_id) do update
  set owned_owner_ids = excluded.owned_owner_ids
  where preview_permission_registrations.owned_owner_ids is distinct from excluded.owned_owner_ids;

  for owned_release in
    select pinned.root_id, root.key, pinned.owner_kind,
      coalesce(preview.release, pg_catalog.to_jsonb(stored.*)) as release
    from (
      select preview_row.application_root_id as root_id,
        preview_row.application_release_revision as release_revision,
        'application'::text as owner_kind
      union all
      select (pin.value ->> 'moduleRootId')::uuid, (pin.value ->> 'moduleReleaseRevision')::bigint,
        'module'
      from pg_catalog.jsonb_array_elements(resolved_modules_value) as pin(value)
    ) as pinned
    join vortex_definition.roots as root
      on root.root_id = pinned.root_id
      and root.organization_id = preview_row.organization_id
      and root.kind = pinned.owner_kind
      and (root.root_id = preview_row.application_root_id
        or root.owner_application_root_id = preview_row.application_root_id)
    left join vortex_definition.preview_releases as preview
      on preview.preview_installation_id = p_preview_installation_id
      and preview.root_id = pinned.root_id
      and preview.release_revision = pinned.release_revision
    left join vortex_definition.releases as stored
      on preview.root_id is null
      and stored.root_id = pinned.root_id
      and stored.release_revision = pinned.release_revision
    order by pinned.owner_kind, pinned.root_id
  loop
    if owned_release.release is null
      or pg_catalog.jsonb_typeof(
        owned_release.release #> '{compilation_output,canonical,content,permissions}'
      ) is distinct from 'array' then
      raise exception using errcode = '23514',
        message = 'Previewed permission declarations are unavailable';
    end if;
    if owned_release.owner_kind = 'application' then
      application_content_value := owned_release.release #> '{compilation_output,canonical,content}';
    end if;
    declared_permissions_value := declared_permissions_value || (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'ownerKind', owned_release.owner_kind, 'ownerId', owned_release.root_id,
        'permissionId', permission.value ->> 'permissionId'
      )), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(
        owned_release.release #> '{compilation_output,canonical,content,permissions}'
      ) as permission(value)
    );
    insert into vortex_access.preview_permission_entries (
      preview_installation_id, entry, held
    )
    select p_preview_installation_id,
      pg_catalog.jsonb_populate_record(
        null::vortex_access.permission_catalogue_entries,
        pg_catalog.jsonb_build_object(
          'organization_id', preview_row.organization_id,
          'registration_kind', 'application',
          'registration_owner_id', preview_row.application_root_id,
          'registration_revision', 1,
          'application_root_id', preview_row.application_root_id,
          'owner_kind', owned_release.owner_kind,
          'owner_id', owned_release.root_id,
          'permission_id', permission.value ->> 'permissionId',
          'permission_key', permission.value ->> 'key',
          'label', permission.value ->> 'label',
          'description', permission.value ->> 'description',
          'record_type_id', permission.value ->> 'recordTypeId',
          'action_kind', permission.value ->> 'actionKind',
          'named_action', permission.value ->> 'namedAction',
          'administrative', permission.value -> 'administrative',
          'source_kind', owned_release.owner_kind,
          'source_definition_key', owned_release.key,
          'source_root_id', owned_release.root_id,
          'source_version', owned_release.release ->> 'release_version',
          'source_revision', owned_release.release -> 'release_revision',
          'source_validation_contract_version',
            owned_release.release ->> 'validation_contract_version',
          'meaning_fingerprint', owned_release.release ->> 'content_fingerprint',
          'record_scope', permission.value -> 'recordScope',
          'field_policy', permission.value -> 'fieldPolicy'
        )
      ),
      false
    from pg_catalog.jsonb_array_elements(
      owned_release.release #> '{compilation_output,canonical,content,permissions}'
    ) as permission(value)
    on conflict (preview_installation_id, ((entry).owner_kind), ((entry).owner_id), ((entry).permission_id))
    do update set entry = excluded.entry
    where preview_permission_entries.entry is distinct from excluded.entry;
  end loop;
  if application_content_value is null
    or pg_catalog.jsonb_typeof(application_content_value -> 'roles') is distinct from 'array' then
    raise exception using errcode = '23514',
      message = 'Previewed permission declarations are unavailable';
  end if;

  -- Remove only declarations absent from the final validated release set, including removed owners.
  delete from vortex_access.preview_permission_entries as entry
  where entry.preview_installation_id = p_preview_installation_id
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(declared_permissions_value) as declared(value)
      where declared.value ->> 'ownerKind' = (entry.entry).owner_kind
        and (declared.value ->> 'ownerId')::uuid = (entry.entry).owner_id
        and (declared.value ->> 'permissionId')::uuid = (entry.entry).permission_id
    );

  -- A system projection, of an own Module or a used one, is the platform's live read model: every
  -- permission on it is decided by the builder's own live access, never by a preview role.
  select coalesce(pg_catalog.array_agg(distinct (record_type.value ->> 'recordTypeId')::uuid order by (record_type.value ->> 'recordTypeId')::uuid), array[]::uuid[])
  into system_projection_ids_value
  from pg_catalog.jsonb_array_elements(resolved_modules_value) as pin(value)
  left join vortex_definition.preview_releases as preview
    on preview.preview_installation_id = p_preview_installation_id
    and preview.root_id = (pin.value ->> 'moduleRootId')::uuid
    and preview.release_revision = (pin.value ->> 'moduleReleaseRevision')::bigint
  left join vortex_definition.releases as stored
    on preview.root_id is null
    and stored.root_id = (pin.value ->> 'moduleRootId')::uuid
    and stored.release_revision = (pin.value ->> 'moduleReleaseRevision')::bigint
  cross join lateral pg_catalog.jsonb_array_elements(
    coalesce(
      coalesce(preview.release -> 'compilation_output', stored.compilation_output)
        #> '{canonical,content,recordTypes}',
      '[]'::jsonb
    )
  ) as record_type(value)
  where record_type.value ? 'systemProjection';
  update vortex_access.preview_permission_registrations as registration
  set system_projection_record_type_ids = system_projection_ids_value
  where registration.preview_installation_id = p_preview_installation_id
    and registration.system_projection_record_type_ids is distinct from system_projection_ids_value;

  -- The builder holds every role of the draft: a permission is held when a role selects it, an
  -- Application-wide selection taking only the Application's ordinary permissions, as it does
  -- at installation. A permission on a system projection is never held in a preview.
  with decisions as (
    select preview_entry.ctid as entry_id,
    not coalesce((preview_entry.entry).record_type_id = any(system_projection_ids_value), false)
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(application_content_value -> 'roles') as role(value)
      where role.value -> 'permissionKeys' ? (preview_entry.entry).permission_key
        and (
          role.value #>> '{permissionSelection,kind}' = 'exact'
          or (
            role.value #>> '{permissionSelection,kind}' = 'application_wildcard'
            and (preview_entry.entry).owner_kind = 'application'
            and not (preview_entry.entry).administrative
            and (preview_entry.entry).action_kind <> 'export'
          )
        )
    ) as held
    from vortex_access.preview_permission_entries as preview_entry
    where preview_entry.preview_installation_id = p_preview_installation_id
  )
  update vortex_access.preview_permission_entries as preview_entry
  set held = decisions.held
  from decisions
  where preview_entry.ctid = decisions.entry_id
    and preview_entry.held is distinct from decisions.held;
  update vortex_access.preview_permission_registrations as registration
  set role_ids = coalesce((
    select pg_catalog.array_agg(distinct (role.value ->> 'roleId')::uuid order by (role.value ->> 'roleId')::uuid)
    from pg_catalog.jsonb_array_elements(application_content_value -> 'roles') as role(value)
  ), array[]::uuid[])
  where registration.preview_installation_id = p_preview_installation_id
    and registration.role_ids is distinct from coalesce((
      select pg_catalog.array_agg(distinct (role.value ->> 'roleId')::uuid order by (role.value ->> 'roleId')::uuid)
      from pg_catalog.jsonb_array_elements(application_content_value -> 'roles') as role(value)
    ), array[]::uuid[]);

  update vortex_definition.preview_installations as preview
  set resolved_modules = resolved_modules_value,
      storage_identities = storage_identities_value
  where preview.preview_installation_id = p_preview_installation_id
    and (preview.resolved_modules is distinct from resolved_modules_value
      or preview.storage_identities is distinct from storage_identities_value);
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Preview installation is unavailable';
end
$function$;

alter function vortex_definition.write_preview_shape_internal(uuid, boolean) owner to vortex_owner;

revoke all on function vortex_definition.write_preview_shape_internal(uuid, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.write_preview_shape_internal(uuid, boolean)
  to vortex_owner;
comment on function vortex_definition.write_preview_shape_internal(uuid, boolean) is
  'Writes what a preview runs from its rehearsed releases: the exact Module pins, its isolated Record storage (new, or moved in place to the new releases keeping its records), and its own permission registration with the draft''s roles, which only its builder holds.';
