create or replace function vortex_module.create_preview_installation(
  p_application_root_id uuid,
  p_expected_draft_revision bigint,
  p_candidate jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_lifetime constant interval := interval '24 hours';
  checked_context jsonb;
  organization_id_value uuid;
  organization_account_id_value uuid;
  identity_id_value uuid;
  preview_installation_id_value uuid;
  draft_revision_value bigint;
  created_at_value timestamptz;
  expires_at_value timestamptz;
  compilation_value jsonb;
  module_dependency jsonb;
  module_release_revision bigint;
  module_root_id_value uuid;
  module_closure jsonb := '[]'::jsonb;
  resolved_modules_value jsonb := '[]'::jsonb;
  storage_identities_value jsonb := '[]'::jsonb;
  binding_count bigint;
  resolution_count bigint;
begin
  if not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_candidate is null
    or pg_catalog.jsonb_typeof(p_candidate) <> 'object'
    or pg_catalog.jsonb_typeof(p_candidate -> 'compilation') is distinct from 'object'
    or not (p_candidate ? 'currentReleaseRevision')
    or pg_catalog.jsonb_typeof(p_candidate -> 'currentReleaseRevision')
      not in ('number', 'null') then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  checked_context := vortex_module.assert_preview_installation_authority_internal();
  organization_id_value := (checked_context ->> 'organizationId')::uuid;
  organization_account_id_value := (checked_context ->> 'organizationAccountId')::uuid;
  identity_id_value := (checked_context ->> 'identityId')::uuid;
  if checked_context ->> 'applicationRootId' is distinct from p_application_root_id::text then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;

  compilation_value := p_candidate -> 'compilation';
  if compilation_value ->> 'kind' is distinct from 'application'
    or compilation_value #>> '{canonical,envelope,rootId}'
      is distinct from p_application_root_id::text then
    raise exception using errcode = '23514', message = 'Compiled Application candidate identity is invalid';
  end if;
  if pg_catalog.jsonb_typeof(
      compilation_value #> '{canonical,envelope,draftRevision}'
    ) is distinct from 'number' then
    raise exception using errcode = '23514', message = 'Compiled Application candidate revision is invalid';
  end if;
  begin
    draft_revision_value := (compilation_value #>> '{canonical,envelope,draftRevision}')::bigint;
  exception when invalid_text_representation then
    raise exception using errcode = '23514', message = 'Compiled Application candidate revision is invalid';
  end;
  if draft_revision_value <> p_expected_draft_revision
    or draft_revision_value not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(compilation_value #> '{resolvedDependencies}') <> 'array'
    or pg_catalog.jsonb_typeof(compilation_value #> '{canonical,content,moduleBindings}') <> 'array' then
    raise exception using errcode = '23514', message = 'Compiled Application candidate does not match its request';
  end if;

  select draft.draft_revision into draft_revision_value
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = p_application_root_id
    and root.organization_id = organization_id_value
    and root.kind = 'application'
  for share of draft;
  if not found or draft_revision_value <> p_expected_draft_revision then
    raise exception using errcode = '40001', message = 'Application draft revision changed';
  end if;

  select pg_catalog.count(*) into binding_count
  from pg_catalog.jsonb_array_elements(
    compilation_value #> '{canonical,content,moduleBindings}'
  ) as item(value);
  select pg_catalog.count(*) into resolution_count
  from pg_catalog.jsonb_array_elements(compilation_value -> 'resolvedDependencies') as item(value)
  where item.value ->> 'kind' = 'module';
  if binding_count <> resolution_count or exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      compilation_value #> '{canonical,content,moduleBindings}'
    ) as binding(value)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(compilation_value -> 'resolvedDependencies') as resolved(value)
      where resolved.value ->> 'kind' = 'module'
        and resolved.value ->> 'rootId' = binding.value ->> 'moduleRootId'
        and resolved.value ->> 'exactVersion' = binding.value ->> 'resolvedVersion'
    )
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'moduleRootId')
    from pg_catalog.jsonb_array_elements(
      compilation_value #> '{canonical,content,moduleBindings}'
    ) as item(value)
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'rootId')
    from pg_catalog.jsonb_array_elements(compilation_value -> 'resolvedDependencies') as item(value)
    where item.value ->> 'kind' = 'module'
  ) then
    raise exception using errcode = '23514', message = 'Compiled Application Module evidence is inconsistent';
  end if;

  perform vortex_module.expire_preview_installations(100);
  preview_installation_id_value := pg_catalog.gen_random_uuid();
  created_at_value := pg_catalog.statement_timestamp();
  expires_at_value := created_at_value + preview_lifetime;
  insert into vortex_module.preview_installations (
    preview_installation_id, organization_id, application_root_id,
    draft_revision, previewer_identity_id, previewer_organization_account_id, candidate,
    resolved_modules, storage_identities, created_at, expires_at
  ) values (
    preview_installation_id_value, organization_id_value, p_application_root_id,
    p_expected_draft_revision, identity_id_value, organization_account_id_value, p_candidate,
    '[]'::jsonb, '[]'::jsonb, created_at_value, expires_at_value
  );

  with recursive module_closure(module_root_id, release_version) as (
    select (binding.value ->> 'moduleRootId')::uuid, binding.value ->> 'resolvedVersion'
    from pg_catalog.jsonb_array_elements(
      compilation_value #> '{canonical,content,moduleBindings}'
    ) as binding(value)
    union
    select (dependency.value ->> 'moduleRootId')::uuid,
      dependency.value ->> 'resolvedVersion'
    from module_closure as parent
    join vortex_definition.releases as release
      on release.root_id = parent.module_root_id
      and release.release_version = parent.release_version
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,dependencies}'
    ) as dependency(value)
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'moduleRootId', closure.module_root_id,
        'releaseVersion', closure.release_version
      ) order by closure.module_root_id, closure.release_version
    ),
    '[]'::jsonb
  ) into module_closure
  from module_closure as closure;

  for module_dependency in
    select item.value
    from pg_catalog.jsonb_array_elements(module_closure) as item(value)
    order by item.value ->> 'moduleRootId', item.value ->> 'releaseVersion'
  loop
    begin
      module_root_id_value := (module_dependency ->> 'moduleRootId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '23514', message = 'Compiled Module identity is invalid';
    end;
    if not vortex_context.is_non_nil_uuid(module_root_id_value::text)
      or module_dependency ->> 'releaseVersion' is null then
      raise exception using errcode = '23514', message = 'Compiled Module release is invalid';
    end if;
    select release.release_revision into strict module_release_revision
    from vortex_definition.releases as release
    join vortex_definition.roots as root on root.root_id = release.root_id
    where release.root_id = module_root_id_value
      and release.release_version = module_dependency ->> 'releaseVersion'
      and root.kind = 'module';
    resolved_modules_value := resolved_modules_value || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', module_root_id_value,
        'moduleReleaseRevision', module_release_revision,
        'releaseVersion', module_dependency ->> 'releaseVersion'
      )
    );
    storage_identities_value := storage_identities_value || vortex_record.provision_preview_module_storage(
      preview_installation_id_value, module_root_id_value, module_release_revision
    );
  end loop;

  update vortex_module.preview_installations as preview
  set resolved_modules = resolved_modules_value,
      storage_identities = storage_identities_value
  where preview.preview_installation_id = preview_installation_id_value;

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', preview_installation_id_value,
    'organizationId', organization_id_value,
    'applicationRootId', p_application_root_id,
    'draftRevision', p_expected_draft_revision,
    'previewerIdentityId', identity_id_value,
    'previewerOrganizationAccountId', organization_account_id_value,
    'candidate', p_candidate,
    'resolvedModules', resolved_modules_value,
    'storageIdentities', storage_identities_value,
    'createdAt', created_at_value,
    'expiresAt', expires_at_value
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Application or Module evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Exact Application or Module evidence is ambiguous';
end
$function$;

revoke all on function vortex_module.create_preview_installation(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_module.create_preview_installation(uuid, bigint, jsonb)
  to vortex_request;
comment on function vortex_module.create_preview_installation(uuid, bigint, jsonb) is
  'Creates a 24-hour preview of one current Application draft, with fresh isolated storage for its exact published Module dependencies and no live installation registrations.';
