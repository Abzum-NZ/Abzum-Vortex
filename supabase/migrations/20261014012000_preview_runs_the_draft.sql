-- Preview runs the draft as an isolated Application (#2740, P5d of #2727).
-- A preview is provisioned from the Application draft's publication, rehearsed and undone: the
-- release rows it writes for the Application and its owned Modules are kept per preview in
-- preview_releases. runtime_releases and runtime_release_dependencies show the stored releases
-- together with the rows of the preview the transaction-local preview address names, so every
-- runtime reader runs a preview exactly like an installed release; without an address they are
-- the stored releases. read_current_active_installation returns the preview's installation for a
-- preview request and never the live one. Each record type gets isolated storage seeded with the
-- organisation's live records. One preview per Application; a new preview replaces it, and expiry
-- drops it. The builder preview operations, preview reads and discards are removed.
set local role vortex_owner;

-- Previews of the earlier shape carry a compilation candidate and cannot run: drop them.
do $migration$
declare
  preview_row record;
begin
  for preview_row in
    select preview.preview_installation_id
    from vortex_definition.preview_installations as preview
    order by preview.preview_installation_id
  loop
    perform vortex_record.drop_preview_installation_storage(preview_row.preview_installation_id);
    delete from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = preview_row.preview_installation_id;
  end loop;
end
$migration$;

-- The preview installation reader is now also the active installation reader's for a preview.
grant execute on function vortex_definition.read_preview_record_installation_internal(uuid)
  to vortex_owner;

drop function vortex_definition.read_preview_installation(uuid);
drop function vortex_definition.discard_preview_installation(uuid);
drop function vortex_definition.create_preview_installation(uuid, bigint, jsonb);

alter table vortex_definition.preview_installations
  drop column candidate,
  add column application_release_revision bigint not null
    constraint preview_installations_application_release_revision_check
    check (application_release_revision between 1 and 9007199254740991),
  add column runtime_release_set jsonb
    constraint preview_installations_runtime_release_set_object
    check (runtime_release_set is null or pg_catalog.jsonb_typeof(runtime_release_set) = 'object');

create table vortex_definition.preview_releases (
  preview_installation_id uuid not null
    references vortex_definition.preview_installations (preview_installation_id) on delete cascade,
  root_id uuid not null references vortex_definition.roots (root_id),
  release_revision bigint not null
    constraint preview_releases_release_revision_check
    check (release_revision between 1 and 9007199254740991),
  release jsonb not null constraint preview_releases_release_object
    check (pg_catalog.jsonb_typeof(release) = 'object'),
  dependencies jsonb not null constraint preview_releases_dependencies_array
    check (pg_catalog.jsonb_typeof(dependencies) = 'array'),
  constraint preview_releases_pkey primary key (preview_installation_id, root_id),
  constraint preview_releases_row_identity check (
    release ->> 'root_id' = root_id::text
    and release ->> 'release_revision' = release_revision::text
  )
);
alter table vortex_definition.preview_releases enable row level security;
alter table vortex_definition.preview_releases force row level security;
create policy preview_releases_owner on vortex_definition.preview_releases
  to vortex_owner using (true) with check (true);
revoke all on table vortex_definition.preview_releases
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on table vortex_definition.preview_releases is
  'The release rows and dependency rows a rehearsed publication of one previewed Application draft wrote, kept for that preview only.';

-- The preview query path checks a preview field's stored value type through the Record adapter.
grant execute on function vortex_record.database_value_type(jsonb) to vortex_record_adapter;

create or replace function vortex_definition.current_preview_installation_id_internal()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  address_value text;
  context_value jsonb;
  preview_id_value uuid;
begin
  address_value := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  if address_value is null then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not pg_catalog.pg_input_is_valid(address_value, 'uuid')
    or context_value is null
    or not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Preview installation address is refused';
  end if;
  select preview.preview_installation_id into preview_id_value
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = address_value::uuid
    and preview.organization_id = (context_value ->> 'organizationId')::uuid
    and preview.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp();
  if not found then
    raise exception using errcode = '42501',
      message = 'Preview installation is unavailable';
  end if;
  return preview_id_value;
end
$function$;

alter function vortex_definition.current_preview_installation_id_internal() owner to vortex_owner;

revoke all on function vortex_definition.current_preview_installation_id_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.current_preview_installation_id_internal()
  to vortex_record_adapter;
comment on function vortex_definition.current_preview_installation_id_internal() is
  'The unexpired preview installation the transaction-local preview address names for the validated human Application context, or null without an address; a refused address raises instead of selecting live releases.';


create view vortex_definition.runtime_releases as
select release.*
from vortex_definition.releases as release
where not exists (
  select 1
  from vortex_definition.preview_releases as preview
  where preview.preview_installation_id =
      (select vortex_definition.current_preview_installation_id_internal())
    and preview.root_id = release.root_id
    and preview.release_revision = release.release_revision
)
union all
select rehearsed.*
from vortex_definition.preview_releases as preview
cross join lateral pg_catalog.jsonb_populate_record(
  null::vortex_definition.releases, preview.release
) as rehearsed
where preview.preview_installation_id =
  (select vortex_definition.current_preview_installation_id_internal());

create view vortex_definition.runtime_release_dependencies as
select dependency.*
from vortex_definition.release_dependencies as dependency
where not exists (
  select 1
  from vortex_definition.preview_releases as preview
  where preview.preview_installation_id =
      (select vortex_definition.current_preview_installation_id_internal())
    and preview.root_id = dependency.root_id
    and preview.release_revision = dependency.release_revision
)
union all
select rehearsed.*
from vortex_definition.preview_releases as preview
cross join lateral pg_catalog.jsonb_populate_recordset(
  null::vortex_definition.release_dependencies, preview.dependencies
) as rehearsed
where preview.preview_installation_id =
  (select vortex_definition.current_preview_installation_id_internal());

revoke all on table vortex_definition.runtime_releases
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on table vortex_definition.runtime_release_dependencies
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant select on table vortex_definition.runtime_releases to vortex_record_adapter;
grant select on table vortex_definition.runtime_release_dependencies to vortex_record_adapter;
comment on view vortex_definition.runtime_releases is
  'The releases a runtime request runs: the stored releases and, for a preview request, the rehearsed releases of that preview.';
comment on view vortex_definition.runtime_release_dependencies is
  'The release dependencies a runtime request runs: the stored ones and, for a preview request, the rehearsed ones of that preview.';

create or replace function vortex_definition.read_preview_record_installation_internal(
  p_preview_installation_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  preview_row vortex_definition.preview_installations%rowtype;
  module_bindings_value jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text) then
    return null;
  end if;

  begin
    context_value := vortex_definition.assert_preview_installation_authority_internal();
  exception when insufficient_privilege then
    return null;
  end;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (context_value ->> 'organizationId')::uuid
    and preview.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
  for key share;
  if not found then
    return null;
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'organizationId', preview_row.organization_id,
      'applicationRootId', preview_row.application_root_id,
      'moduleRootId', item.value -> 'moduleRootId',
      'bindingRevision', 1,
      'applicationReleaseRevision', preview_row.application_release_revision,
      'moduleReleaseRevision', item.value -> 'moduleReleaseRevision',
      'state', 'active'
    ) order by item.value ->> 'moduleRootId' collate "C"
  ), '[]'::jsonb)
  into module_bindings_value
  from pg_catalog.jsonb_array_elements(preview_row.resolved_modules) as item(value);

  return pg_catalog.jsonb_build_object(
    'organizationId', preview_row.organization_id,
    'applicationRootId', preview_row.application_root_id,
    'applicationReleaseRevision', preview_row.application_release_revision,
    'moduleBindings', module_bindings_value,
    'previewInstallationId', preview_row.preview_installation_id,
    'storageIdentities', preview_row.storage_identities
  );
end
$function$;

alter function vortex_definition.read_preview_record_installation_internal(uuid)
  owner to vortex_owner;

revoke all on function vortex_definition.read_preview_record_installation_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_preview_record_installation_internal(uuid)
  to vortex_record_adapter, vortex_owner;
comment on function vortex_definition.read_preview_record_installation_internal(uuid) is
  'The installation of one unexpired preview for a builder of its Application in the validated human request: the active installation shape with the preview''s exact release pins, its address and its isolated storage identities.';

create or replace function vortex_definition.read_current_active_installation()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  preview_address text;
  preview_value jsonb;
begin
  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId' then
    raise exception using errcode = '22023', message = 'Active Application context is required';
  end if;
  -- A preview request runs its own installation and never reaches the live one.
  preview_address := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  if preview_address is not null then
    if not pg_catalog.pg_input_is_valid(preview_address, 'uuid') then
      raise exception using errcode = '42501', message = 'Preview installation address is refused';
    end if;
    preview_value := vortex_definition.read_preview_record_installation_internal(
      preview_address::uuid
    );
    if preview_value is null then
      raise exception using errcode = '42501', message = 'Preview installation is unavailable';
    end if;
    return preview_value;
  end if;
  return vortex_definition.read_active_installation_for_scope_internal(
    (checked_context ->> 'organizationId')::uuid,
    (checked_context ->> 'applicationRootId')::uuid
  );
end
$function$;

alter function vortex_definition.read_current_active_installation() owner to vortex_owner;

revoke all on function vortex_definition.read_current_active_installation() from public;
grant execute on function vortex_definition.read_current_active_installation() to vortex_request;
grant execute on function vortex_definition.read_current_active_installation() to vortex_record_adapter;
grant execute on function vortex_definition.read_current_active_installation() to postgres;
grant execute on function vortex_definition.read_current_active_installation() to vortex_owner;
comment on function vortex_definition.read_current_active_installation() is
  'Returns the complete exact Module binding set the validated human Application context runs: the active installation, or the preview installation its transaction-local address names.';

create or replace function vortex_definition.is_current_application_address_release(
  p_release_revision bigint
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  installation_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId'
    or p_release_revision not between 1 and 9007199254740991 then
    return false;
  end if;
  installation_value := vortex_definition.read_current_active_installation();
  return (installation_value ->> 'applicationReleaseRevision')::bigint = p_release_revision
    and exists (
    select 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = (context_value ->> 'organizationId')::uuid
      and registration.registration_kind = 'application'
      and registration.registration_owner_id =
        (context_value ->> 'applicationRootId')::uuid
      and registration.state = 'active'
      -- A preview runs the draft under the permissions the installed release registered.
      and (installation_value ? 'previewInstallationId'
        or registration.source_revision = p_release_revision)
  );
exception
  when sqlstate 'P0002' or sqlstate '55000' or sqlstate '23514' then
    return false;
end
$function$;

revoke execute on function vortex_definition.is_current_application_address_release(bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.is_current_application_address_release(bigint)
  to vortex_request;

comment on function vortex_definition.is_current_application_address_release(bigint) is
  'Checks an internal candidate release against the exact active registration and binding in the validated human application context, or against the pins of the preview installation the context runs.';

alter function vortex_definition.is_current_application_address_release(p_release_revision bigint) owner to vortex_owner;

create or replace function vortex_definition.project_consumer_release_evidence(
  p_kind text,
  p_root_id uuid,
  p_release_revision bigint
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'organizationId', root.organization_id,
    'kind', root.kind,
    'key', root.key,
    'rootId', release.root_id,
    'releaseRevision', release.release_revision,
    'releaseVersion', release.release_version,
    'sourceContractVersion', release.source_contract_version,
    'validationContractVersion', release.validation_contract_version,
    'contentFingerprint', release.content_fingerprint,
    'resolutionFingerprint', release.resolution_fingerprint,
    'compilationOutput', release.compilation_output,
    'resolutionSnapshot', release.resolution_snapshot,
    'dependencyManifest', coalesce((
      select pg_catalog.jsonb_agg(
        case dependency.dependency_kind
          when 'module' then pg_catalog.jsonb_build_object(
            'kind', 'module',
            'key', dependency.dependency_reference,
            'rootId', dependency.target_root_id,
            'releaseRevision', dependency.target_release_revision,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'connection_type' then pg_catalog.jsonb_build_object(
            'kind', 'connection_type',
            'key', dependency.dependency_reference,
            'rootId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'platform_block' then pg_catalog.jsonb_build_object(
            'kind', 'platform_block',
            'blockId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'platform_theme' then pg_catalog.jsonb_build_object(
            'kind', 'platform_theme',
            'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          else dependency.dependency_entry
        end
        order by dependency.dependency_kind collate "C",
          dependency.dependency_reference collate "C",
          dependency.dependency_version collate "C"
      )
      from vortex_definition.runtime_release_dependencies as dependency
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
    ), '[]'::jsonb),
    'moduleDependencyTargets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'rootId', target.root_id,
          'releaseRevision', target.release_revision,
          'releaseVersion', target.release_version,
          'contentFingerprint', target.content_fingerprint,
          'resolutionFingerprint', target.resolution_fingerprint
        ) order by dependency.dependency_reference collate "C",
          target.root_id, target.release_revision
      )
      from vortex_definition.runtime_release_dependencies as dependency
      join vortex_definition.runtime_releases as target
        on target.root_id = dependency.target_root_id
        and target.release_revision = dependency.target_release_revision
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
        and dependency.dependency_kind = 'module'
    ), '[]'::jsonb)
  )
  from vortex_definition.roots as root
  join vortex_definition.runtime_releases as release
    on release.root_id = root.root_id
    and release.release_revision = p_release_revision
  where root.root_id = p_root_id
    and root.kind = p_kind
$function$;

revoke all on function vortex_definition.project_consumer_release_evidence(text, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.project_consumer_release_evidence(text, uuid, bigint) to vortex_owner;
comment on function vortex_definition.project_consumer_release_evidence(text, uuid, bigint) is
  'Owner-private projection of one exact immutable release; performs no scope selection.';

alter function vortex_definition.project_consumer_release_evidence(p_kind text, p_root_id uuid, p_release_revision bigint) owner to vortex_owner;

grant execute on function vortex_definition.project_consumer_release_evidence(p_kind text, p_root_id uuid, p_release_revision bigint) to postgres;

create or replace function vortex_definition.read_rehearsed_preview_releases(
  p_application_root_id uuid,
  p_pins jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  pin_count bigint;
  releases_value jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or pg_catalog.jsonb_typeof(p_pins) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_pins) > 201
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_pins) as pin(value)
      where pg_catalog.jsonb_typeof(pin.value) is distinct from 'object'
        or not coalesce(pg_catalog.pg_input_is_valid(pin.value ->> 'rootId', 'uuid'), false)
        or pg_catalog.jsonb_typeof(pin.value -> 'releaseRevision') is distinct from 'number'
    ) then
    raise exception using errcode = '22023',
      message = 'Rehearsed preview release selection is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  pin_count := pg_catalog.jsonb_array_length(p_pins);

  -- Only the Application and the Modules it owns, exactly as the rehearsal stored them.
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'release', pg_catalog.to_jsonb(release.*),
      'dependencies', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(dependency.*)
          order by dependency.dependency_kind collate "C",
            dependency.dependency_reference collate "C",
            dependency.dependency_version collate "C")
        from vortex_definition.release_dependencies as dependency
        where dependency.root_id = release.root_id
          and dependency.release_revision = release.release_revision
      ), '[]'::jsonb)
    ) order by release.root_id
  ), '[]'::jsonb)
  into releases_value
  from (
    select distinct (pin.value ->> 'rootId')::uuid as root_id,
      (pin.value ->> 'releaseRevision')::bigint as release_revision
    from pg_catalog.jsonb_array_elements(p_pins) as pin(value)
  ) as pin
  join vortex_definition.releases as release
    on release.root_id = pin.root_id
    and release.release_revision = pin.release_revision
  join vortex_definition.roots as root on root.root_id = release.root_id
  where root.organization_id = (checked_context ->> 'organizationId')::uuid
    and (root.root_id = p_application_root_id
      or (root.kind = 'module' and root.owner_application_root_id = p_application_root_id));

  if pg_catalog.jsonb_array_length(releases_value) <> pin_count then
    raise exception using errcode = '23514',
      message = 'Rehearsed preview releases do not match the Application draft';
  end if;
  return releases_value;
end
$function$;

alter function vortex_definition.read_rehearsed_preview_releases(uuid, jsonb) owner to vortex_owner;

revoke all on function vortex_definition.read_rehearsed_preview_releases(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_rehearsed_preview_releases(uuid, jsonb)
  to vortex_request;
comment on function vortex_definition.read_rehearsed_preview_releases(uuid, jsonb) is
  'Reads, inside a rehearsed publication of the Application draft, the stored release rows and dependency rows it wrote for the Application and its owned Modules, so a preview can run them after the rehearsal is undone.';

create or replace function vortex_definition.read_preview_application_identity(
  p_preview_installation_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  identity_value jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text) then
    raise exception using errcode = '22023', message = 'Preview installation identity is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  select pg_catalog.jsonb_build_object(
    'previewInstallationId', preview.preview_installation_id,
    'organizationId', preview.organization_id,
    'applicationRootId', preview.application_root_id,
    'definitionKey', root.key,
    'draftRevision', preview.draft_revision,
    'expiresAt', preview.expires_at
  ) into identity_value
  from vortex_definition.preview_installations as preview
  join vortex_definition.roots as root on root.root_id = preview.application_root_id
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
    and root.kind = 'application';
  return identity_value;
end
$function$;

alter function vortex_definition.read_preview_application_identity(uuid) owner to vortex_owner;

revoke all on function vortex_definition.read_preview_application_identity(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_preview_application_identity(uuid)
  to vortex_request;
comment on function vortex_definition.read_preview_application_identity(uuid) is
  'The Application, key and draft revision of one unexpired preview, for a builder of the validated human organisation context; null when there is no such preview.';

create or replace function vortex_definition.read_preview_release_evidence()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installation_value jsonb;
  application_value jsonb;
  modules_value jsonb;
begin
  installation_value := vortex_definition.read_current_active_installation();
  if not installation_value ? 'previewInstallationId' then
    raise exception using errcode = '42501', message = 'Preview installation address is required';
  end if;

  application_value := vortex_definition.project_consumer_release_evidence(
    'application',
    (installation_value ->> 'applicationRootId')::uuid,
    (installation_value ->> 'applicationReleaseRevision')::bigint
  );
  select pg_catalog.jsonb_agg(
    vortex_definition.project_consumer_release_evidence(
      'module',
      (binding.value ->> 'moduleRootId')::uuid,
      (binding.value ->> 'moduleReleaseRevision')::bigint
    ) order by binding.value ->> 'moduleRootId' collate "C"
  ) into modules_value
  from pg_catalog.jsonb_array_elements(installation_value -> 'moduleBindings') as binding(value);
  if application_value is null
    or modules_value is null
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(modules_value) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
    ) then
    raise exception using errcode = '23514', message = 'Preview release evidence is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'installation', installation_value,
    'correlationId', vortex_access.validated_human_request_context() ->> 'correlationId',
    'application', application_value,
    'modules', modules_value
  );
end
$function$;

alter function vortex_definition.read_preview_release_evidence() owner to vortex_owner;

revoke all on function vortex_definition.read_preview_release_evidence()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_preview_release_evidence()
  to vortex_request;
comment on function vortex_definition.read_preview_release_evidence() is
  'The exact release evidence of the preview the validated human Application request runs, from which its provisioning projects the release set the runtime renders.';

create or replace function vortex_definition.write_preview_runtime_release_set(
  p_release_set jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installation_value jsonb;
begin
  if pg_catalog.jsonb_typeof(p_release_set) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_release_set -> 'application') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_release_set -> 'modules') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Preview release set is invalid';
  end if;
  installation_value := vortex_definition.read_current_active_installation();
  if not installation_value ? 'previewInstallationId' then
    raise exception using errcode = '42501', message = 'Preview installation address is required';
  end if;
  -- The release set names exactly the preview's Application release and Module pins.
  if p_release_set #>> '{application,rootId}' is distinct from installation_value ->> 'applicationRootId'
    or p_release_set #>> '{application,releaseRevision}'
      is distinct from installation_value ->> 'applicationReleaseRevision'
    or (
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          pg_catalog.lower(item.value ->> 'rootId'), item.value -> 'releaseRevision'
        ) order by pg_catalog.lower(item.value ->> 'rootId') collate "C"
      ), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(p_release_set -> 'modules') as item(value)
    ) is distinct from (
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          pg_catalog.lower(binding.value ->> 'moduleRootId'), binding.value -> 'moduleReleaseRevision'
        ) order by pg_catalog.lower(binding.value ->> 'moduleRootId') collate "C"
      ), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(installation_value -> 'moduleBindings') as binding(value)
    ) then
    raise exception using errcode = '23514', message = 'Preview release set does not match its pins';
  end if;
  update vortex_definition.preview_installations as preview
  set runtime_release_set = p_release_set
  where preview.preview_installation_id = (installation_value ->> 'previewInstallationId')::uuid
    and preview.runtime_release_set is null;
  if not found then
    raise exception using errcode = '55000', message = 'Preview release set is already written';
  end if;
  return true;
end
$function$;

alter function vortex_definition.write_preview_runtime_release_set(jsonb) owner to vortex_owner;

revoke all on function vortex_definition.write_preview_runtime_release_set(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.write_preview_runtime_release_set(jsonb)
  to vortex_request;
comment on function vortex_definition.write_preview_runtime_release_set(jsonb) is
  'Stores, once, the release set the runtime renders for the preview the validated human Application request runs, after checking it names exactly the preview''s release pins.';

create or replace function vortex_definition.read_preview_runtime_source()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installation_value jsonb;
  preview_row vortex_definition.preview_installations%rowtype;
begin
  installation_value := vortex_definition.read_current_active_installation();
  if not installation_value ? 'previewInstallationId' then
    raise exception using errcode = '42501', message = 'Preview installation address is required';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = (installation_value ->> 'previewInstallationId')::uuid;
  if not found or preview_row.runtime_release_set is null then
    raise exception using errcode = '55000', message = 'Preview release set is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'installation', installation_value,
    'draftRevision', preview_row.draft_revision,
    'expiresAt', preview_row.expires_at,
    'correlationId', vortex_access.validated_human_request_context() ->> 'correlationId',
    'releaseSet', preview_row.runtime_release_set
  );
end
$function$;

alter function vortex_definition.read_preview_runtime_source() owner to vortex_owner;

revoke all on function vortex_definition.read_preview_runtime_source()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_preview_runtime_source()
  to vortex_request;
comment on function vortex_definition.read_preview_runtime_source() is
  'The installation, draft revision, expiry and stored release set of the preview the validated human Application request runs, for the runtime to render it as an installed Application.';

create or replace function vortex_definition.create_preview_installation(
  p_application_root_id uuid,
  p_expected_draft_revision bigint,
  p_releases jsonb
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
  current_release_revision_value bigint;
  application_release_revision_value bigint;
  created_at_value timestamptz;
  expires_at_value timestamptz;
  previous_preview record;
  module_pin record;
  resolved_modules_value jsonb := '[]'::jsonb;
  storage_identities_value jsonb := '[]'::jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_releases) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_releases) > 201
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_releases) as item(value)
      where pg_catalog.jsonb_typeof(item.value -> 'release') is distinct from 'object'
        or pg_catalog.jsonb_typeof(item.value -> 'dependencies') is distinct from 'array'
        or not coalesce(pg_catalog.pg_input_is_valid(item.value #>> '{release,root_id}', 'uuid'), false)
        or not coalesce(pg_catalog.pg_input_is_valid(
          item.value #>> '{release,release_revision}', 'bigint'
        ), false)
    ) then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  organization_id_value := (checked_context ->> 'organizationId')::uuid;
  organization_account_id_value := (checked_context ->> 'organizationAccountId')::uuid;
  identity_id_value := (checked_context ->> 'identityId')::uuid;
  if checked_context ->> 'applicationRootId' is distinct from p_application_root_id::text then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;

  select draft.draft_revision, root.current_release_revision
  into draft_revision_value, current_release_revision_value
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = p_application_root_id
    and root.organization_id = organization_id_value
    and root.kind = 'application'
  for share of draft;
  if not found or draft_revision_value <> p_expected_draft_revision then
    raise exception using errcode = '40001', message = 'Application draft revision changed';
  end if;

  -- Each rehearsed release is the release a publication of this draft writes: the Application
  -- at its draft revision, or an owned Module at its staged draft revision, newer than the
  -- current release of its root and of that root's kind; at most one per root.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_releases) as item(value)
    where not exists (
      select 1
      from vortex_definition.roots as root
      join vortex_definition.drafts as draft on draft.root_id = root.root_id
      where root.root_id = (item.value #>> '{release,root_id}')::uuid
        and root.organization_id = organization_id_value
        and (root.root_id = p_application_root_id
          or (root.kind = 'module' and root.owner_application_root_id = p_application_root_id))
        and draft.draft_revision = (item.value #>> '{release,release_revision}')::bigint
        and draft.draft_revision > coalesce(root.current_release_revision, 0)
        and item.value #>> '{release,compilation_output,kind}' = root.kind
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(item.value -> 'dependencies') as dependency(value)
          where dependency.value ->> 'root_id' is distinct from root.root_id::text
            or dependency.value ->> 'release_revision' is distinct from draft.draft_revision::text
        )
    )
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value #>> '{release,root_id}')
    from pg_catalog.jsonb_array_elements(p_releases) as item(value)
  ) then
    raise exception using errcode = '23514',
      message = 'Rehearsed preview releases are not this Application draft';
  end if;
  application_release_revision_value := coalesce((
    select (item.value #>> '{release,release_revision}')::bigint
    from pg_catalog.jsonb_array_elements(p_releases) as item(value)
    where (item.value #>> '{release,root_id}')::uuid = p_application_root_id
  ), current_release_revision_value);
  if application_release_revision_value is null then
    raise exception using errcode = 'P0002', message = 'Application has no release to preview';
  end if;

  -- One preview per Application: a new preview replaces the previous one and its storage.
  for previous_preview in
    select preview.preview_installation_id
    from vortex_definition.preview_installations as preview
    where preview.organization_id = organization_id_value
      and preview.application_root_id = p_application_root_id
    order by preview.preview_installation_id
    for update
  loop
    perform vortex_record.drop_preview_installation_storage(
      previous_preview.preview_installation_id
    );
    delete from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = previous_preview.preview_installation_id;
  end loop;
  perform vortex_definition.expire_preview_installations(100);

  preview_installation_id_value := pg_catalog.gen_random_uuid();
  created_at_value := pg_catalog.statement_timestamp();
  expires_at_value := created_at_value + preview_lifetime;
  insert into vortex_definition.preview_installations (
    preview_installation_id, organization_id, application_root_id,
    draft_revision, application_release_revision, previewer_identity_id,
    previewer_organization_account_id, resolved_modules, storage_identities,
    created_at, expires_at
  ) values (
    preview_installation_id_value, organization_id_value, p_application_root_id,
    p_expected_draft_revision, application_release_revision_value, identity_id_value,
    organization_account_id_value, '[]'::jsonb, '[]'::jsonb,
    created_at_value, expires_at_value
  );
  insert into vortex_definition.preview_releases (
    preview_installation_id, root_id, release_revision, release, dependencies
  )
  select preview_installation_id_value, (item.value #>> '{release,root_id}')::uuid,
    (item.value #>> '{release,release_revision}')::bigint,
    item.value -> 'release', item.value -> 'dependencies'
  from pg_catalog.jsonb_array_elements(p_releases) as item(value);

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
          where preview.preview_installation_id = preview_installation_id_value
            and preview.root_id = dependency.root_id
            and preview.release_revision = dependency.release_revision
        )
      union all
      select preview.root_id, preview.release_revision,
        (dependency.value ->> 'target_root_id')::uuid,
        (dependency.value ->> 'target_release_revision')::bigint
      from vortex_definition.preview_releases as preview
      cross join lateral pg_catalog.jsonb_array_elements(preview.dependencies) as dependency(value)
      where preview.preview_installation_id = preview_installation_id_value
        and dependency.value ->> 'dependency_kind' = 'module'
    ), closure(module_root_id, module_release_revision) as (
      select edge.target_root_id, edge.target_release_revision
      from edges as edge
      where edge.root_id = p_application_root_id
        and edge.release_revision = application_release_revision_value
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
          where preview.preview_installation_id = preview_installation_id_value
            and preview.root_id = closure.module_root_id
            and preview.release_revision = closure.module_release_revision),
        (select release.release_version
          from vortex_definition.releases as release
          join vortex_definition.roots as root on root.root_id = release.root_id
          where release.root_id = closure.module_root_id
            and release.release_revision = closure.module_release_revision
            and root.kind = 'module'
            and root.organization_id = organization_id_value)
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
    storage_identities_value := storage_identities_value
      || vortex_record.provision_preview_module_storage(
        preview_installation_id_value, module_pin.module_root_id,
        module_pin.module_release_revision
      );
  end loop;
  if pg_catalog.jsonb_array_length(resolved_modules_value) = 0 then
    raise exception using errcode = '23514', message = 'Previewed Application binds no Module';
  end if;

  update vortex_definition.preview_installations as preview
  set resolved_modules = resolved_modules_value,
      storage_identities = storage_identities_value
  where preview.preview_installation_id = preview_installation_id_value;

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', preview_installation_id_value,
    'organizationId', organization_id_value,
    'applicationRootId', p_application_root_id,
    'draftRevision', p_expected_draft_revision,
    'applicationReleaseRevision', application_release_revision_value,
    'createdAt', created_at_value,
    'expiresAt', expires_at_value
  );
end
$function$;

alter function vortex_definition.create_preview_installation(uuid, bigint, jsonb) owner to vortex_owner;

revoke all on function vortex_definition.create_preview_installation(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.create_preview_installation(uuid, bigint, jsonb)
  to vortex_request;
comment on function vortex_definition.create_preview_installation(uuid, bigint, jsonb) is
  'Replaces the 24-hour preview of one Application with a preview of its current draft: the releases its publication rehearsed, the exact Module pins they and the used Module releases name, and isolated storage for every bound record type seeded with a copy of the organisation''s live records.';

create or replace function vortex_record.provision_preview_module_storage(
  p_preview_installation_id uuid,
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  record_types jsonb;
  record_type jsonb;
  preview_record_type jsonb;
  field_value jsonb;
  storage_id uuid;
  preview_storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  table_token text;
  column_token text;
  storage_scope_value text;
  ownership_mode_value text;
  database_type text;
  sql_type text;
  shape_fingerprint text;
  scope_index_columns text;
  index_token text;
  live_table_token text;
  storage_identities jsonb := '[]'::jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Preview storage selector is invalid';
  end if;
  -- The preview's own rehearsed release of an owned Module, or else the stored release.
  select (pg_catalog.jsonb_populate_record(
    null::vortex_definition.releases, preview_release.release
  )).* into release_row
  from vortex_definition.preview_releases as preview_release
  join vortex_definition.roots as root on root.root_id = preview_release.root_id
  where preview_release.preview_installation_id = p_preview_installation_id
    and preview_release.root_id = p_module_root_id
    and preview_release.release_revision = p_module_release_revision
    and root.kind = 'module';
  if not found then
    select release.* into strict release_row
    from vortex_definition.releases as release
    join vortex_definition.roots as root on root.root_id = release.root_id
    where release.root_id = p_module_root_id
      and release.release_revision = p_module_release_revision
      and root.kind = 'module';
  end if;
  if release_row.validation_contract_version <> all (vortex_definition.accepted_contract_version('module'))
    or release_row.source_contract_version
      is distinct from release_row.validation_contract_version
    or release_row.compilation_output #>> '{kind}' is distinct from 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}'
      is distinct from release_row.validation_contract_version then
    raise exception using errcode = '23514', message = 'Exact Module release is incompatible';
  end if;
  record_types := release_row.compilation_output #> '{canonical,content,recordTypes}';
  if pg_catalog.jsonb_typeof(record_types) <> 'array' then
    raise exception using errcode = '23514', message = 'Module record storage definition is incompatible';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    where item.value ->> 'storageContractId' is null
      or item.value ->> 'recordTypeId' is null
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'storageContractId')
      or pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module record storage identities are duplicated';
  end if;

  -- A system projection is the platform's own read model, which a preview reads as it is: it
  -- has no storage of its own to isolate.
  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    where not item.value ? 'systemProjection'
    order by item.value ->> 'storageContractId'
  loop
    begin
      storage_id := (record_type ->> 'storageContractId')::uuid;
      record_type_id_value := (record_type ->> 'recordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Module record storage identity is invalid';
    end;
    storage_scope_value := record_type ->> 'storageScope';
    ownership_mode_value := record_type ->> 'ownershipMode';
    if not vortex_platform.is_non_nil_uuid(storage_id::text)
      or not vortex_platform.is_non_nil_uuid(record_type_id_value::text)
      or storage_scope_value not in ('organization_shared', 'application_contained')
      or ownership_mode_value not in ('none', 'organization_account', 'group', 'inherited')
      or pg_catalog.jsonb_typeof(record_type -> 'fields') <> 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') <> 'array' then
      raise exception using errcode = '42501', message = 'Module record storage definition is invalid';
    end if;

    preview_storage_id := pg_catalog.gen_random_uuid();
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || preview_storage_id::text, 0)
    );
    table_token := 'rt_' || pg_catalog.replace(pg_catalog.lower(preview_storage_id::text), '-', '');
    preview_record_type := pg_catalog.jsonb_set(
      record_type,
      '{storageContractId}',
      pg_catalog.to_jsonb(preview_storage_id::text),
      true
    );
    shape_fingerprint := vortex_record.storage_meaning_fingerprint(preview_record_type);

    -- The live storage this record type's records are copied from, when it has any.
    select catalogue.physical_table_token into live_table_token
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_id
      and catalogue.physical_schema_token = 'record_data'
      and catalogue.state = 'active';
    perform vortex_record.create_record_storage_table_internal(
      preview_storage_id, p_module_root_id, record_type_id_value,
      storage_scope_value, ownership_mode_value
    );
    insert into vortex_record.storage_catalogue (
      storage_contract_id, physical_schema_token, physical_table_token,
      module_root_id, record_type_id, storage_scope,
      first_compatible_release_revision, last_compatible_release_revision,
      state, content_fingerprint, record_type_definition, protected_read_model_key
    ) values (
      preview_storage_id, 'record_data', table_token,
      p_module_root_id, record_type_id_value, storage_scope_value,
      p_module_release_revision, p_module_release_revision,
      'active', shape_fingerprint, preview_record_type, null
    );

    for field_value in
      select item.value
      from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      begin
        field_id_value := (field_value ->> 'fieldId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '42501', message = 'Record field storage identity is invalid';
      end;
      if not vortex_platform.is_non_nil_uuid(field_id_value::text)
        or field_value ->> 'type' is null
        or pg_catalog.jsonb_typeof(field_value -> 'required') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'unique') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'filterable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'sortable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'settings') <> 'object' then
        raise exception using errcode = '42501', message = 'Record field storage definition is invalid';
      end if;
      column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
      database_type := vortex_record.database_value_type(field_value);
      if database_type is null then
        raise exception using errcode = '23514', message = 'Record field storage type is unsupported';
      end if;
      sql_type := vortex_record.sql_value_type(database_type);
      execute pg_catalog.format(
        'alter table record_data.%I add column %I %s%s',
        table_token, column_token, sql_type,
        -- Copied live records have no value for a field the draft adds, so only fresh storage
        -- enforces a required field in the table; the save path enforces it for every record.
        case when (field_value ->> 'required')::boolean and live_table_token is null
          then ' not null' else '' end
      );
      insert into vortex_record.field_storage_mappings (
        storage_contract_id, field_id, physical_column_token, database_value_type,
        field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
      ) values (
        preview_storage_id, field_id_value, column_token, database_type, field_value,
        p_module_root_id, p_module_release_revision, 'active'
      );
      if not (record_type ? 'systemProjection')
        and (field_value ->> 'unique')::boolean then
        scope_index_columns := case storage_scope_value
          when 'organization_shared' then 'organisation_id'
          else 'organisation_id, application_root_id'
        end;
        index_token := 'pux_' || pg_catalog.md5(
          preview_storage_id::text || ':' || field_id_value::text
        );
        execute pg_catalog.format(
          'create unique index %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
          index_token, table_token, scope_index_columns, column_token
        );
      end if;
    end loop;

    if live_table_token is not null then
      perform vortex_record.copy_live_records_to_preview_internal(
        p_preview_installation_id, storage_id, preview_storage_id
      );
    end if;

    insert into vortex_record.preview_storage_bindings (
      preview_installation_id, storage_contract_id, module_root_id,
      module_release_revision, record_type_id, release_storage_contract_id
    ) values (
      p_preview_installation_id, preview_storage_id, p_module_root_id,
      p_module_release_revision, record_type_id_value, storage_id
    );
    storage_identities := storage_identities || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', p_module_root_id,
        'moduleReleaseRevision', p_module_release_revision,
        'recordTypeId', record_type_id_value,
        'releaseStorageContractId', storage_id,
        'previewStorageContractId', preview_storage_id
      )
    );
  end loop;
  return storage_identities;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Exact Module release is ambiguous';
end
$function$;

alter function vortex_record.provision_preview_module_storage(uuid,uuid,bigint) owner to vortex_owner;

revoke all on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint)
  to vortex_owner;
comment on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint) is
  'Creates isolated Record storage for every record type of one exact Module release of a preview, its rehearsed release or a stored one, seeded with a copy of the organisation''s live records, without provisioning its live release identities.';

set local role vortex_record_adapter;

create or replace function vortex_record.copy_live_records_to_preview_internal(
  p_preview_installation_id uuid,
  p_live_storage_contract_id uuid,
  p_preview_storage_contract_id uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  live_table_token text;
  preview_table_token text;
  copied_columns text;
  copied_count bigint;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_platform.is_non_nil_uuid(p_live_storage_contract_id::text)
    or not vortex_platform.is_non_nil_uuid(p_preview_storage_contract_id::text) then
    raise exception using errcode = '22023', message = 'Preview record copy selector is invalid';
  end if;
  select catalogue.physical_table_token into strict live_table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_live_storage_contract_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
  select catalogue.physical_table_token into strict preview_table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_preview_storage_contract_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active'
    and catalogue.module_root_id = (
      select live.module_root_id from vortex_record.storage_catalogue as live
      where live.storage_contract_id = p_live_storage_contract_id
    )
    and catalogue.record_type_id = (
      select live.record_type_id from vortex_record.storage_catalogue as live
      where live.storage_contract_id = p_live_storage_contract_id
    );

  -- Every column both tables have, except the storage identity each table fixes for itself: the
  -- record columns and each field the live release and the previewed draft both declare.
  select pg_catalog.string_agg(
    pg_catalog.quote_ident(preview_column.attname), ', ' order by preview_column.attnum
  )
  into copied_columns
  from pg_catalog.pg_attribute as preview_column
  join pg_catalog.pg_class as preview_table on preview_table.oid = preview_column.attrelid
  join pg_catalog.pg_namespace as preview_schema
    on preview_schema.oid = preview_table.relnamespace
  where preview_schema.nspname = 'record_data'
    and preview_table.relname = preview_table_token
    and preview_column.attnum > 0
    and not preview_column.attisdropped
    and preview_column.attname <> 'storage_contract_id'
    and exists (
      select 1
      from pg_catalog.pg_attribute as live_column
      join pg_catalog.pg_class as live_table on live_table.oid = live_column.attrelid
      join pg_catalog.pg_namespace as live_schema on live_schema.oid = live_table.relnamespace
      where live_schema.nspname = 'record_data'
        and live_table.relname = live_table_token
        and live_column.attname = preview_column.attname
        and live_column.attnum > 0
        and not live_column.attisdropped
        and live_column.atttypid = preview_column.atttypid
    );
  if copied_columns is null then
    raise exception using errcode = '55000', message = 'Preview record copy has no columns';
  end if;

  -- Row security limits both tables to the request's organisation and Application.
  execute pg_catalog.format(
    'insert into record_data.%I (storage_contract_id, %s) select %L::uuid, %s from record_data.%I',
    preview_table_token, copied_columns, p_preview_storage_contract_id, copied_columns,
    live_table_token
  );
  get diagnostics copied_count = row_count;

  insert into vortex_record.preview_reference_counters (
    preview_installation_id, storage_contract_id, field_id, next_number
  )
  select p_preview_installation_id, p_preview_storage_contract_id, counter.field_id,
    counter.next_number
  from vortex_record.record_reference_counters as counter
  where counter.storage_contract_id = p_live_storage_contract_id
    and counter.organization_id = vortex_platform.organization_id()
    and counter.next_number >= 2;
  return copied_count;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Preview record copy storage is unavailable';
end
$function$;

alter function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid)
  to vortex_owner;
comment on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid) is
  'Seeds one preview record table with the request organisation''s live records of the same record type and their reference counters; only columns both tables declare are copied.';

create or replace function vortex_record.resolve_installation_access_plan_internal(
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  none_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  plan_key_value text;
  cached_plan jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  application_release_revision_value bigint;
  preview_installation_id_value uuid;
  binding_item jsonb;
  release_content jsonb;
  release_revision_value bigint;
  release_validation_contract_version text;
  record_type_item jsonb;
  field_item jsonb;
  relationship_item jsonb;
  condition_item jsonb;
  permission_item jsonb;
  module_root_value uuid;
  record_type_id_value uuid;
  release_storage_contract_value uuid;
  storage_contract_value uuid;
  type_meta jsonb := '{}'::jsonb;
  relationship_by_id jsonb := '{}'::jsonb;
  condition_list jsonb := '[]'::jsonb;
  permission_by_id jsonb := '{}'::jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  columns_value jsonb;
  value_expression text;
  plan jsonb;
  cacheable boolean;
begin
  -- The plan is keyed by the exact installation pins. A binding revision is
  -- advanced by every installation lifecycle transition, and a release revision
  -- is immutable, so any change to definitions, bindings, permissions or saved
  -- conditions yields a different key and therefore a different plan. A plan
  -- that no longer matches the live pins can never be selected. The plan holds
  -- declared requirements only: role grants and every other decision input are
  -- read live by Access, never from the plan.
  if p_installation is null
    or pg_catalog.jsonb_typeof(p_installation) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_installation -> 'moduleBindings') is distinct from 'array'
    or (p_installation ->> 'organizationId') is null
    or (p_installation ->> 'applicationRootId') is null
    or (p_installation ->> 'applicationReleaseRevision') is null
    or (p_installation ? 'previewInstallationId'
      and pg_catalog.jsonb_typeof(p_installation -> 'storageIdentities') is distinct from 'array')
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not item.value ?& array[
          'moduleRootId', 'moduleReleaseRevision', 'bindingRevision', 'state'
        ]
    ) then
    raise exception using errcode = '42501',
      message = 'Record installation is unavailable';
  end if;

  organization_id_value := (p_installation ->> 'organizationId')::uuid;
  application_root_id_value := (p_installation ->> 'applicationRootId')::uuid;
  application_release_revision_value :=
    (p_installation ->> 'applicationReleaseRevision')::bigint;
  preview_installation_id_value := case
    when p_installation ? 'previewInstallationId'
      then (p_installation ->> 'previewInstallationId')::uuid
    else null
  end;
  if organization_id_value = none_uuid
    or application_root_id_value = none_uuid
    or application_release_revision_value not between 1 and 9007199254740991 then
    raise exception using errcode = '42501',
      message = 'Record installation is unavailable';
  end if;

  plan_key_value := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      organization_id_value::text || '|' || application_root_id_value::text || '|'
        || application_release_revision_value::text || '|'
        || case when preview_installation_id_value is null then ''
          else preview_installation_id_value::text || '|' end || coalesce((
          select pg_catalog.string_agg(
            (item.value ->> 'moduleRootId') || ':'
              || (item.value ->> 'moduleReleaseRevision') || ':'
              || (item.value ->> 'bindingRevision') || ':'
              || (item.value ->> 'state'),
            ',' order by (item.value ->> 'moduleRootId') collate "C"
          )
          from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
        ), ''),
      'UTF8'
    )),
    'hex'
  );

  -- Only an all-active pin set is cached. The storage catalogue and field
  -- mappings the plan resolves are not part of the key; storage adoption can
  -- retire a field mapping only while no provisioned or active binding pins a
  -- release that declares the field, so an active plan's mappings cannot
  -- change under it. A detached binding is not counted there, so a detached
  -- pin set is resolved afresh on every call and still refuses a retired
  -- mapping exactly as before.
  cacheable := preview_installation_id_value is null and not exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
    where (item.value ->> 'state') is distinct from 'active'
  );

  if cacheable then
    select stored.plan into cached_plan
    from vortex_record.installation_access_plans as stored
    where stored.plan_key = plan_key_value;
    if cached_plan is not null then
      return cached_plan;
    end if;
  end if;

  -- Step 1: the pinned definitions. Record types, relationships and saved
  -- conditions of every bound Module, plus the declared permissions of the
  -- Application release and of each Module release. Physical tokens are
  -- resolved here too, and every disagreement refuses.
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
    -- Canonical binding order, so the plan content never depends on the order
    -- a caller happened to supply and always matches the plan key's order.
    order by (item.value ->> 'moduleRootId') collate "C"
  loop
    module_root_value := (binding_item ->> 'moduleRootId')::uuid;
    release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;

    select release.compilation_output #> '{canonical,content}',
      release.validation_contract_version
    into strict release_content, release_validation_contract_version
    from vortex_definition.runtime_releases as release
    where release.root_id = module_root_value
      and release.release_revision = release_revision_value;

    if pg_catalog.jsonb_typeof(release_content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    end if;

    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes') as item(value)
    loop
      record_type_id_value := (record_type_item ->> 'recordTypeId')::uuid;
      release_storage_contract_value := (record_type_item ->> 'storageContractId')::uuid;
      -- A preview isolates its record storage; a system projection is read as it is.
      if preview_installation_id_value is null or record_type_item ? 'systemProjection' then
        storage_contract_value := release_storage_contract_value;
      else
        select (binding.value ->> 'previewStorageContractId')::uuid
        into strict storage_contract_value
        from pg_catalog.jsonb_array_elements(p_installation -> 'storageIdentities')
          as binding(value)
        where (binding.value ->> 'moduleRootId')::uuid = module_root_value
          and (binding.value ->> 'moduleReleaseRevision')::bigint = release_revision_value
          and (binding.value ->> 'recordTypeId')::uuid = record_type_id_value
          and (binding.value ->> 'releaseStorageContractId')::uuid = release_storage_contract_value;
        if not found then
          raise exception using errcode = '55000',
            message = 'Preview Record storage disagrees with its exact Module release';
        end if;
      end if;

      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = storage_contract_value;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> module_root_value
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token not in ('record_data', 'system_projection')
        -- A system projection is read only through the protected reader
        -- registered for exactly the key its installed definition declares (the
        -- catalogue key references the closed registry); a generated record
        -- type is never read through a projection, and a disagreeing key
        -- refuses.
        or (catalogue_row.physical_schema_token = 'system_projection')
          is distinct from (record_type_item ? 'systemProjection')
        or (catalogue_row.physical_schema_token = 'system_projection'
          and catalogue_row.protected_read_model_key
            is distinct from (record_type_item #>> '{systemProjection,protectedView}'))
        or (preview_installation_id_value is null and not exists (
          select 1
          from vortex_record.release_provisions as provision
          where provision.module_root_id = module_root_value
            and provision.release_revision = release_revision_value
            and release_storage_contract_value = any (provision.storage_contract_ids)
        )) then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;

      -- The column map and the one value expression that reads this record
      -- type's row, built once here and reused by every load below.
      columns_value := '{}'::jsonb;
      for field_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        select mapping.* into mapping_row
        from vortex_record.field_storage_mappings as mapping
        where mapping.storage_contract_id = storage_contract_value
          and mapping.field_id = (field_item ->> 'fieldId')::uuid;
        if not found or mapping_row.state <> 'active' then
          raise exception using errcode = '55000',
            message = 'Record storage disagrees with the installed definition';
        end if;
        columns_value := columns_value || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), pg_catalog.jsonb_build_object(
            'token', mapping_row.physical_column_token,
            'databaseValueType', mapping_row.database_value_type,
            'type', field_item ->> 'type'
          )
        );
      end loop;

      select pg_catalog.string_agg(
        field_chunk.pairs_text,
        ') || pg_catalog.jsonb_build_object(' order by field_chunk.chunk_index
      )
      into value_expression
      from (
        select (ordered_fields.field_number - 1) / 50 as chunk_index,
          pg_catalog.string_agg(
            pg_catalog.format(
              '%L, %s',
              ordered_fields.key,
              case ordered_fields.value ->> 'databaseValueType'
                when 'decimal' then
                  pg_catalog.format('pg_catalog.to_jsonb(%I::text)', ordered_fields.value ->> 'token')
                when 'timestamp_with_time_zone' then
                  pg_catalog.format(
                    'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(%I))',
                    ordered_fields.value ->> 'token'
                  )
                when 'date' then
                  pg_catalog.format(
                    'pg_catalog.to_jsonb(pg_catalog.to_char(%I, ''YYYY-MM-DD''))',
                    ordered_fields.value ->> 'token'
                  )
                else pg_catalog.format('pg_catalog.to_jsonb(%I)', ordered_fields.value ->> 'token')
              end
            ),
            ', ' order by ordered_fields.key collate "C"
          ) as pairs_text
        from (
          select column_entry.key, column_entry.value,
            pg_catalog.row_number() over (
              order by column_entry.key collate "C"
            ) as field_number
          from pg_catalog.jsonb_each(columns_value) as column_entry(key, value)
        ) as ordered_fields
        group by (ordered_fields.field_number - 1) / 50
      ) as field_chunk;

      type_meta := type_meta || pg_catalog.jsonb_build_object(
        pg_catalog.lower(record_type_id_value::text),
        pg_catalog.jsonb_build_object(
          'moduleRootId', module_root_value,
          'recordTypeId', record_type_id_value,
          'storageContractId', storage_contract_value,
          'storageScope', record_type_item ->> 'storageScope',
          'ownershipMode', record_type_item ->> 'ownershipMode',
          'isSystemProjection', record_type_item ? 'systemProjection',
          'releaseRevision', release_revision_value,
          'validationContractVersion', release_validation_contract_version,
          'table', catalogue_row.physical_table_token,
          'columns', columns_value,
          'valueExpression', value_expression,
          'fields', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'fieldId', declared.value -> 'fieldId',
                'type', declared.value -> 'type'
              ) || case
                when pg_catalog.jsonb_typeof(declared.value -> 'settings') = 'object'
                  then pg_catalog.jsonb_build_object('settings', declared.value -> 'settings')
                else '{}'::jsonb
              end
              order by declared.ordinality
            )
            from pg_catalog.jsonb_array_elements(record_type_item -> 'fields')
              with ordinality as declared(value, ordinality)
          ), '[]'::jsonb)
        ) || case
          when record_type_item ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', record_type_item -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
      );

      for relationship_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'relationships') as item(value)
      loop
        -- Every declared target, single or polymorphic, as one uniform list;
        -- Access proves a concrete edge target a member of it.
        relationship_by_id := relationship_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(relationship_item ->> 'relationshipId'),
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_item -> 'relationshipId',
            'fromModuleRootId', module_root_value,
            'fromRecordTypeId', record_type_item -> 'recordTypeId',
            'toRecordTypes', coalesce((
              select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'moduleRootId', target.value -> 'moduleRootId',
                'recordTypeId', target.value -> 'recordTypeId'
              ) order by target.ordinality)
              from pg_catalog.jsonb_array_elements(
                case when relationship_item ? 'toRecordType'
                  then pg_catalog.jsonb_build_array(relationship_item -> 'toRecordType')
                  else relationship_item -> 'toRecordTypes'
                end
              ) with ordinality as target(value, ordinality)
            ), '[]'::jsonb)
          )
        );
      end loop;
    end loop;

    for condition_item in
      select item.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'sharingConditions') = 'array'
            then release_content -> 'sharingConditions'
          else '[]'::jsonb
        end
      ) as item(value)
    loop
      condition_list := condition_list || pg_catalog.jsonb_build_array(condition_item);
    end loop;

    for permission_item in
      select item.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
            then release_content -> 'permissions'
          else '[]'::jsonb
        end
      ) as item(value)
    loop
      if pg_catalog.jsonb_typeof(permission_item -> 'recordScope') = 'object' then
        permission_by_id := permission_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(permission_item ->> 'permissionId'),
          pg_catalog.jsonb_build_object(
            'ownerKind', 'module',
            'ownerId', module_root_value,
            'recordTypeId', permission_item -> 'recordTypeId',
            'actionKind', permission_item -> 'actionKind',
            'namedAction', permission_item -> 'namedAction',
            'recordScope', permission_item -> 'recordScope'
          )
        );
      end if;
    end loop;
  end loop;

  select release.compilation_output #> '{canonical,content}'
  into strict release_content
  from vortex_definition.runtime_releases as release
  where release.root_id = application_root_id_value
    and release.release_revision = application_release_revision_value;

  for permission_item in
    select item.value
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
          then release_content -> 'permissions'
        else '[]'::jsonb
      end
    ) as item(value)
  loop
    if pg_catalog.jsonb_typeof(permission_item -> 'recordScope') = 'object' then
      permission_by_id := permission_by_id || pg_catalog.jsonb_build_object(
        pg_catalog.lower(permission_item ->> 'permissionId'),
        pg_catalog.jsonb_build_object(
          'ownerKind', 'application',
          'ownerId', application_root_id_value,
          'recordTypeId', permission_item -> 'recordTypeId',
          'actionKind', permission_item -> 'actionKind',
          'namedAction', permission_item -> 'namedAction',
          'recordScope', permission_item -> 'recordScope'
        )
      );
    end if;
  end loop;

  plan := pg_catalog.jsonb_build_object(
    'organizationId', organization_id_value,
    'applicationRootId', application_root_id_value,
    'applicationReleaseRevision', application_release_revision_value,
    'recordTypes', type_meta,
    'relationships', relationship_by_id,
    'sharingConditions', condition_list,
    'permissions', permission_by_id
  ) || case when preview_installation_id_value is not null
    then pg_catalog.jsonb_build_object(
      'previewInstallationId', preview_installation_id_value
    )
    else '{}'::jsonb end;

  if not cacheable then
    return plan;
  end if;

  -- A concurrent builder may have stored the same plan first. Both were built
  -- from the same immutable pins, so either row is the same plan; this call's
  -- own plan is returned when that row is not yet visible to its snapshot.
  insert into vortex_record.installation_access_plans (
    plan_key, organization_id, application_root_id,
    application_release_revision, plan
  ) values (
    plan_key_value, organization_id_value, application_root_id_value,
    application_release_revision_value, plan
  )
  on conflict (plan_key) do nothing;

  select stored.plan into cached_plan
  from vortex_record.installation_access_plans as stored
  where stored.plan_key = plan_key_value;
  return coalesce(cached_plan, plan);
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.resolve_installation_access_plan_internal(jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.resolve_installation_access_plan_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.resolve_installation_access_plan_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_record.resolve_installation_access_plan_internal(jsonb) is
  'Private installation access plan builder and cache: resolves definitions, column maps, permission alternatives and saved conditions once per all-active installation binding revision; a detached pin set is resolved afresh.';

create or replace function vortex_record.resolve_record_action_context_internal(
  p_record_type_id uuid,
  p_action_kind text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  application_root_id_value uuid;
  installation jsonb;
  preview_installation jsonb;
  preview_installation_id_value uuid;
  binding_item jsonb;
  module_content jsonb;
  application_content jsonb;
  module_root_id_value uuid;
  module_release_revision_value bigint;
  record_type_value jsonb;
  candidate_record_type_value jsonb;
  release_storage_contract_id uuid;
  target_module_root_id uuid;
  target_release_revision bigint;
  target_storage_contract_id uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  field_item jsonb;
  field_mapping vortex_record.field_storage_mappings%rowtype;
  columns_value jsonb := '{}'::jsonb;
  required_permissions jsonb := '[]'::jsonb;
  permission_item jsonb;
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore') then
    raise exception using errcode = '22023', message = 'Record action selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record action requires an application context';
  end if;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null then
    if preview_installation ->> 'outcome' = 'refused'
      or p_action_kind not in ('create', 'read', 'update') then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    installation := preview_installation;
    preview_installation_id_value :=
      (preview_installation ->> 'previewInstallationId')::uuid;
  else
    installation := vortex_definition.read_current_active_installation();
  end if;

  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  loop
    module_root_id_value := (binding_item ->> 'moduleRootId')::uuid;
    module_release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;
    select release.record_content into strict module_content
    from vortex_definition.runtime_releases as release
    where release.root_id = module_root_id_value
      and release.release_revision = module_release_revision_value;

    select item.value into candidate_record_type_value
    from pg_catalog.jsonb_array_elements(module_content -> 'recordTypes') as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
    if found then
      if target_module_root_id is not null then
        raise exception using errcode = '55000',
          message = 'Installed record type identity is ambiguous';
      end if;
      target_module_root_id := module_root_id_value;
      target_release_revision := module_release_revision_value;
      record_type_value := candidate_record_type_value;
      release_storage_contract_id := (record_type_value ->> 'storageContractId')::uuid;
      target_storage_contract_id := release_storage_contract_id;
      if preview_installation_id_value is not null then
        select (binding.value ->> 'previewStorageContractId')::uuid
        into strict target_storage_contract_id
        from pg_catalog.jsonb_array_elements(installation -> 'storageIdentities')
          as binding(value)
        where (binding.value ->> 'moduleRootId')::uuid = target_module_root_id
          and (binding.value ->> 'moduleReleaseRevision')::bigint = target_release_revision
          and (binding.value ->> 'recordTypeId')::uuid = p_record_type_id
          and (binding.value ->> 'releaseStorageContractId')::uuid = release_storage_contract_id;
        if not found then
          return pg_catalog.jsonb_build_object('outcome', 'refused');
        end if;
      end if;
      for permission_item in
        select item.value
        from pg_catalog.jsonb_array_elements(
          coalesce(module_content -> 'permissions', '[]'::jsonb)
        ) as item(value)
        where (item.value ->> 'recordTypeId')::uuid = p_record_type_id
          and item.value ->> 'actionKind' = p_action_kind
          and (item.value ->> 'namedAction') is null
      loop
        required_permissions := required_permissions || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'applicationRootId', application_root_id_value,
            'ownerKind', 'module', 'ownerId', target_module_root_id,
            'permissionId', (permission_item ->> 'permissionId')::uuid
          )
        );
      end loop;
    end if;
  end loop;

  if target_module_root_id is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = target_storage_contract_id;
  if not found or catalogue_row.state <> 'active'
    or catalogue_row.module_root_id <> target_module_root_id
    or catalogue_row.record_type_id <> p_record_type_id
    or catalogue_row.storage_scope is distinct from (record_type_value ->> 'storageScope')
    or (preview_installation_id_value is null
      and catalogue_row.physical_schema_token not in ('record_data', 'system_projection'))
    or (preview_installation_id_value is not null
      and catalogue_row.physical_schema_token <> 'record_data')
    or (catalogue_row.physical_schema_token = 'system_projection')
      is distinct from (record_type_value ? 'systemProjection')
    or (catalogue_row.physical_schema_token = 'system_projection'
      and catalogue_row.protected_read_model_key
        is distinct from (record_type_value #>> '{systemProjection,protectedView}'))
    or (catalogue_row.physical_schema_token = 'system_projection'
      and not coalesce(
        (record_type_value #> '{standardActions}') ? p_action_kind,
        false
      ))
    or (preview_installation_id_value is null and not exists (
      select 1 from vortex_record.release_provisions as provision
      where provision.module_root_id = target_module_root_id
        and provision.release_revision = target_release_revision
        and release_storage_contract_id = any (provision.storage_contract_ids)
    )) then
    raise exception using errcode = '55000',
      message = 'Record storage disagrees with the active installation';
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
  loop
    select mapping.* into field_mapping
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = target_storage_contract_id
      and mapping.field_id = (field_item ->> 'fieldId')::uuid;
    if not found or field_mapping.state <> 'active' then
      raise exception using errcode = '55000',
        message = 'Record field storage disagrees with the active installation';
    end if;
    columns_value := columns_value || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'),
      pg_catalog.jsonb_build_object(
        'token', field_mapping.physical_column_token,
        'databaseValueType', field_mapping.database_value_type,
        'type', field_item ->> 'type',
        'required', field_item -> 'required',
        'settings', field_item -> 'settings'
      )
    );
  end loop;

  select release.record_content into strict application_content
  from vortex_definition.runtime_releases as release
  where release.root_id = application_root_id_value
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;
  for permission_item in
    select item.value
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'permissions', '[]'::jsonb)
    ) as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id
      and item.value ->> 'actionKind' = p_action_kind
      and (item.value ->> 'namedAction') is null
  loop
    required_permissions := required_permissions || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', application_root_id_value,
        'ownerKind', 'application', 'ownerId', application_root_id_value,
        'permissionId', (permission_item ->> 'permissionId')::uuid
      )
    );
  end loop;

  required_permissions := coalesce((
    select pg_catalog.jsonb_agg(item.value order by
      item.value ->> 'ownerKind' collate "C", item.value ->> 'permissionId' collate "C")
    from pg_catalog.jsonb_array_elements(required_permissions) as item(value)
  ), '[]'::jsonb);

  return pg_catalog.jsonb_build_object(
    'context', context_value,
    'recordType', record_type_value,
    'moduleRootId', target_module_root_id,
    'moduleReleaseRevision', target_release_revision,
    'storageContractId', target_storage_contract_id,
    'storageScope', record_type_value ->> 'storageScope',
    'table', catalogue_row.physical_table_token,
    'columns', columns_value,
    'declaration', case when preview_installation_id_value is not null
      then pg_catalog.jsonb_build_object(
        'operationKey', 'record.' || p_action_kind,
        'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
        'target', pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', application_root_id_value
        ),
        'requiredPermissions', required_permissions,
        'recordBinding', pg_catalog.jsonb_build_object(
          'moduleRootId', target_module_root_id,
          'recordTypeId', p_record_type_id,
          'storageContractId', target_storage_contract_id,
          'storageScope', record_type_value ->> 'storageScope'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'preview_owner')
      )
      when pg_catalog.jsonb_array_length(required_permissions) = 0 then null
      else pg_catalog.jsonb_build_object(
        'operationKey', 'record.' || p_action_kind,
        'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
        'target', pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', application_root_id_value
        ),
        'requiredPermissions', required_permissions,
        'recordBinding', pg_catalog.jsonb_build_object(
          'moduleRootId', target_module_root_id,
          'recordTypeId', p_record_type_id,
          'storageContractId', target_storage_contract_id,
          'storageScope', record_type_value ->> 'storageScope'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      ) end
  ) || case when preview_installation_id_value is not null
    then pg_catalog.jsonb_build_object(
      'previewInstallationId', preview_installation_id_value
    )
    else '{}'::jsonb end;
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed definition evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed definition evidence is ambiguous';
end
$function$;
alter function vortex_record.resolve_record_action_context_internal(uuid,text) owner to vortex_record_adapter;


alter function vortex_record.resolve_record_action_context_internal(uuid, text)
  owner to vortex_record_adapter;

revoke all on function vortex_record.resolve_record_action_context_internal(uuid, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.resolve_record_action_context_internal(uuid, text) is
  'Private Record metadata resolver over one exact live installation or an owner-validated, unexpired preview storage binding; preview contexts support only reads and base record changes.';

create or replace function vortex_record.prepare_base_record_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  installation jsonb;
  application_content jsonb;
  unsupported boolean := false;
  context_value jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  effective_command_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  receipt_claim jsonb;
  projection jsonb;
  decision jsonb;
  bounds jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    )) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', effective_command_id, true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_id_value
      );
    end if;
    projection := vortex_record.read_record(
      p_record_type_id, (receipt_claim ->> 'recordId')::uuid
    );
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', correlation_id_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  );
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
    or (preview_installation is not null and meta ? 'recordType'
      and meta -> 'recordType' ? 'systemProjection') then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  installation := case when preview_installation is null
    then vortex_definition.read_current_active_installation()
    else preview_installation end;

  select release.record_content
  into strict application_content
  from vortex_definition.runtime_releases as release
  where release.root_id = (meta -> 'context' ->> 'applicationRootId')::uuid
    and release.release_revision =
      (installation ->> 'applicationReleaseRevision')::bigint;

  unsupported := exists (
    select 1
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as field(value)
    where field.value ->> 'type' = 'total'
  ) or exists (
    -- #578: Record evaluates the owning Module release's rules (`beforeSaveRules`);
    -- an Application rule on this record type cannot be evaluated and refuses.
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'rules', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
      pg_catalog.lower(p_record_type_id::text)
  );

  if unsupported then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported',
      'correlationId', meta -> 'context' -> 'correlationId'
    );
  end if;

  if meta -> 'recordType' ? 'systemProjection' then
    if p_operation <> 'update'
      or meta #>> '{recordType,key}' <> 'organization_settings'
      or meta #>> '{recordType,systemProjection,protectedView}' <>
        'organization_runtime_settings'
      or not coalesce(
        (meta #> '{recordType,standardActions}') ? 'update', false
      )
      or not vortex_definition.is_system_projection_module_internal(
        (meta ->> 'moduleRootId')::uuid, organization_id_value
      )
      or p_record_id is distinct from
        (meta -> 'context' ->> 'organizationId')::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;

    -- Do not execute application before-save rules for this projection until
    -- the platform settings-manage permission has passed its own current check.
    if not vortex_access.organization_runtime_settings_manage_is_current() then
      perform vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', organization_id_value,
        array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded',
        'correlationId', correlation_id_value
      );
    end if;

    -- The writable system projection is prepared through its protected read
    -- model. Its final write remains inside apply_record_changes.
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'read', p_record_id, null
    );
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_base_save_activity_internal(
          p_activity_id, 'update', organization_id_value,
          array[]::uuid[], 'refused'
        );
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    end if;
    bounds := bounds || pg_catalog.jsonb_build_object(
      'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
        loaded -> 'facts' -> 'recordTypes', p_record_type_id,
        bounds -> 'readableFieldIds'
      )
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'recordType', meta -> 'recordType',
      'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
        (meta ->> 'moduleRootId')::uuid,
        (meta ->> 'moduleReleaseRevision')::bigint,
        p_record_type_id
      ),
      'correlationId', correlation_id_value,
      'readableFieldIds', bounds -> 'readableFieldIds',
      'existingValues', loaded -> 'fieldValues'
    );
  end if;

  if p_operation = 'update' then
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if loaded ? 'previewInstallationId' then
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    else
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_base_save_activity_internal(
          p_activity_id, 'update', organization_id_value,
          array[]::uuid[], 'refused'
        );
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    end if;
    bounds := bounds || pg_catalog.jsonb_build_object(
      'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
        loaded -> 'facts' -> 'recordTypes', p_record_type_id,
        bounds -> 'readableFieldIds'
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'recordType', meta -> 'recordType',
    -- #578: the owning Module release's rules for this record type, evaluated by Record.
    'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'correlationId', meta -> 'context' -> 'correlationId',
    'readableFieldIds', case when p_operation = 'update'
      then bounds -> 'readableFieldIds' else '[]'::jsonb end,
    'existingValues', case when p_operation = 'update'
      then loaded -> 'fieldValues' else '{}'::jsonb end
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Record save preparation refused: % (%)', failure_message, failure_sqlstate;
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_base_record_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Server-only operation-scoped preparation read for one exact active installed or owner-validated preview base Record save.';

create or replace function vortex_record.resolve_preview_module_query_internal(
  p_module_root_id uuid,
  p_query_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  installation jsonb;
  module_bindings jsonb;
  storage_identities jsonb;
  preview_installation_id uuid;
  query_binding jsonb;
  query_binding_count bigint;
  query_release_revision_text text;
  query_release_revision bigint;
  query_compilation_output jsonb;
  query_content jsonb;
  query_release_version text;
  query_validation_contract_version text;
  query_source_contract_version text;
  query_item jsonb;
  query_match_count bigint := 0;
  record_type_module_root_id_text text;
  record_type_module_root_id uuid;
  record_type_id_text text;
  record_type_id uuid;
  record_type_binding jsonb;
  record_type_binding_count bigint;
  record_type_release_revision_text text;
  record_type_release_revision bigint;
  record_type_compilation_output jsonb;
  record_type_content jsonb;
  record_type_validation_contract_version text;
  record_type_source_contract_version text;
  record_type_item jsonb;
  record_type_match_count bigint := 0;
  release_storage_contract_id_text text;
  release_storage_contract_id uuid;
  storage_identity jsonb;
  storage_identity_count bigint := 0;
  preview_storage_contract_id_text text;
  preview_storage_contract_id uuid;
  preview_storage_identity_count bigint;
  catalogue_row vortex_record.storage_catalogue%rowtype;
begin
  if p_module_root_id is null or p_module_root_id = nil_uuid
    or p_query_id is null or p_query_id = nil_uuid then
    return null;
  end if;

  -- The address is transaction-local. This helper validates the human actor,
  -- organisation account, Application, ownership and expiry before returning
  -- the pinned preview; a missing or refused address never selects live state.
  installation := vortex_record.read_current_preview_installation_internal();
  if installation is null
    or pg_catalog.jsonb_typeof(installation) is distinct from 'object'
    or installation ? 'outcome'
    or not coalesce(pg_catalog.pg_input_is_valid(
      installation ->> 'previewInstallationId', 'uuid'
    ), false) then
    return null;
  end if;
  preview_installation_id := (installation ->> 'previewInstallationId')::uuid;
  if preview_installation_id = nil_uuid then
    return null;
  end if;

  module_bindings := installation -> 'moduleBindings';
  storage_identities := installation -> 'storageIdentities';
  if pg_catalog.jsonb_typeof(module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_typeof(storage_identities) is distinct from 'array' then
    return null;
  end if;

  -- Resolve the query only through one exact Module pin in this preview.
  select pg_catalog.count(*)
  into query_binding_count
  from pg_catalog.jsonb_array_elements(module_bindings) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = p_module_root_id::text;
  if query_binding_count <> 1 then
    return null;
  end if;
  select item.value into query_binding
  from pg_catalog.jsonb_array_elements(module_bindings) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = p_module_root_id::text;
  if query_binding ->> 'state' is distinct from 'active' then
    return null;
  end if;
  query_release_revision_text := query_binding ->> 'moduleReleaseRevision';
  if not coalesce(pg_catalog.pg_input_is_valid(query_release_revision_text, 'bigint'), false) then
    return null;
  end if;
  query_release_revision := query_release_revision_text::bigint;
  if query_release_revision not between 1 and 9007199254740991 then
    return null;
  end if;

  select release.compilation_output, release.compilation_output #> '{canonical,content}',
    release.release_version, release.validation_contract_version,
    release.source_contract_version
  into query_compilation_output, query_content, query_release_version, query_validation_contract_version,
    query_source_contract_version
  from vortex_definition.runtime_releases as release
  where release.root_id = p_module_root_id
    and release.release_revision = query_release_revision;
  if not found
    or query_validation_contract_version is distinct from '3.0.0'
    or query_source_contract_version is distinct from query_validation_contract_version
    or query_compilation_output #>> '{kind}' is distinct from 'module'
    or query_compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or query_compilation_output #>> '{validationContractVersion}'
      is distinct from query_validation_contract_version
    or pg_catalog.jsonb_typeof(query_content -> 'queries') is distinct from 'array' then
    return null;
  end if;

  for query_item in
    select item.value
    from pg_catalog.jsonb_array_elements(query_content -> 'queries') as item(value)
    where pg_catalog.lower(item.value ->> 'queryId') = p_query_id::text
  loop
    query_match_count := query_match_count + 1;
  end loop;
  if query_match_count <> 1 then
    return null;
  end if;
  select item.value into query_item
  from pg_catalog.jsonb_array_elements(query_content -> 'queries') as item(value)
  where pg_catalog.lower(item.value ->> 'queryId') = p_query_id::text;
  if pg_catalog.jsonb_typeof(query_item) is distinct from 'object'
    or query_item #>> '{recordType,state}' is distinct from 'resolved' then
    return null;
  end if;

  record_type_module_root_id_text := query_item #>> '{recordType,moduleRootId}';
  record_type_id_text := query_item #>> '{recordType,recordTypeId}';
  if not coalesce(pg_catalog.pg_input_is_valid(record_type_module_root_id_text, 'uuid'), false)
    or not coalesce(pg_catalog.pg_input_is_valid(record_type_id_text, 'uuid'), false) then
    return null;
  end if;
  record_type_module_root_id := record_type_module_root_id_text::uuid;
  record_type_id := record_type_id_text::uuid;
  if record_type_module_root_id = nil_uuid or record_type_id = nil_uuid then
    return null;
  end if;

  -- The referenced record type may be in a dependency, but that dependency
  -- must also have one active pin in this same preview installation.
  select pg_catalog.count(*)
  into record_type_binding_count
  from pg_catalog.jsonb_array_elements(module_bindings) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = record_type_module_root_id::text;
  if record_type_binding_count <> 1 then
    return null;
  end if;
  select item.value into record_type_binding
  from pg_catalog.jsonb_array_elements(module_bindings) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = record_type_module_root_id::text;
  if record_type_binding ->> 'state' is distinct from 'active' then
    return null;
  end if;
  record_type_release_revision_text := record_type_binding ->> 'moduleReleaseRevision';
  if not coalesce(pg_catalog.pg_input_is_valid(record_type_release_revision_text, 'bigint'), false) then
    return null;
  end if;
  record_type_release_revision := record_type_release_revision_text::bigint;
  if record_type_release_revision not between 1 and 9007199254740991 then
    return null;
  end if;

  if record_type_module_root_id = p_module_root_id then
    if record_type_release_revision <> query_release_revision then
      return null;
    end if;
    record_type_compilation_output := query_compilation_output;
    record_type_content := query_content;
    record_type_validation_contract_version := query_validation_contract_version;
    record_type_source_contract_version := query_source_contract_version;
  else
    select release.compilation_output, release.compilation_output #> '{canonical,content}',
      release.validation_contract_version, release.source_contract_version
    into record_type_compilation_output, record_type_content, record_type_validation_contract_version,
      record_type_source_contract_version
    from vortex_definition.runtime_releases as release
    where release.root_id = record_type_module_root_id
      and release.release_revision = record_type_release_revision;
    if not found then
      return null;
    end if;
  end if;
  if record_type_validation_contract_version not in ('2.0.0', '3.0.0')
    or record_type_source_contract_version is distinct from record_type_validation_contract_version
    or record_type_compilation_output #>> '{kind}' is distinct from 'module'
    or record_type_compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from record_type_module_root_id::text
    or record_type_compilation_output #>> '{validationContractVersion}'
      is distinct from record_type_validation_contract_version
    or pg_catalog.jsonb_typeof(record_type_content -> 'recordTypes') is distinct from 'array' then
    return null;
  end if;

  for record_type_item in
    select item.value
    from pg_catalog.jsonb_array_elements(record_type_content -> 'recordTypes') as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId') = record_type_id::text
  loop
    record_type_match_count := record_type_match_count + 1;
  end loop;
  if record_type_match_count <> 1 then
    return null;
  end if;
  select item.value into record_type_item
  from pg_catalog.jsonb_array_elements(record_type_content -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = record_type_id::text;
  if pg_catalog.jsonb_typeof(record_type_item) is distinct from 'object'
    or pg_catalog.jsonb_typeof(record_type_item -> 'fields') is distinct from 'array'
    or not coalesce(pg_catalog.pg_input_is_valid(
      record_type_item ->> 'storageContractId', 'uuid'
    ), false) then
    return null;
  end if;
  release_storage_contract_id_text := record_type_item ->> 'storageContractId';
  release_storage_contract_id := release_storage_contract_id_text::uuid;
  if release_storage_contract_id = nil_uuid then
    return null;
  end if;

  -- Match one storage identity against both exact release pins and the
  -- declaration's release storage contract; duplicates or malformed mappings
  -- never choose an arbitrary preview table.
  for storage_identity in
    select item.value
    from pg_catalog.jsonb_array_elements(storage_identities) as item(value)
    where pg_catalog.jsonb_typeof(item.value) = 'object'
      and pg_catalog.lower(item.value ->> 'moduleRootId') = record_type_module_root_id::text
      and item.value ->> 'moduleReleaseRevision' = record_type_release_revision::text
      and pg_catalog.lower(item.value ->> 'recordTypeId') = record_type_id::text
      and pg_catalog.lower(item.value ->> 'releaseStorageContractId') = release_storage_contract_id::text
  loop
    storage_identity_count := storage_identity_count + 1;
  end loop;
  if storage_identity_count <> 1 then
    return null;
  end if;
  select item.value into storage_identity
  from pg_catalog.jsonb_array_elements(storage_identities) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = record_type_module_root_id::text
    and item.value ->> 'moduleReleaseRevision' = record_type_release_revision::text
    and pg_catalog.lower(item.value ->> 'recordTypeId') = record_type_id::text
    and pg_catalog.lower(item.value ->> 'releaseStorageContractId') = release_storage_contract_id::text;
  preview_storage_contract_id_text := storage_identity ->> 'previewStorageContractId';
  if not coalesce(pg_catalog.pg_input_is_valid(preview_storage_contract_id_text, 'uuid'), false) then
    return null;
  end if;
  preview_storage_contract_id := preview_storage_contract_id_text::uuid;
  if preview_storage_contract_id = nil_uuid then
    return null;
  end if;
  select pg_catalog.count(*)
  into preview_storage_identity_count
  from pg_catalog.jsonb_array_elements(storage_identities) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'previewStorageContractId')
      = preview_storage_contract_id::text;
  if preview_storage_identity_count <> 1 then
    return null;
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = preview_storage_contract_id;
  if not found
    or catalogue_row.state is distinct from 'active'
    or catalogue_row.physical_schema_token is distinct from 'record_data'
    or catalogue_row.module_root_id is distinct from record_type_module_root_id
    or catalogue_row.record_type_id is distinct from record_type_id
    or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
    or catalogue_row.first_compatible_release_revision is distinct from record_type_release_revision
    or catalogue_row.last_compatible_release_revision is distinct from record_type_release_revision
    or catalogue_row.record_type_definition ->> 'storageContractId'
      is distinct from preview_storage_contract_id::text
    or pg_catalog.lower(catalogue_row.record_type_definition ->> 'recordTypeId')
      is distinct from record_type_id::text
    or catalogue_row.record_type_definition ->> 'storageScope'
      is distinct from (record_type_item ->> 'storageScope') then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', preview_installation_id,
    'moduleRootId', p_module_root_id,
    'moduleReleaseRevision', query_release_revision,
    'moduleReleaseVersion', query_release_version,
    'query', query_item,
    'recordTypeId', record_type_id,
    'recordTypeModuleRootId', record_type_module_root_id,
    'recordTypeModuleReleaseRevision', record_type_release_revision,
    'releaseStorageContractId', release_storage_contract_id,
    'previewStorageContractId', preview_storage_contract_id,
    'storageScope', record_type_item ->> 'storageScope',
    'recordType', record_type_item
  );
end
$function$;
alter function vortex_record.resolve_preview_module_query_internal(uuid,uuid) owner to vortex_record_adapter;


alter function vortex_record.resolve_preview_module_query_internal(uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.resolve_preview_module_query_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.resolve_preview_module_query_internal(uuid, uuid)
  to vortex_record_adapter;
comment on function vortex_record.resolve_preview_module_query_internal(uuid, uuid) is
  'Private preview-only resolver for one query and its exact pinned record type and active preview storage identity; it validates the current human-owned unexpired preview and never falls back to an active installation.';

create or replace function vortex_record.relationship_total_catalogue_internal()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  installation jsonb;
  binding jsonb;
  content jsonb;
  record_types jsonb := '[]'::jsonb;
  relationships jsonb := '[]'::jsonb;
  has_installed_rules boolean := false;
  rule_subject_record_type_ids jsonb := '[]'::jsonb;
  application_rule_subject_record_type_ids jsonb := '[]'::jsonb;
  record_type jsonb;
begin
  installation := vortex_definition.read_current_active_installation();
  for binding in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') item(value)
    order by item.value ->> 'moduleRootId'
  loop
    begin
      select release.compilation_output #> '{canonical,content}' into strict content
      from vortex_definition.runtime_releases release
      where release.root_id = (binding ->> 'moduleRootId')::uuid
        and release.release_revision = (binding ->> 'moduleReleaseRevision')::bigint;
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_MODULE_RELEASE_LOOKUP_FAILED',
          detail = pg_catalog.format('root=%s revision=%s cause=%s',
            binding ->> 'moduleRootId', binding ->> 'moduleReleaseRevision', sqlstate);
    end;
    if pg_catalog.jsonb_typeof(content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000', message = 'Installed Record definitions are unavailable';
    end if;
    has_installed_rules := has_installed_rules or
      pg_catalog.jsonb_array_length(coalesce(content -> 'rules', '[]'::jsonb)) > 0;
    rule_subject_record_type_ids := rule_subject_record_type_ids || coalesce((
      select pg_catalog.jsonb_agg(distinct rule.value -> 'subjectRecordTypeId')
      from pg_catalog.jsonb_array_elements(coalesce(content -> 'rules', '[]'::jsonb)) rule(value)
      where rule.value ->> 'profile' = 'before_save'
    ), '[]'::jsonb);
    record_types := record_types || coalesce((
      select pg_catalog.jsonb_agg(
        item.value || pg_catalog.jsonb_build_object(
          'moduleReleaseRevision', binding -> 'moduleReleaseRevision'
        )
        order by item.value ->> 'recordTypeId'
      )
      from pg_catalog.jsonb_array_elements(content -> 'recordTypes') item(value)
    ), '[]'::jsonb);
    for record_type in
      select item.value from pg_catalog.jsonb_array_elements(content -> 'recordTypes') item(value)
    loop
      relationships := relationships || coalesce(record_type -> 'relationships', '[]'::jsonb);
    end loop;
  end loop;
  begin
    select release.compilation_output #> '{canonical,content}' into strict content
    from vortex_definition.runtime_releases release
    where release.root_id = (installation ->> 'applicationRootId')::uuid
      and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;
  exception
    when no_data_found or too_many_rows then
      raise exception using errcode = '55000',
        message = 'RELATIONSHIP_TOTAL_APPLICATION_RELEASE_LOOKUP_FAILED',
        detail = pg_catalog.format('root=%s revision=%s cause=%s',
          installation ->> 'applicationRootId',
          installation ->> 'applicationReleaseRevision', sqlstate);
  end;
  has_installed_rules := has_installed_rules or
    pg_catalog.jsonb_array_length(coalesce(content -> 'rules', '[]'::jsonb)) > 0;
  rule_subject_record_type_ids := rule_subject_record_type_ids || coalesce((
    select pg_catalog.jsonb_agg(distinct rule.value -> 'subjectRecordTypeId')
    from pg_catalog.jsonb_array_elements(coalesce(content -> 'rules', '[]'::jsonb)) rule(value)
    where rule.value ->> 'profile' = 'before_save'
  ), '[]'::jsonb);
  application_rule_subject_record_type_ids := coalesce((
    select pg_catalog.jsonb_agg(distinct rule.value -> 'subjectRecordTypeId')
    from pg_catalog.jsonb_array_elements(coalesce(content -> 'rules', '[]'::jsonb)) rule(value)
    where rule.value ->> 'profile' = 'before_save'
  ), '[]'::jsonb);
  return pg_catalog.jsonb_build_object(
    'recordTypes', record_types,
    'relationships', relationships,
    'hasInstalledRules', has_installed_rules,
    'ruleSubjectRecordTypeIds', rule_subject_record_type_ids,
    'applicationRuleSubjectRecordTypeIds', application_rule_subject_record_type_ids
  );
end
$function$;

alter function vortex_record.relationship_total_catalogue_internal() owner to vortex_record_adapter;

revoke all on function vortex_record.relationship_total_catalogue_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.relationship_total_catalogue_internal()
  to vortex_record_adapter;
comment on function vortex_record.relationship_total_catalogue_internal() is
  'Private relationship-total catalogue for the validated human Application request context.';

CREATE OR REPLACE FUNCTION vortex_record.before_save_rules_for_record_type_internal(p_module_root_id uuid, p_module_release_revision bigint, p_record_type_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  release_content jsonb;
begin
  if p_module_root_id is null or p_module_release_revision is null
    or p_record_type_id is null then
    raise exception using errcode = '22023', message = 'Before-save rule selector is invalid';
  end if;
  select release.record_content
  into strict release_content
  from vortex_definition.runtime_releases as release
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision;
  return pg_catalog.jsonb_build_object(
    'moduleRootId', p_module_root_id,
    'releaseRevision', p_module_release_revision,
    'rules', coalesce((
      select pg_catalog.jsonb_agg(item.value order by item.value ->> 'ruleId')
      from pg_catalog.jsonb_array_elements(
        coalesce(release_content -> 'rules', '[]'::jsonb)
      ) as item(value)
      where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
        pg_catalog.lower(p_record_type_id::text)
    ), '[]'::jsonb)
  );
end
$$;
alter function vortex_record.before_save_rules_for_record_type_internal(uuid,bigint,uuid) owner to vortex_record_adapter;


COMMENT ON FUNCTION vortex_record.before_save_rules_for_record_type_internal(p_module_root_id uuid, p_module_release_revision bigint, p_record_type_id uuid) IS 'Private save step: returns the exact Module release identity and every rule of that release whose subject is the given record type, read from the immutable release row the save already resolved.';

REVOKE ALL ON FUNCTION vortex_record.before_save_rules_for_record_type_internal(p_module_root_id uuid, p_module_release_revision bigint, p_record_type_id uuid) FROM PUBLIC;

create or replace function vortex_record.prepare_module_query_internal(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_user_filter jsonb,
  p_declared_filterable_field_ids jsonb,
  p_stage text default 'complete',
  p_prior_plan jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  trivial_condition constant jsonb :=
    '{"kind":"comparison","operator":"is_empty","left":{"source":"value","value":null}}'::jsonb;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  field_kind text;
  semantic_type text;
  filter_condition jsonb;
  filter_exact boolean := false;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_field_columns jsonb := '{}'::jsonb;
  filter_field_database_types jsonb := '{}'::jsonb;
  filter_read_time_expressions jsonb := '{}'::jsonb;
  filter_plan jsonb;
  filter_predicate text;
  filter_parameters jsonb := '[]'::jsonb;
  user_filter jsonb;
  user_filter_ids text[] := array[]::text[];
  input_item jsonb;
  input_key text;
  input_value jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  access_plan record;
  readable_field_ids text[] := array[]::text[];
  declared_filterable_ids text[] := array[]::text[];
  parsed_ids text[] := array[]::text[];
  filterable_item jsonb;
  prepared_plan jsonb;
  preview_address text;
  preview_context jsonb;
  preview_installation_id uuid;
  preview_candidate_revision bigint;
  preview_candidate_revision_text text;
  preview_storage_contract_id uuid;
  preview_field_bounds jsonb;
  preview_field_mappings jsonb := '{}'::jsonb;
  preview_mode boolean := false;
  failure_sqlstate text;
  failure_message text;
begin
  if p_stage not in ('resolution', 'storage', 'complete') then
    raise exception using errcode = '22023', message = 'Invalid query preparation stage';
  end if;
  preview_address := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  preview_mode := preview_address is not null;
  if preview_mode then
    begin
      preview_context := vortex_record.read_current_preview_installation_internal();
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview installation): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
    preview_candidate_revision_text := preview_context ->> 'applicationReleaseRevision';
    if preview_context is null
      or pg_catalog.jsonb_typeof(preview_context) is distinct from 'object'
      or preview_context ? 'outcome'
      or not vortex_platform.is_non_nil_uuid(preview_context ->> 'previewInstallationId')
      or not coalesce(pg_catalog.pg_input_is_valid(preview_candidate_revision_text, 'bigint'), false) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
    preview_installation_id := (preview_context ->> 'previewInstallationId')::uuid;
    preview_candidate_revision := preview_candidate_revision_text::bigint;
    if preview_candidate_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  end if;
  if p_prior_plan is not null then
    prepared_plan := p_prior_plan;
    if preview_mode then
      if pg_catalog.jsonb_typeof(prepared_plan) is distinct from 'object'
        or prepared_plan ->> 'outcome' is distinct from 'prepared'
        or not (prepared_plan ? 'preview') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      begin
        context_value := vortex_access.validated_human_request_context();
        resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
      exception
        -- A refused access context or a stale preview is the expected refusal; any
        -- other failure is logged with its cause before the same safe refusal.
        when sqlstate '42501' or sqlstate '40001' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        when others then
          get stacked diagnostics failure_sqlstate = returned_sqlstate,
            failure_message = message_text;
          raise warning 'Query preview preparation failed (preview context): SQLSTATE %, %',
            failure_sqlstate, failure_message;
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end;
      if context_value is null or not (context_value ? 'applicationRootId') or resolved is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      context_organization_id := (context_value ->> 'organizationId')::uuid;
      context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
      if p_expected_release_revision is not null
        and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
      end if;
      if preview_context ->> 'organizationId' is distinct from context_organization_id::text
        or preview_context ->> 'applicationRootId' is distinct from context_application_root_id::text
        or prepared_plan #>> '{scope,organizationId}' is distinct from context_organization_id::text
        or prepared_plan #>> '{scope,applicationRootId}' is distinct from context_application_root_id::text
        or prepared_plan -> 'preview' is distinct from pg_catalog.jsonb_build_object(
          'previewInstallationId', preview_installation_id,
          'candidateRevision', preview_candidate_revision
        )
        or prepared_plan -> 'resolved' is distinct from resolved
        or prepared_plan -> 'query' is distinct from resolved -> 'query'
        or prepared_plan -> 'recordType' is distinct from resolved -> 'recordType'
        or prepared_plan ->> 'recordTypeId' is distinct from resolved ->> 'recordTypeId' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'resolved', resolved,
        'query', resolved -> 'query',
        'recordType', resolved -> 'recordType',
        'recordTypeId', resolved -> 'recordTypeId',
        'scope', pg_catalog.jsonb_build_object(
          'organizationId', context_organization_id,
          'applicationRootId', context_application_root_id
        )
      );
      -- A previous stage's physical tokens and field bounds are reusable only
      -- after this invocation re-reads the exact preview catalogue and bounds.
      prepared_plan := prepared_plan - 'storage' - 'readableFieldIds' - 'access'
        - 'filterFieldIds' - 'filter';
    elsif prepared_plan ? 'preview' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    else
      resolved := prepared_plan -> 'resolved';
      context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
      context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;
    end if;
    user_filter := prepared_plan -> 'userFilter';
    if user_filter = 'null'::jsonb then
      user_filter := null;
    end if;
    select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
    into declared_filterable_ids
    from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'declaredFilterableIds') as item(value);
  else
  if p_input_values is null or pg_catalog.jsonb_typeof(p_input_values) <> 'object'
    or (p_expected_release_revision is not null
      and p_expected_release_revision not between 1 and 9007199254740991) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_declared_filterable_field_ids is null then
    p_declared_filterable_field_ids := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_declared_filterable_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_declared_filterable_field_ids) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for filterable_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_declared_filterable_field_ids) as item(value)
  loop
    if pg_catalog.jsonb_typeof(filterable_item) <> 'string'
      or pg_catalog.lower(filterable_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(filterable_item #>> '{}') = any (parsed_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(filterable_item #>> '{}'));
  end loop;
  declared_filterable_ids := parsed_ids;

  if p_user_filter = 'null'::jsonb then
    p_user_filter := null;
  end if;
  if p_user_filter is not null
    and pg_catalog.jsonb_typeof(p_user_filter) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_filter := p_user_filter;
  -- The verified organisation and Application; never a caller value.
  if preview_mode then
    begin
      context_value := vortex_access.validated_human_request_context();
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview context): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
    if context_value is null or not (context_value ? 'applicationRootId') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  else
    context_value := vortex_access.validated_human_request_context();
    if not (context_value ? 'applicationRootId') then
      raise exception using errcode = '42501', message = 'Query requires an application context';
    end if;
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  if preview_mode and (
    preview_context ->> 'organizationId' is distinct from context_organization_id::text
    or preview_context ->> 'applicationRootId' is distinct from context_application_root_id::text
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;

  if preview_mode then
    begin
      resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview query): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
  else
    resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
  end if;
  if resolved is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  if p_expected_release_revision is not null
    and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
  end if;
  end if;
  query_item := resolved -> 'query';
  record_type_item := resolved -> 'recordType';
  record_type_id_value := (resolved ->> 'recordTypeId')::uuid;
  -- A preview reads its copy of the records with their stored totals and calculations; a system
  -- projection is read only through its protected reader, never from a preview.
  if preview_mode and record_type_item ? 'systemProjection' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if prepared_plan is null then
    prepared_plan := pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'resolved', resolved,
      'query', query_item,
      'recordType', record_type_item,
      'recordTypeId', record_type_id_value,
      'userFilter', user_filter,
      'declaredFilterableIds', pg_catalog.to_jsonb(declared_filterable_ids),
      'scope', pg_catalog.jsonb_build_object(
        'organizationId', context_organization_id,
        'applicationRootId', context_application_root_id
      )
    );
    if preview_mode then
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'preview', pg_catalog.jsonb_build_object(
          'previewInstallationId', preview_installation_id,
          'candidateRevision', preview_candidate_revision
        )
      );
    end if;
  end if;
  if p_stage = 'resolution' then
    return prepared_plan;
  end if;

  if prepared_plan ? 'storage' and not preview_mode then
    catalogue_row.storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
    select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
    into readable_field_ids
    from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);
  else
    if preview_mode then
      preview_storage_contract_id := (resolved ->> 'previewStorageContractId')::uuid;
      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = preview_storage_contract_id;
      if not found
        or catalogue_row.state is distinct from 'active'
        or catalogue_row.physical_schema_token is distinct from 'record_data'
        or catalogue_row.module_root_id is distinct from (resolved ->> 'recordTypeModuleRootId')::uuid
        or catalogue_row.record_type_id is distinct from record_type_id_value
        or catalogue_row.storage_scope is distinct from (resolved ->> 'storageScope')
        or catalogue_row.first_compatible_release_revision is distinct from
          (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        or catalogue_row.last_compatible_release_revision is distinct from
          (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        or catalogue_row.record_type_definition ->> 'storageContractId'
          is distinct from preview_storage_contract_id::text
        or pg_catalog.lower(catalogue_row.record_type_definition ->> 'recordTypeId')
          is distinct from record_type_id_value::text
        or catalogue_row.record_type_definition ->> 'storageScope'
          is distinct from (resolved ->> 'storageScope') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;

      preview_field_bounds := vortex_record.preview_record_field_bounds_internal(
        record_type_id_value, preview_storage_contract_id, record_type_item
      );
      if preview_field_bounds is null
        or pg_catalog.jsonb_typeof(preview_field_bounds -> 'readableFieldIds') is distinct from 'array' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
        where not exists (
          select 1
          from vortex_record.field_storage_mappings as mapping
          where mapping.storage_contract_id = preview_storage_contract_id
            and mapping.field_id = pg_catalog.lower(field.value ->> 'fieldId')::uuid
            and mapping.state is not distinct from 'active'
            and mapping.field_definition is not distinct from field.value
            and mapping.physical_column_token is not distinct from
              ('f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''))
            and mapping.database_value_type is not distinct from
              vortex_record.database_value_type(field.value)
            and mapping.introduced_by_module_root_id is not distinct from
              (resolved ->> 'recordTypeModuleRootId')::uuid
            and mapping.introduced_at_release_revision is not distinct from
              (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        )
      ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.lower(field.value ->> 'fieldId'),
        pg_catalog.to_jsonb(mapping)
        order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      ), '{}'::jsonb)
      into preview_field_mappings
      from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
      join vortex_record.field_storage_mappings as mapping
        on mapping.storage_contract_id = preview_storage_contract_id
        and mapping.field_id = pg_catalog.lower(field.value ->> 'fieldId')::uuid
        and mapping.state is not distinct from 'active';
      if prepared_plan ? 'fieldMappings'
        and prepared_plan -> 'fieldMappings' is distinct from preview_field_mappings then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;

      for field_item in
        select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), field_item
        );
      end loop;
      select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
      into readable_field_ids
      from pg_catalog.jsonb_array_elements_text(preview_field_bounds -> 'readableFieldIds') as item(value);
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'storage', pg_catalog.jsonb_build_object(
          'storageContractId', catalogue_row.storage_contract_id,
          'storageScope', catalogue_row.storage_scope,
          'moduleRootId', catalogue_row.module_root_id,
          'recordTypeId', catalogue_row.record_type_id,
          'physicalSchemaToken', catalogue_row.physical_schema_token,
          'physicalTableToken', catalogue_row.physical_table_token,
          'protectedReadModelKey', catalogue_row.protected_read_model_key
        ),
        'fieldMappings', preview_field_mappings,
        'readableFieldIds', pg_catalog.to_jsonb(readable_field_ids),
        'access', pg_catalog.jsonb_build_object(
          'predicate', 'true',
          'parameters', '[]'::jsonb,
          'ownerAccountId', null,
          'ownerGroupIds', '[]'::jsonb,
          'sharedRecordIds', '[]'::jsonb
        )
      );
    else
      -- The installed physical table for this exact record type.
      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = (record_type_item ->> 'storageContractId')::uuid;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> (resolved ->> 'recordTypeModuleRootId')::uuid
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token not in ('record_data', 'system_projection')
        or (catalogue_row.physical_schema_token = 'system_projection')
          is distinct from (record_type_item ? 'systemProjection')
        or (catalogue_row.physical_schema_token = 'system_projection'
          and catalogue_row.protected_read_model_key
            is distinct from (record_type_item #>> '{systemProjection,protectedView}')) then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;

      for field_item in
        select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), field_item
        );
      end loop;

      -- The read-scan plan. Its access routes narrow candidate rows before the
      -- budget is spent; its readable fields are the fields this reader is
      -- guaranteed to see on every row the scan examines, and none when the scan
      -- can examine a row the reader cannot read. Only those fields may drive the
      -- scan order, the pushed filter or the keyset cursor, because any other
      -- field could be withheld and its value must not influence which rows are
      -- examined. A planning failure propagates; it never widens the scan.
      select plan.* into access_plan
      from vortex_record.plan_record_read_scan_internal(record_type_id_value) as plan;
      readable_field_ids := coalesce(access_plan.readable_field_ids, array[]::text[]);
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'storage', pg_catalog.jsonb_build_object(
          'storageContractId', catalogue_row.storage_contract_id,
          'storageScope', catalogue_row.storage_scope,
          'moduleRootId', catalogue_row.module_root_id,
          'recordTypeId', catalogue_row.record_type_id,
          'physicalSchemaToken', catalogue_row.physical_schema_token,
          'physicalTableToken', catalogue_row.physical_table_token,
          'protectedReadModelKey', catalogue_row.protected_read_model_key
        ),
        'readableFieldIds', pg_catalog.to_jsonb(readable_field_ids),
        'access', pg_catalog.jsonb_build_object(
          'predicate', access_plan.access_predicate,
          'parameters', coalesce(access_plan.access_parameters, '[]'::jsonb),
          'ownerAccountId', access_plan.owner_account_id,
          'ownerGroupIds', pg_catalog.to_jsonb(coalesce(access_plan.owner_group_ids, array[]::uuid[])),
          'sharedRecordIds', pg_catalog.to_jsonb(coalesce(access_plan.shared_record_ids, array[]::uuid[]))
        )
      );
    end if;
  end if;
  if p_stage = 'storage' then
    return prepared_plan;
  end if;

  if fields_by_id = '{}'::jsonb then
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
    loop
      fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
        pg_catalog.lower(field_item ->> 'fieldId'), field_item
      );
    end loop;
  end if;
  -- Filter: the published condition tree over this record type's own fields, and,
  -- when supplied, the user's typed filter ANDed with it so it can only narrow.
  -- Every field the user's tree reads must be one the component declares
  -- filterable; the record type's own filterable flag is checked below for both.
  filter_condition := query_item -> 'filter';
  if filter_condition is not null and filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  if user_filter is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into user_filter_ids
    from pg_catalog.jsonb_path_query(
      user_filter, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    if exists (
      select 1 from pg_catalog.unnest(user_filter_ids) as referenced(id)
      where referenced.id <> pg_catalog.lower(referenced.id)
        or referenced.id <> all (declared_filterable_ids)
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end if;
    filter_condition := case
      when filter_condition is null then user_filter
      else pg_catalog.jsonb_build_object(
        'kind', 'all',
        'conditions', pg_catalog.jsonb_build_array(filter_condition, user_filter)
      )
    end;
  end if;
  if filter_condition is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into filter_ids
    from pg_catalog.jsonb_path_query(
      filter_condition, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    foreach field_key in array filter_ids loop
      -- Field values are keyed by lowercase identifier; so must the tree be.
      if field_key <> pg_catalog.lower(field_key) or not (fields_by_id ? field_key)
        or coalesce((fields_by_id -> field_key ->> 'filterable')::boolean, false) is not true then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      field_kind := fields_by_id -> field_key ->> 'type';
      if field_kind in ('calculation', 'total') then
        field_kind := fields_by_id -> field_key #>> '{settings,resultType}';
      end if;
      -- The exact (current Module contract) semantics of the saved-condition
      -- evaluator, so Query and database-backed conditions agree.
      semantic_type := case
        when field_kind = 'decimal_number' then 'decimal_number'
        when field_kind = 'money' then 'money'
        when field_kind = 'whole_number' then 'number'
        when field_kind = 'yes_no' then 'boolean'
        when field_kind = 'date' then 'date'
        when field_kind = 'date_time' then 'date_time'
        when field_kind = 'several_choices' then 'text_collection'
        when field_kind in ('table', 'attachment', 'formatted_text') then 'opaque_json'
        when field_kind in ('link', 'link_to_one_of_several') then 'record_reference'
        when field_kind = 'link_to_person' then 'organization_account_reference'
        when field_kind in (
          'text', 'long_text', 'choice', 'reference_number',
          'email_address', 'phone_number', 'web_address'
        ) then 'text'
        else null end;
      if semantic_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = catalogue_row.storage_contract_id
        and mapping.field_id = field_key::uuid;
      if not found or mapping_row.state is distinct from 'active' then
        if preview_mode then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end if;
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      filter_field_columns := filter_field_columns || pg_catalog.jsonb_build_object(
        field_key, mapping_row.physical_column_token
      );
      filter_field_database_types := filter_field_database_types || pg_catalog.jsonb_build_object(
        field_key, mapping_row.database_value_type
      );
      filter_types := filter_types || pg_catalog.jsonb_build_object(field_key, semantic_type);
      filter_nulls := filter_nulls || pg_catalog.jsonb_build_object(field_key, null::jsonb);
      read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
        and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
          or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
      if read_time_field then
        read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
        read_time_sql := vortex_record.read_time_deadline_expression_internal(
          catalogue_row.storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
          read_time_clock
        );
        if read_time_sql is null then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
        end if;
        filter_read_time_expressions := filter_read_time_expressions || pg_catalog.jsonb_build_object(
          field_key, read_time_sql
        );
        filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
          '%L, %s', field_key, pg_catalog.format('pg_catalog.to_jsonb(%s)', read_time_sql)
        ));
        continue;
      end if;
      -- The same canonical value text the record reader projects; references
      -- are compared by their identifier, as the condition engine defines.
      filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
        '%L, %s', field_key,
        case
          when semantic_type = 'record_reference' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.lower(stored.%I ->> ''recordId''))',
              mapping_row.physical_column_token)
          when semantic_type = 'organization_account_reference' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.lower(stored.%I ->> ''organizationAccountId''))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'decimal' then
            pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'timestamp_with_time_zone' then
            pg_catalog.format(
              'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.%I))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'date' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
              mapping_row.physical_column_token)
          else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', mapping_row.physical_column_token)
        end
      ));
    end loop;
  end if;

  -- Inputs: exactly the declared keys, required ones present, references
  -- reduced to their identifier. Types are checked by the condition bridge.
  for input_key in select supplied.key from pg_catalog.jsonb_object_keys(p_input_values) as supplied(key) loop
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
      where item.value ->> 'key' = input_key
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
  end loop;
  for input_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
  loop
    input_key := input_item ->> 'key';
    input_value := coalesce(p_input_values -> input_key, 'null'::jsonb);
    if input_value = 'null'::jsonb and (input_item ->> 'required')::boolean then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
    if input_value <> 'null'::jsonb and input_item ->> 'type' = 'record_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'recordId') ~ uuid_pattern, false)
        or not exists (
          select 1 from pg_catalog.jsonb_array_elements(input_item -> 'recordTypes') as allowed(value)
          where allowed.value ->> 'state' = 'resolved'
            and pg_catalog.lower(allowed.value ->> 'recordTypeId')
              = pg_catalog.lower(input_value ->> 'recordTypeId')
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
      input_value := pg_catalog.to_jsonb(pg_catalog.lower(input_value ->> 'recordId'));
    elsif input_value <> 'null'::jsonb and input_item ->> 'type' = 'organization_account_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['organizationAccountId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'organizationAccountId') ~ uuid_pattern, false) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
      input_value := pg_catalog.to_jsonb(pg_catalog.lower(input_value ->> 'organizationAccountId'));
    end if;
    parameter_types := parameter_types || pg_catalog.jsonb_build_object(input_key, case input_item ->> 'type'
      when 'formatted_text' then 'opaque_json'
      else input_item ->> 'type' end);
    parameter_values := parameter_values || pg_catalog.jsonb_build_object(input_key, input_value);
  end loop;
  begin
    perform vortex_access.evaluate_query_condition_internal(
      trivial_condition, '{}'::jsonb, '{}'::jsonb, parameter_types, parameter_values, true
    );
  exception when invalid_parameter_value then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
  end;
  if filter_condition is not null then
    begin
      perform vortex_access.evaluate_query_condition_internal(
        filter_condition, filter_types, filter_nulls, parameter_types, parameter_values, true
      );
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;

  -- The published filter is pushed into the candidate scan only when every
  -- field it reads is one the reader is guaranteed to see; otherwise it is
  -- evaluated per row, so which rows the budget examines can never depend on a
  -- value the reader cannot see.
  filter_predicate := 'true';
  if filter_condition is not null
    and not exists (
      select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
      where referenced.id <> all (readable_field_ids)
    ) then
    begin
      filter_plan := vortex_record.compile_query_filter_internal(
        filter_condition,
        filter_types,
        filter_field_columns,
        filter_field_database_types,
        fields_by_id,
        filter_read_time_expressions,
        parameter_types,
        parameter_values,
        9,
        0
      );
      filter_predicate := coalesce(filter_plan ->> 'predicate', 'true');
      filter_parameters := coalesce(filter_plan -> 'parameters', '[]'::jsonb);
      -- An incomplete compiled predicate remains a candidate narrowing step.
      filter_exact := filter_plan ->> 'predicate' is not null
        and (filter_plan ->> 'exact')::boolean is true;
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;
  return prepared_plan || pg_catalog.jsonb_build_object(
    'filterFieldIds', pg_catalog.to_jsonb(filter_ids),
    'filter', pg_catalog.jsonb_build_object(
      'residualCondition', filter_condition,
      'residualFieldTypes', filter_types,
      'residualNullValues', filter_nulls,
      'residualInputTypes', parameter_types,
      'residualInputs', parameter_values,
      'expressions', pg_catalog.to_jsonb(filter_expressions),
      'pushedPredicate', filter_predicate,
      'pushedExact', filter_exact,
      'pushedParameters', filter_parameters
    )
  );
end
$function$;

alter function vortex_record.prepare_module_query_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb,text,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb)
  to vortex_owner;

comment on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb) is
  'Shared owner-only Module query preparation for list and summary reads: derives organisation and application authority from validated_human_request_context(), resolves one installed query or the exact current human-owned preview pins, revalidates preview prior plans, exact active field mappings and preview catalogue/field bounds without using the installed read-scan routes, validates declared inputs and the published filter narrowed by the declared user filter, and returns the exact access predicate, pushed filter and residual per-row condition with bound inputs; it never accepts authority or identity from caller values.';

create or replace function vortex_record.run_module_query(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids jsonb,
  p_page_size integer,
  p_after jsonb,
  p_requested_system_field_keys jsonb,
  p_user_inputs jsonb,
  p_direction text,
  p_exact_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- The most candidate rows one request examines. A page that the budget ends
  -- early still returns a position, so a later request resumes exactly there.
  scan_limit constant integer := 500;
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  prepared_plan jsonb;
  storage_plan jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  v_storage_contract_id uuid;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  selected_ids text[];
  requested_ids text[] := array[]::text[];
  sort_item jsonb;
  sort_ids text[] := array[]::text[];
  declared_sort_ids text[] := array[]::text[];
  cursor_sort jsonb := '[]'::jsonb;
  sort_directions text[] := array[]::text[];
  scan_directions text[] := array[]::text[];
  sort_value_sql text[] := array[]::text[];
  sort_sql_types text[] := array[]::text[];
  filter_condition jsonb;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_predicate text;
  filter_exact boolean;
  filter_parameters jsonb := '[]'::jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  after_sort_key text[];
  after_phase text;
  after_record_id uuid;
  sort_index integer;
  column_sql text;
  value_sql text;
  pushed boolean;
  after_terms text[] := array[]::text[];
  equal_prefix text := '';
  keyset_sql text := '';
  segment_predicates text[];
  segment_sql text;
  segment_prefix text;
  prefix_index integer;
  composite_sort jsonb;
  composite_index_ready boolean := false;
  record_id_direction text := 'ascending';
  scan_record_id_direction text := 'ascending';
  -- Whether each sort key has the aligned field index (stored and sortable or unique).
  sort_index_backed boolean[] := array[]::boolean[];
  sort_stored boolean[] := array[]::boolean[];
  order_terms text[] := array[]::text[];
  sort_key_terms text[] := array[]::text[];
  order_by_sql text;
  scan_sql text;
  read_row record;
  page_access_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_eligibility_checked boolean := false;
  validated_record_types jsonb;
  readable_field_ids text[] := array[]::text[];
  access_sql text;
  access_parameters jsonb := '[]'::jsonb;
  access_owner_account_id uuid;
  access_owner_group_ids uuid[] := array[]::uuid[];
  access_shared_record_ids uuid[] := array[]::uuid[];
  physical_table_token text;
  storage_scope text;
  scan_source_sql text;
  scan_projection_sql text := 'null::jsonb';
  projection_page_scan boolean := false;
  projection_sort_key text;
  projection_batch jsonb;
  projection_after jsonb; projection_batch_size integer;
  projection_candidate_count integer := 0; projection_reader_exhausted boolean := false;
  projection_batch_exhausted boolean := false;
  projection_last_record_id uuid;
  projection_last_sort_key text[];
  scan_record record;
  scan_cursor refcursor;
  cursor_position integer;
  lookahead_record record;
  lookahead_ids uuid[];
  page_first_loaded jsonb;
  -- What every row of the page shares, built once in this invocation: the
  -- validated active installation, the facts envelope and the read-time inputs.
  page_shared jsonb; page_narrowed boolean;
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  page_batching boolean := true;
  examined integer := 0;
  budget_exhausted boolean := false;
  more_rows boolean := false;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  capability_rows jsonb[] := array[]::jsonb[];
  page_capabilities jsonb;
  rows_value jsonb := '[]'::jsonb;
  row_count integer := 0;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  last_returned_sort_key text[];
  last_returned_record_id uuid;
  first_returned_sort_key text[];
  first_returned_record_id uuid;
  next_value jsonb := null;
  opposite_value jsonb := null;
  system_field_keys text[] := array[]::text[];
  system_key text;
  system_expressions text[] := array[]::text[];
  system_columns_sql text;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  list_key text;
  declared_list jsonb;
  parsed_ids text[];
  declared_lists jsonb := '{}'::jsonb;
  declared_sortable_ids text[] := array[]::text[];
  declared_searchable_ids text[] := array[]::text[];
  user_sort jsonb;
  user_search text;
  user_search_folded text;
  effective_sort jsonb;
  effective_sort_is_user boolean := false;
  search_candidate_ids text[] := array[]::text[];
  search_field_ids text[] := array[]::text[];
  search_matches boolean;
  board_member_mode boolean := false;
  group_member_mode boolean := false;
  board_member jsonb;
  board_choice_field_id text;
  board_column_kind text;
  board_column_value text;
  board_options jsonb;
  board_option_values text[] := array[]::text[];
  board_option jsonb;
  board_member_matches boolean;
  -- Every board column this call reads: one for a member page, every displayed
  -- column for a board's first pages, each read in its own pass below.
  board_columns_mode boolean := false;
  board_columns jsonb := '[]'::jsonb;
  board_column_item jsonb;
  board_column_position integer := 0;
  board_column_pages jsonb := '[]'::jsonb;
  -- The stored choice column, when the reader is guaranteed to see the choice
  -- field on every scanned row, and the current column's candidate predicate.
  board_choice_column text;
  board_scan_sql text := '';
  group_member jsonb;
  group_selector jsonb;
  group_selector_values jsonb := '{}'::jsonb;
  group_selector_types jsonb := '{}'::jsonb;
  group_candidate_values jsonb;
  group_by_ids text[] := array[]::text[];
  group_key text;
  group_field_type text;
  group_member_matches boolean;
  preview_mode boolean := false;
begin
  -- Request shape. Nothing here is authority; it only bounds the work.
  if p_direction not in ('forward', 'backward') or p_direction is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_requested_field_ids is null
    or pg_catalog.jsonb_typeof(p_requested_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_field_ids) not between 1 and 200
    or p_page_size is null or p_page_size not between 1 and 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in select item.value from pg_catalog.jsonb_array_elements(p_requested_field_ids) as item(value) loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(field_item #>> '{}') = any (requested_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    requested_ids := pg_catalog.array_append(requested_ids, pg_catalog.lower(field_item #>> '{}'));
  end loop;
  -- Declared system values: a closed set, each named at most once.
  if p_requested_system_field_keys is null then
    p_requested_system_field_keys := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_requested_system_field_keys) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_system_field_keys) > 5 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(p_requested_system_field_keys) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or (field_item #>> '{}') not in ('created_at', 'created_by', 'updated_at', 'updated_by', 'owner')
      or (field_item #>> '{}') = any (system_field_keys) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    system_field_keys := pg_catalog.array_append(system_field_keys, field_item #>> '{}');
  end loop;
  -- User-facing sort and search, plus the user filter passed to shared
  -- preparation. The component's declared field sets only narrow user input;
  -- they never supply authority or replace the published query contract.
  if p_user_inputs is null then
    p_user_inputs := '{}'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_user_inputs) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  board_member_mode := p_user_inputs ? 'boardMember';
  board_columns_mode := p_user_inputs ? 'boardColumns';
  group_member_mode := p_user_inputs ? 'groupMember';
  if (board_member_mode and group_member_mode)
    or (board_columns_mode and (board_member_mode or group_member_mode)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- A board's first pages: every requested column, each from its start.
  if board_columns_mode and (p_direction <> 'forward' or p_exact_record_id is not null
    or (p_after is not null and p_after <> 'null'::jsonb)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  board_member_mode := board_member_mode or board_columns_mode;
  if exists (
    select 1 from pg_catalog.jsonb_object_keys(p_user_inputs) as supplied(key)
    where supplied.key not in (
      'sort', 'filter', 'search', 'sortableFieldIds', 'filterableFieldIds', 'searchableFieldIds',
      'boardMember', 'boardColumns', 'groupMember'
    )
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if group_member_mode then
    group_member := vortex_record.group_member_selector_internal(p_user_inputs -> 'groupMember');
    if group_member is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    group_selector := p_user_inputs #> '{groupMember,values}';
    group_selector_types := group_member -> 'types';
    group_selector_values := group_member -> 'values';
  end if;
  if board_member_mode then
    board_member := vortex_record.board_column_selector_internal(
      p_user_inputs -> case when board_columns_mode then 'boardColumns' else 'boardMember' end,
      board_columns_mode
    );
    if board_member is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_choice_field_id := board_member ->> 'choiceFieldId';
    board_columns := board_member -> 'columns';
  end if;
  -- The list-only sortable and searchable allow-lists contain distinct field
  -- identities. Query preparation validates the filterable allow-list.
  for list_key in
    select pg_catalog.unnest(array['sortableFieldIds', 'searchableFieldIds'])
  loop
    declared_list := coalesce(p_user_inputs -> list_key, '[]'::jsonb);
    if pg_catalog.jsonb_typeof(declared_list) <> 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    if pg_catalog.jsonb_array_length(declared_list) > 200 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := array[]::text[];
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(declared_list) as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) <> 'string'
        or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
        or pg_catalog.lower(field_item #>> '{}') = any (parsed_ids) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(field_item #>> '{}'));
    end loop;
    declared_lists := declared_lists || pg_catalog.jsonb_build_object(list_key, pg_catalog.to_jsonb(parsed_ids));
  end loop;
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_sortable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'sortableFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_searchable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'searchableFieldIds') as item(value);
  -- The user's sort: the same pair shape as the published sort, bounded and each
  -- direction valid. It replaces the published order only when it is non-empty.
  user_sort := coalesce(p_user_inputs -> 'sort', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(user_sort) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if pg_catalog.jsonb_array_length(user_sort) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- The user's search: one bounded, non-blank text term; a blank term is absent.
  if p_user_inputs ? 'search'
    and pg_catalog.jsonb_typeof(p_user_inputs -> 'search') not in ('string', 'null') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search := pg_catalog.btrim(p_user_inputs ->> 'search');
  if user_search = '' then
    user_search := null;
  end if;
  if user_search is not null and pg_catalog.length(user_search) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search_folded := pg_catalog.lower(user_search);
  -- An exact record id resolves one identity; the search only narrows pages of a list, so it is
  -- ignored here while the published filter and the viewer's authority still apply unchanged.
  if p_exact_record_id is not null then
    user_search := null;
    user_search_folded := null;
  end if;
  if (board_member_mode or group_member_mode) and (
    pg_catalog.jsonb_array_length(user_sort) <> 0
    or user_search is not null
    or pg_catalog.cardinality(declared_sortable_ids) <> 0
    or pg_catalog.cardinality(declared_searchable_ids) <> 0
    or (group_member_mode and p_user_inputs ? 'search'
      and pg_catalog.jsonb_typeof(p_user_inputs -> 'search') is distinct from 'null')
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  foreach system_key in array system_field_keys loop
    system_expressions := pg_catalog.array_append(system_expressions, pg_catalog.format('%L, %s', system_key,
      case system_key
        when 'created_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.created_at))'
        when 'updated_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.updated_at))'
        when 'created_by' then 'pg_catalog.to_jsonb(stored.created_by)'
        when 'updated_by' then 'pg_catalog.to_jsonb(stored.updated_by)'
        else
          'case when stored.owner_organisation_account_id is not null then pg_catalog.jsonb_build_object(''kind'', ''organization_account'', ''organizationAccountId'', stored.owner_organisation_account_id) when stored.owner_group_id is not null then pg_catalog.jsonb_build_object(''kind'', ''group'', ''groupId'', stored.owner_group_id) else ''null''::jsonb end'
      end));
  end loop;
  system_columns_sql := pg_catalog.array_to_string(system_expressions, ', ');
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'resolution', null
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  resolved := prepared_plan -> 'resolved';
  query_item := prepared_plan -> 'query';
  record_type_item := prepared_plan -> 'recordType';
  record_type_id_value := (prepared_plan ->> 'recordTypeId')::uuid;
  context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
  context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;
  preview_mode := prepared_plan ? 'preview';
  if p_exact_record_id is not null and record_type_item ? 'systemProjection' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;
  -- Grouped and totalled shapes are not plain rows. Only separately validated
  -- board and generic group member modes may read members from those Queries.
  if pg_catalog.jsonb_typeof(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) is distinct from 'array'
    or pg_catalog.jsonb_typeof(coalesce(query_item -> 'aggregates', '[]'::jsonb)) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if group_member_mode then
    if pg_catalog.jsonb_array_length(query_item -> 'groupByFieldIds') not between 1 and 10 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(query_item -> 'groupByFieldIds') as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) is distinct from 'string'
        or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
        or pg_catalog.lower(field_item #>> '{}') = '00000000-0000-0000-0000-000000000000' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      group_key := pg_catalog.lower(field_item #>> '{}');
      group_field_type := coalesce(fields_by_id -> group_key ->> 'type', '');
      if group_key = any (group_by_ids)
        or group_field_type not in (
          'text', 'whole_number', 'decimal_number', 'yes_no', 'date', 'date_time',
          'choice', 'reference_number', 'email_address', 'phone_number', 'web_address',
          'link', 'link_to_one_of_several', 'link_to_person'
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      group_by_ids := pg_catalog.array_append(group_by_ids, group_key);
    end loop;
    if pg_catalog.jsonb_array_length(group_selector) <> pg_catalog.cardinality(group_by_ids)
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(group_selector_types) as supplied(key)
        where supplied.key <> all (group_by_ids)
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    foreach group_key in array group_by_ids loop
      if group_selector_types ->> group_key is distinct from fields_by_id -> group_key ->> 'type' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
    end loop;
  elsif board_member_mode then
    if pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 1 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  elsif pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 0
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if p_page_size > coalesce((query_item ->> 'pageSize')::integer, 0) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'page_size_invalid');
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'storage', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  storage_plan := prepared_plan;
  v_storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
  preview_mode := prepared_plan ? 'preview';
  physical_table_token := prepared_plan #>> '{storage,physicalTableToken}';
  storage_scope := prepared_plan #>> '{storage,storageScope}';
  access_sql := prepared_plan #>> '{access,predicate}';
  if access_sql is null then
    raise exception using errcode = '55000',
      message = 'Prepared record query has no access predicate';
  end if;
  access_parameters := coalesce(prepared_plan #> '{access,parameters}', '[]'::jsonb);
  access_owner_account_id := nullif(prepared_plan #>> '{access,ownerAccountId}', '')::uuid;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,sharedRecordIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);
  -- Search authority: the record type's own declared search priority. A component
  -- with only a search box declares no per-field list, so an empty declared set
  -- searches every field the record type marks searchable; a declared set narrows
  -- it. A row matches only through a field the reader can see on that row, so a
  -- hidden searchable value never decides a match.
  if pg_catalog.cardinality(declared_searchable_ids) > 0 then
    search_candidate_ids := declared_searchable_ids;
  else
    select coalesce(pg_catalog.array_agg(item.key), array[]::text[])
    into search_candidate_ids
    from pg_catalog.jsonb_object_keys(fields_by_id) as item(key);
  end if;
  foreach field_key in array search_candidate_ids loop
    if (fields_by_id ? field_key)
      and (fields_by_id -> field_key ->> 'searchPriority') in ('first', 'normal', 'last') then
      search_field_ids := pg_catalog.array_append(search_field_ids, field_key);
    end if;
  end loop;
  -- Projection: only fields the published query selects.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into selected_ids
  from pg_catalog.jsonb_array_elements(query_item -> 'selectedFieldIds') as item(value);
  if exists (select 1 from pg_catalog.unnest(requested_ids) as requested(id) where requested.id <> all (selected_ids)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;
  if board_member_mode then
    if pg_catalog.lower(query_item #>> '{groupByFieldIds,0}') is distinct from board_choice_field_id
      or not (board_choice_field_id = any (selected_ids))
      or not (fields_by_id ? board_choice_field_id)
      or fields_by_id -> board_choice_field_id ->> 'type' is distinct from 'choice'
      or coalesce((fields_by_id -> board_choice_field_id ->> 'filterable')::boolean, false) is not true then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_options := fields_by_id #> array[board_choice_field_id, 'settings', 'options'];
    if pg_catalog.jsonb_typeof(board_options) is distinct from 'array'
      or pg_catalog.jsonb_array_length(board_options) not between 1 and 12 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for board_option in select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value) loop
      if pg_catalog.jsonb_typeof(board_option) is distinct from 'object'
        or board_option - array['value', 'label', 'requiredPermissionId']::text[] <> '{}'::jsonb
        or not (board_option ? 'value') or not (board_option ? 'label')
        or pg_catalog.jsonb_typeof(board_option -> 'value') is distinct from 'string'
        or coalesce(pg_catalog.length(board_option ->> 'value'), 0) not between 1 and 120
        or pg_catalog.jsonb_typeof(board_option -> 'label') is distinct from 'string'
        or coalesce(pg_catalog.length(pg_catalog.btrim(board_option ->> 'label')), 0) not between 1 and 60
        or (board_option ? 'requiredPermissionId' and (
          pg_catalog.jsonb_typeof(board_option -> 'requiredPermissionId') is distinct from 'string'
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') !~ uuid_pattern
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') = '00000000-0000-0000-0000-000000000000'
        ))
        or (board_option ->> 'value') collate "C" = any (board_option_values) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      board_option_values := pg_catalog.array_append(board_option_values, board_option ->> 'value');
    end loop;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(board_columns) as requested(value)
      where requested.value ->> 'kind' = 'option'
        and not ((requested.value ->> 'value') collate "C" = any (board_option_values))
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    -- A column reads only its own cards. When the reader is guaranteed to see the
    -- choice field on every row the scan examines, the stored choice value is the
    -- readable value, so the column's membership narrows the candidate scan and the
    -- budget is spent on that column's members only. Otherwise the scan stays
    -- unnarrowed and membership is decided from each readable projection below, so
    -- a withheld value never decides which rows are examined.
    if board_choice_field_id = any (readable_field_ids) then
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = v_storage_contract_id
        and mapping.field_id = board_choice_field_id::uuid;
      if not found or mapping_row.state is distinct from 'active' then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      if mapping_row.database_value_type = 'text' then
        board_choice_column := mapping_row.physical_column_token;
      end if;
    end if;
  end if;
  -- Order: the published sort, or the user's chosen sort when one is supplied,
  -- over orderable typed columns, then the record id. A published sort field the
  -- reader is not guaranteed to see is validated but never pushed, so the scan
  -- order never depends on a value it may withhold. A user sort must instead be a
  -- field the component declares sortable, the record type declares sortable and
  -- the reader is guaranteed to see: silently ordering by something else would be
  -- wrong, so it is refused rather than pushed away.
  if board_member_mode or group_member_mode then
    effective_sort := '[]'::jsonb;
    effective_sort_is_user := false;
  elsif pg_catalog.jsonb_array_length(user_sort) > 0 then
    effective_sort := user_sort;
    effective_sort_is_user := true;
  else
    effective_sort := query_item -> 'sort';
    effective_sort_is_user := false;
  end if;
  for sort_item in
    select item.value from pg_catalog.jsonb_array_elements(effective_sort) as item(value)
  loop
    field_key := pg_catalog.lower(sort_item ->> 'fieldId');
    if field_key is null or not (fields_by_id ? field_key)
      or sort_item ->> 'direction' not in ('ascending', 'descending')
      or field_key = any (declared_sort_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if effective_sort_is_user
      and (not (field_key = any (declared_sortable_ids))
        or coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false) is not true) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = v_storage_contract_id
      and mapping.field_id = field_key::uuid;
    if not found or mapping_row.state is distinct from 'active' then
      if preview_mode then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    declared_sort_ids := pg_catalog.array_append(declared_sort_ids, field_key);
    pushed := field_key = any (readable_field_ids);
    cursor_sort := cursor_sort || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'fieldId', field_key, 'direction', sort_item ->> 'direction',
        'pushed', pushed
      )
    );
    if effective_sort_is_user and not pushed then
      -- The user's order must actually be the scan order.
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    -- A read-time field is worked out inside this statement, from the
    -- record's own stored values and one statement timestamp; it is never a
    -- stored column here.
    read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
      and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
        or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
    if read_time_field then
      read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
      read_time_sql := vortex_record.read_time_deadline_expression_internal(
        v_storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
        read_time_clock
      );
      if read_time_sql is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
      end if;
      if not pushed then
        continue;
      end if;
      sort_ids := pg_catalog.array_append(sort_ids, field_key);
      sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
      sort_value_sql := pg_catalog.array_append(sort_value_sql, read_time_sql);
      sort_sql_types := pg_catalog.array_append(sort_sql_types, 'boolean');
      sort_index_backed := pg_catalog.array_append(sort_index_backed, false);
      sort_stored := pg_catalog.array_append(sort_stored, false);
      continue;
    end if;
    -- JSON-valued fields (money, links, choice sets, documents) have no total
    -- order here; money in particular is never ordered across currencies.
    if mapping_row.database_value_type not in (
      'integer', 'decimal', 'boolean', 'date', 'timestamp_with_time_zone', 'text', 'uuid'
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if not pushed then
      continue;
    end if;
    sort_ids := pg_catalog.array_append(sort_ids, field_key);
    sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
    sort_value_sql := pg_catalog.array_append(
      sort_value_sql, pg_catalog.format('stored.%I', mapping_row.physical_column_token)
    );
    sort_index_backed := pg_catalog.array_append(sort_index_backed,
      coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false)
        or coalesce((fields_by_id -> field_key ->> 'unique')::boolean, false));
    sort_stored := pg_catalog.array_append(sort_stored, true);
    sort_sql_types := pg_catalog.array_append(sort_sql_types, case mapping_row.database_value_type
      when 'integer' then 'bigint'
      when 'decimal' then 'numeric'
      when 'boolean' then 'boolean'
      when 'date' then 'date'
      when 'timestamp_with_time_zone' then 'timestamp with time zone'
      when 'uuid' then 'uuid'
      else 'text' end);
  end loop;
  if pg_catalog.cardinality(declared_sort_ids) = 0
    and not board_member_mode and not group_member_mode then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
  end if;
  -- The tie-break direction is a property of the declared order, independent
  -- of whether its asynchronous physical index has finished building.
  if pg_catalog.cardinality(sort_ids) > 0 then
    record_id_direction := sort_directions[pg_catalog.cardinality(sort_ids)];
  end if;
  if pg_catalog.cardinality(sort_ids) > 1
    and pg_catalog.cardinality(sort_ids) = pg_catalog.cardinality(declared_sort_ids)
    and not (false = any (sort_stored)) then
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fieldId', sort_ids[item.position],
      'direction', sort_directions[item.position]) order by item.position)
    into composite_sort
    from pg_catalog.generate_series(1, pg_catalog.cardinality(sort_ids)) as item(position);
    select coalesce(index_value.indisvalid, false) into composite_index_ready
    from pg_catalog.pg_index as index_value
    where index_value.indexrelid = pg_catalog.to_regclass(pg_catalog.format(
      'record_data.%I', 'is_' || pg_catalog.md5(
        v_storage_contract_id::text || ':' || composite_sort::text)));
    composite_index_ready := coalesce(composite_index_ready, false);
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'complete', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  if preview_mode and (
    prepared_plan -> 'storage' is distinct from storage_plan -> 'storage'
    or prepared_plan -> 'fieldMappings' is distinct from storage_plan -> 'fieldMappings'
    or prepared_plan -> 'readableFieldIds' is distinct from storage_plan -> 'readableFieldIds'
    or prepared_plan -> 'access' is distinct from storage_plan -> 'access'
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  filter_condition := prepared_plan #> '{filter,residualCondition}';
  if filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  filter_types := coalesce(prepared_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  filter_nulls := coalesce(prepared_plan #> '{filter,residualNullValues}', '{}'::jsonb);
  parameter_types := coalesce(prepared_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values := coalesce(prepared_plan #> '{filter,residualInputs}', '{}'::jsonb);
  filter_predicate := coalesce(prepared_plan #>> '{filter,pushedPredicate}', 'true');
  filter_exact := (prepared_plan #>> '{filter,pushedExact}')::boolean is true;
  filter_parameters := coalesce(prepared_plan #> '{filter,pushedParameters}', '[]'::jsonb);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_expressions
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{filter,expressions}') as item(value);
  -- The keyset position must fit this exact order. The cursor binds every
  -- declared sort field, direction and whether it was pushed, but carries
  -- values only for readable sort fields. A changed readable subset cannot
  -- reinterpret an old key or put a hidden field value in a cursor.
  if p_after is not null and p_after <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or p_after - array['sortKey', 'phase', 'recordId', 'sort']::text[] <> '{}'::jsonb
      or p_after -> 'sort' is distinct from cursor_sort
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> pg_catalog.cardinality(sort_ids)
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or p_after ->> 'phase' not in ('null', 'value')
      or pg_catalog.lower(p_after ->> 'recordId') !~ uuid_pattern
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') as item(value)
        where pg_catalog.jsonb_typeof(item.value) not in ('string', 'null')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    select pg_catalog.array_agg(item.value #>> '{}' order by item.ordinality)
    into after_sort_key
    from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') with ordinality as item(value, ordinality);
    after_record_id := (p_after ->> 'recordId')::uuid;
    after_phase := p_after ->> 'phase';
    if after_phase is distinct from (case
      when pg_catalog.cardinality(sort_ids) > 0 and after_sort_key[1] is null then 'null'
      else 'value' end) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
      if after_sort_key[sort_index] is not null
        and not pg_catalog.pg_input_is_valid(after_sort_key[sort_index], sort_sql_types[sort_index]) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
      end if;
    end loop;
  end if;
  for sort_index in 1 .. pg_catalog.cardinality(sort_directions) loop
    scan_directions := pg_catalog.array_append(scan_directions,
      case when p_direction = 'forward' then sort_directions[sort_index]
        when sort_directions[sort_index] = 'ascending' then 'descending'
        else 'ascending' end);
  end loop;
  scan_record_id_direction := case when p_direction = 'forward' then record_id_direction
    when record_id_direction = 'ascending' then 'descending' else 'ascending' end;
  scan_source_sql := pg_catalog.format('record_data.%I as stored', physical_table_token);
  projection_page_scan := not preview_mode and record_type_item ? 'systemProjection'
    and coalesce(p_user_inputs -> 'filter', 'null'::jsonb) = 'null'::jsonb
    and coalesce(query_item -> 'filter', 'null'::jsonb) = 'null'::jsonb
    and user_search is null
    and not board_member_mode and not group_member_mode
    and pg_catalog.cardinality(sort_ids) = 1
    and pg_catalog.cardinality(declared_sort_ids) = 1
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        record_type_item #> '{systemProjection,sortableFieldIds}'
      ) as sortable(id)
      where pg_catalog.lower(sortable.id) = sort_ids[1]
    ) and vortex_record.has_bounded_system_projection_reader_internal(
      v_storage_contract_id, fields_by_id -> sort_ids[1] ->> 'key'
    );
  if projection_page_scan then
      projection_sort_key := fields_by_id -> sort_ids[1] ->> 'key';
      if projection_sort_key is null then
        raise exception using errcode = '55000',
          message = 'Protected projection sort field is unavailable';
      end if;
      projection_after := p_after;
      projection_batch_size := least(p_page_size + 1, scan_limit);
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
      into projection_batch
      from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
        null::uuid[], projection_sort_key, scan_directions[1], projection_after,
        projection_batch_size) with ordinality as projected(organization_id, record_id,
        revision, attribute_values, ordinality);
  end if;
  if projection_page_scan then
      -- The registered view contributes its row type only. The bounded reader
      -- supplies every candidate, including rows later rejected by the query.
      scan_source_sql := pg_catalog.format($source$
        pg_catalog.jsonb_to_recordset($11) as projection(
          organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
        )
        cross join lateral pg_catalog.jsonb_populate_record(
          null::record_data.%I,
          pg_catalog.jsonb_build_object(
            'organisation_id', projection.organization_id,
            'module_root_id', %L::uuid,
            'record_type_id', %L::uuid,
            'storage_contract_id', %L::uuid,
            'record_id', projection.record_id,
            'definition_revision', %L::bigint,
            'lifecycle_state', 'active',
            'concurrency_number', projection.revision
          ) || coalesce((
            select pg_catalog.jsonb_object_agg(
              'f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''),
              case
                when field.value ->> 'fieldId' = %L
                  then pg_catalog.to_jsonb(projection.organization_id::text)
                when field.value ->> 'fieldId' = %L
                  then pg_catalog.to_jsonb(projection.revision)
                else projection.attribute_values -> (field.value ->> 'key')
              end
            )
            from pg_catalog.jsonb_array_elements(%L::jsonb -> 'fields') as field(value)
          ), '{}'::jsonb)
        ) as stored$source$,
        physical_table_token, p_module_root_id, record_type_id_value,
        v_storage_contract_id, (resolved ->> 'moduleReleaseRevision')::bigint,
        record_type_item #>> '{systemProjection,organizationFieldId}',
        record_type_item #>> '{systemProjection,revisionFieldId}',
        record_type_item
      );
      scan_projection_sql := 'pg_catalog.to_jsonb(projection)';
  end if;
  -- The scan. Identifiers come only from the storage catalogue; every value is
  -- a bound parameter. Nulls order first ascending and last descending. The
  -- order always ends with the record id, so the keyset stays total even when
  -- no readable sort field may be pushed.
  for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
    column_sql := case when sort_sql_types[sort_index] = 'text'
      then sort_value_sql[sort_index] || ' collate "C"'
      else sort_value_sql[sort_index] end;
    order_terms := pg_catalog.array_append(order_terms, column_sql || case
      when scan_directions[sort_index] = 'ascending' then ' asc nulls first'
      else ' desc nulls last' end);
    sort_key_terms := pg_catalog.array_append(sort_key_terms, case sort_sql_types[sort_index]
      when 'timestamp with time zone' then pg_catalog.format(
        'vortex_platform.format_timestamp_utc(%s)',
        sort_value_sql[sort_index])
      when 'date' then pg_catalog.format(
        'pg_catalog.to_char(%s, ''YYYY-MM-DD'')', sort_value_sql[sort_index])
      else pg_catalog.format('(%s)::text', sort_value_sql[sort_index]) end);
    if after_record_id is not null then
      value_sql := case when sort_sql_types[sort_index] = 'text'
        then pg_catalog.format('$3[%s] collate "C"', sort_index)
        else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
      if after_sort_key[sort_index] is null then
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when scan_directions[sort_index] = 'ascending'
            then pg_catalog.format('(%s) is not null', sort_value_sql[sort_index])
          else 'false' end);
        equal_prefix := equal_prefix
          || pg_catalog.format('(%s) is null and ', sort_value_sql[sort_index]);
      else
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when scan_directions[sort_index] = 'ascending'
            then pg_catalog.format('coalesce(%s > %s, false)', column_sql, value_sql)
          else pg_catalog.format('((%s) is null or coalesce(%s < %s, false))',
            sort_value_sql[sort_index], column_sql, value_sql) end);
        equal_prefix := equal_prefix
          || pg_catalog.format('coalesce(%s = %s, false) and ', column_sql, value_sql);
      end if;
    end if;
  end loop;
  if after_record_id is not null then
    after_terms := pg_catalog.array_append(after_terms, equal_prefix ||
      'stored.record_id ' || case when scan_record_id_direction = 'ascending' then '>' else '<' end || ' $4');
    keyset_sql := ' and ((' || pg_catalog.array_to_string(after_terms, ') or (') || '))';
  end if;
  order_by_sql := pg_catalog.array_to_string(order_terms, ', ');
  if order_by_sql = '' then
    order_by_sql := 'stored.record_id ' ||
      case when scan_record_id_direction = 'ascending' then 'asc' else 'desc' end;
  else
    order_by_sql := order_by_sql || ', stored.record_id ' ||
      case when scan_record_id_direction = 'ascending' then 'asc' else 'desc' end;
  end if;
  if composite_index_ready then
    segment_predicates := array[]::text[];
    if after_record_id is null then
      segment_predicates := array[''];
    else
      -- A mixed-direction lexicographic comparison is one seek per first
      -- differing key. Each scan has an equality prefix and one B-tree range,
      -- including the NULL region in its own segment.
      segment_prefix := '';
      for prefix_index in 1 .. pg_catalog.cardinality(sort_ids) loop
        column_sql := case when sort_sql_types[prefix_index] = 'text'
          then sort_value_sql[prefix_index] || ' collate "C"'
          else sort_value_sql[prefix_index] end;
        if after_sort_key[prefix_index] is null then
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s is null', sort_value_sql[prefix_index]);
        else
          value_sql := case when sort_sql_types[prefix_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', prefix_index)
            else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s = %s', column_sql, value_sql);
        end if;
      end loop;
      segment_predicates := pg_catalog.array_append(segment_predicates,
        segment_prefix || ' and stored.record_id ' ||
        case when scan_record_id_direction = 'ascending' then '>' else '<' end || ' $4');
      for sort_index in reverse pg_catalog.cardinality(sort_ids) .. 1 loop
        segment_prefix := '';
        for prefix_index in 1 .. sort_index - 1 loop
          column_sql := case when sort_sql_types[prefix_index] = 'text'
            then sort_value_sql[prefix_index] || ' collate "C"'
            else sort_value_sql[prefix_index] end;
          if after_sort_key[prefix_index] is null then
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s is null', sort_value_sql[prefix_index]);
          else
            value_sql := case when sort_sql_types[prefix_index] = 'text'
              then pg_catalog.format('$3[%s] collate "C"', prefix_index)
              else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s = %s', column_sql, value_sql);
          end if;
        end loop;
        column_sql := case when sort_sql_types[sort_index] = 'text'
          then sort_value_sql[sort_index] || ' collate "C"'
          else sort_value_sql[sort_index] end;
        if after_sort_key[sort_index] is null then
          if scan_directions[sort_index] = 'ascending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is not null', sort_value_sql[sort_index]));
          end if;
        else
          value_sql := case when sort_sql_types[sort_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', sort_index)
            else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
          segment_predicates := pg_catalog.array_append(segment_predicates,
            segment_prefix || pg_catalog.format(' and %s %s %s', column_sql,
              case when scan_directions[sort_index] = 'ascending' then '>' else '<' end,
              value_sql));
          if scan_directions[sort_index] = 'descending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is null', sort_value_sql[sort_index]));
          end if;
        end if;
      end loop;
    end if;
  elsif pg_catalog.cardinality(sort_ids) = 1 and sort_index_backed[1] then
    -- Each segment has one contiguous range in the aligned index. A NULL
    -- cursor finishes its record-id range before the value range begins.
    if scan_directions[1] = 'ascending' then
      if after_record_id is null or after_phase = 'null' then
        segment_predicates := array[
          pg_catalog.format(' and %s is null%s', sort_value_sql[1],
            case when after_record_id is null then '' else ' and stored.record_id > $4' end),
          pg_catalog.format(' and %s is not null', sort_value_sql[1])
        ];
      else
        segment_predicates := array[pg_catalog.format(
          ' and %s is not null and (%s, stored.record_id) > (%s, $4)',
          sort_value_sql[1], column_sql, value_sql
        )];
      end if;
    elsif after_record_id is null then
      segment_predicates := array[
        pg_catalog.format(' and %s is not null', sort_value_sql[1]),
        pg_catalog.format(' and %s is null', sort_value_sql[1])
      ];
    elsif after_phase = 'value' then
      segment_predicates := array[
        pg_catalog.format(' and %s is not null and (%s, stored.record_id) < (%s, $4)',
          sort_value_sql[1], column_sql, value_sql),
        pg_catalog.format(' and %s is null', sort_value_sql[1])
      ];
    else
      segment_predicates := array[pg_catalog.format(
        ' and %s is null and stored.record_id < $4', sort_value_sql[1])];
    end if;
  else
    segment_predicates := array[keyset_sql];
  end if;
  if projection_page_scan then
    -- The bounded reader has already applied the sealed keyset and order.
    segment_predicates := array[''];
  end if;
  -- One pass per requested board column, each with its own page, budget and
  -- position; every other read makes exactly one pass. The page's access facts,
  -- eligibility and validated record types stay those of this one invocation.
  <<column_pass>>
  loop
  if board_member_mode then
    board_column_position := board_column_position + 1;
    exit column_pass when board_column_position > pg_catalog.jsonb_array_length(board_columns);
    board_column_item := board_columns -> (board_column_position - 1);
    board_column_kind := board_column_item ->> 'kind';
    board_column_value := board_column_item ->> 'value';
    board_scan_sql := case
      when board_choice_column is null then ''
      when board_column_kind = 'option' then pg_catalog.format(
        ' and stored.%I collate "C" = $13 collate "C"', board_choice_column)
      else pg_catalog.format(
        ' and (stored.%1$I is null or not (stored.%1$I collate "C" = any ($14::text[])))',
        board_choice_column)
    end;
    if board_column_position > 1 then
      examined := 0;
      budget_exhausted := false;
      more_rows := false;
      rows_value := '[]'::jsonb;
      row_count := 0;
      capability_rows := array[]::jsonb[];
      decided_ids := array[]::uuid[];
      decided_loaded := null;
      decided_decisions := null;
      decided_bounds := null;
      last_examined_sort_key := null;
      last_examined_record_id := null;
      last_returned_sort_key := null;
      last_returned_record_id := null;
      first_returned_sort_key := null;
      first_returned_record_id := null;
      next_value := null;
      opposite_value := null;
    end if;
  end if;
  foreach segment_sql in array segment_predicates loop
  loop
  if projection_page_scan then
    projection_candidate_count := projection_candidate_count + pg_catalog.jsonb_array_length(projection_batch);
    projection_reader_exhausted := pg_catalog.jsonb_array_length(projection_batch) < projection_batch_size;
    if pg_catalog.jsonb_array_length(projection_batch) = 0 then
      exit;
    end if;
    projection_last_record_id := (projection_batch -> -1 ->> 'record_id')::uuid;
    projection_last_sort_key := array[projection_batch -> -1 -> 'attribute_values' ->> projection_sort_key];
    projection_after := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(projection_last_sort_key),
      'phase', case when projection_last_sort_key[1] is null then 'null' else 'value' end,
      'recordId', projection_last_record_id);
    projection_batch_exhausted := projection_candidate_count >= scan_limit;
  end if;
  scan_sql := pg_catalog.format(
    'select stored.record_id,
       array[%s]::text[] as sort_key,
       pg_catalog.jsonb_build_object(%s) as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values,
       %s as projection_row
     from %s
     where stored.organisation_id = $1
       and stored.lifecycle_state = ''active''
       and ($12 is null or stored.record_id = $12)
       and %s
       and (%s)
        and (case when (%s) then true else false end)%s%s
     order by %s
     limit $5',
    pg_catalog.array_to_string(sort_key_terms, ', '),
    (select pg_catalog.string_agg(
       filter_chunk.pairs_text,
       ') || pg_catalog.jsonb_build_object(' order by filter_chunk.chunk_index
     )
     from (
       select (filter_pair.pair_number - 1) / 50 as chunk_index,
         pg_catalog.string_agg(
           filter_pair.pair_text, ', ' order by filter_pair.pair_number
         ) as pairs_text
       from pg_catalog.unnest(filter_expressions)
         with ordinality as filter_pair(pair_text, pair_number)
       group by (filter_pair.pair_number - 1) / 50
     ) as filter_chunk),
    system_columns_sql,
    scan_projection_sql,
    scan_source_sql,
    case when storage_scope = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    access_sql,
    filter_predicate,
    board_scan_sql,
    segment_sql,
    order_by_sql
  );
  -- A validated type set stays local to this invocation and is passed only to
  -- the fixed record adapter's private evaluator.
  open scan_cursor scroll for execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1, access_owner_account_id,
      access_owner_group_ids, access_shared_record_ids,
      filter_parameters, access_parameters, projection_batch, p_exact_record_id,
      board_column_value, board_option_values;
  cursor_position := 0;
  loop
    fetch scan_cursor into scan_record;
    exit when not found;
    cursor_position := cursor_position + 1;
    examined := examined + 1;
    if examined > scan_limit then
      budget_exhausted := true;
      exit;
    end if;
    -- The filter is evaluated on stored values first only to avoid reading
    -- rows it rejects; a row it admits is still read through the protected
    -- projection, and every filtered and sorted field must be readable there.
    -- A value the condition engine refuses decides nothing until the row is
    -- known to be readable, so an unreadable row can never cause a refusal.
    needs_refusal_check := false;
    -- Preparation has already validated the inputs. An exact SQL predicate
    -- has decided this condition over fields every candidate reader can see.
    if filter_condition is null or filter_exact then
      passes := true;
    else
      begin
        passes := vortex_access.evaluate_query_condition_internal(
          filter_condition, filter_types, scan_record.filter_values,
          parameter_types, parameter_values, false
        );
      exception when invalid_parameter_value then
        passes := true;
        needs_refusal_check := true;
      end;
    end if;
    if passes then
      page_access_loaded := null;
      if not preview_mode and not page_eligibility_checked then
        -- Keep the reusable decision in this invocation; the request role cannot
        -- write it or pass it to the owner-only exact-record evaluator.
        page_eligibility_checked := true;
        page_shared := pg_catalog.jsonb_build_object(
          'installation', vortex_definition.read_current_active_installation());
        page_access_loaded := vortex_record.load_record_access_facts_from_installation_internal(
          record_type_id_value, 'read', scan_record.record_id, null,
          page_shared -> 'installation', scan_record.projection_row
        );
        if page_access_loaded ->> 'outcome' = 'loaded'
          and pg_catalog.jsonb_typeof(page_access_loaded -> 'declaration') = 'object' then
          page_declaration := page_access_loaded -> 'declaration';
          page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
            page_declaration, vortex_access.validated_human_request_context(),
            pg_catalog.clock_timestamp()
          );
          page_first_loaded := page_access_loaded;
          select page_shared || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
            page.narrowed
          into page_shared, page_narrowed
          from vortex_record.read_record_page_envelope_internal(record_type_id_value, page_first_loaded) as page;
        end if;
      end if;
      -- Decide this candidate and the page's next ones together in one set
      -- pass; the cursor returns to this row, so the scan order, budget and
      -- every later check stay those of the row-by-row walk.
      if page_batching and page_first_loaded is not null
        and not (scan_record.record_id = any (decided_ids)) then
        lookahead_ids := array[scan_record.record_id];
        while pg_catalog.cardinality(lookahead_ids) <= p_page_size loop
          fetch scan_cursor into lookahead_record;
          exit when not found;
          lookahead_ids := pg_catalog.array_append(lookahead_ids, lookahead_record.record_id);
        end loop;
        move absolute cursor_position from scan_cursor;
        select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
          pg_catalog.array_agg(decided.loaded), pg_catalog.array_agg(decided.decision),
          pg_catalog.array_agg(decided.bounds)
        into decided_ids, decided_loaded, decided_decisions, decided_bounds
        from vortex_record.read_record_page_decisions_internal(
          record_type_id_value, page_first_loaded, page_declaration, page_eligibility,
          lookahead_ids, page_shared -> 'envelope', page_narrowed
        ) as decided;
        page_batching := pg_catalog.cardinality(decided_ids) > 0;
      end if;
      -- The page's first record keeps the exact decision, which also validates
      -- the installation-wide facts every decided record shares.
      decided_index := case when page_access_loaded is null
        then pg_catalog.array_position(decided_ids, scan_record.record_id) end;
      select row_read.* into read_row
      from vortex_record.read_record_projection_with_validated_types_internal(
        record_type_id_value, scan_record.record_id, page_declaration, page_eligibility,
        validated_record_types, scan_record.projection_row,
        coalesce(decided_loaded[decided_index], page_access_loaded),
        decided_decisions[decided_index], decided_bounds[decided_index], page_shared
      ) as row_read;
      projection := read_row.projection;
      -- Only the exact evaluator validates record types for reuse.
      if validated_record_types is null and decided_index is null then
        validated_record_types := coalesce(
          read_row.read_facts -> 'validatedRecordTypes',
          case when projection ->> 'outcome' = 'allowed'
            then read_row.read_facts #> '{facts,recordTypes}' end
        );
      end if;
      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        if not exists (
          select 1 from pg_catalog.unnest(declared_sort_ids || filter_ids) as referenced(id)
          where not (readable_values ? referenced.id)
        ) then
          if needs_refusal_check then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end if;
          -- A search term matches only through a searchable field this row exposes
          -- to the reader; a field the reader cannot see never decides a match, so
          -- a hidden value can neither satisfy a search nor be inferred from one.
          -- Only a text or number value, or the text members of a list value, is
          -- searched; a structured value's JSON keys and identifiers never match.
          if board_member_mode then
            if board_column_kind = 'option' then
              board_member_matches := (readable_values ? board_choice_field_id)
                and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                and (readable_values ->> board_choice_field_id) collate "C"
                  = board_column_value collate "C";
            else
              board_member_matches := not (
                (readable_values ? board_choice_field_id)
                and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                and (readable_values ->> board_choice_field_id) collate "C"
                  = any (board_option_values)
              );
            end if;
            if not board_member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if group_member_mode then
            group_member_matches := not exists (
              select 1 from pg_catalog.unnest(group_by_ids) as grouped(id)
              where not (readable_values ? grouped.id)
            );
            if group_member_matches then
              select pg_catalog.jsonb_object_agg(grouped.id, readable_values -> grouped.id)
              into group_candidate_values
              from pg_catalog.unnest(group_by_ids) as grouped(id);
              group_member_matches := group_candidate_values = group_selector_values;
            end if;
            if not group_member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if user_search is not null then
            search_matches := false;
            foreach field_key in array search_field_ids loop
              if readable_values ? field_key and (
                (pg_catalog.jsonb_typeof(readable_values -> field_key) in ('string', 'number')
                  and pg_catalog.strpos(
                    pg_catalog.lower(readable_values ->> field_key), user_search_folded
                  ) > 0)
                or (pg_catalog.jsonb_typeof(readable_values -> field_key) = 'array'
                  and exists (
                    select 1
                    from pg_catalog.jsonb_array_elements(readable_values -> field_key) as member(value)
                    where pg_catalog.jsonb_typeof(member.value) = 'string'
                      and pg_catalog.strpos(
                        pg_catalog.lower(member.value #>> '{}'), user_search_folded
                      ) > 0
                  ))
              ) then
                search_matches := true;
                exit;
              end if;
            end loop;
            if not search_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if row_count = p_page_size then
            more_rows := true;
            exit;
          end if;
          if row_count = 0 then
            first_returned_sort_key := scan_record.sort_key;
            first_returned_record_id := scan_record.record_id;
          end if;
          -- Keep the read facts and field bounds for one page-level capability
          -- decision after the readable page has been selected.
          capability_rows := pg_catalog.array_append(
            capability_rows,
            pg_catalog.jsonb_build_object(
              'recordId', scan_record.record_id, 'readBounds', read_row.read_bounds
            ) || case
              -- The page pass's compact record scope when it has one, also for
              -- the first record; its page-wide facts are the page envelope.
              when scan_record.record_id = any (decided_ids) then pg_catalog.jsonb_build_object('record',
                decided_loaded[pg_catalog.array_position(decided_ids, scan_record.record_id)])
              else pg_catalog.jsonb_build_object('readFacts', read_row.read_facts) end
          );
          rows_value := rows_value || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordId', scan_record.record_id,
            'revision', projection -> 'concurrencyNumber',
            'values', coalesce((
              select pg_catalog.jsonb_object_agg(requested.id, readable_values -> requested.id)
              from pg_catalog.unnest(requested_ids) as requested(id)
              where readable_values ? requested.id
            ), '{}'::jsonb)
          ) || case when pg_catalog.cardinality(system_field_keys) > 0
            then pg_catalog.jsonb_build_object('systemValues', scan_record.system_values)
            else '{}'::jsonb end);
          row_count := row_count + 1;
          last_returned_sort_key := scan_record.sort_key;
          last_returned_record_id := scan_record.record_id;
        end if;
      end if;
    end if;
    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;
  close scan_cursor;
  exit when not projection_page_scan or more_rows or projection_batch_exhausted
    or projection_reader_exhausted;
  projection_batch_size := least(p_page_size + 1, scan_limit - projection_candidate_count);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
  into projection_batch
  from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
    null::uuid[], projection_sort_key, scan_directions[1], projection_after,
    projection_batch_size) with ordinality as projected(organization_id, record_id,
    revision, attribute_values, ordinality);
  end loop;
  exit when more_rows or budget_exhausted;
  end loop;
  if projection_batch_exhausted and not more_rows then
    budget_exhausted := true;
    last_examined_sort_key := projection_last_sort_key;
    last_examined_record_id := projection_last_record_id;
  end if;
  if row_count > 0 then
    page_capabilities := vortex_record.read_record_capabilities_page_internal(
      record_type_id_value, pg_catalog.to_jsonb(capability_rows), page_shared -> 'envelope'
    );
    if pg_catalog.jsonb_typeof(page_capabilities) is distinct from 'array'
      or pg_catalog.jsonb_array_length(page_capabilities) <> row_count then
      raise exception using errcode = '55000', message = 'Page capabilities are unavailable';
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(page_capabilities) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
    ) then
      raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
    end if;
    -- Each row gets its own capabilities, in one pass over the page.
    select pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
        'capabilities', page_capabilities -> (item.ordinality::integer - 1)) order by item.ordinality)
    into rows_value
    from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
  end if;
  if more_rows then
    next_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(last_returned_sort_key),
      'phase', case when pg_catalog.cardinality(last_returned_sort_key) > 0
        and last_returned_sort_key[1] is null then 'null' else 'value' end,
      'recordId', last_returned_record_id
    );
  elsif budget_exhausted then
    next_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(last_examined_sort_key),
      'phase', case when pg_catalog.cardinality(last_examined_sort_key) > 0
        and last_examined_sort_key[1] is null then 'null' else 'value' end,
      'recordId', last_examined_record_id
    );
  end if;
  if first_returned_record_id is not null then
    opposite_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(first_returned_sort_key),
      'phase', case when pg_catalog.cardinality(first_returned_sort_key) > 0
        and first_returned_sort_key[1] is null then 'null' else 'value' end,
      'recordId', first_returned_record_id
    );
  end if;
  if p_direction = 'backward' and row_count > 1 then
    select pg_catalog.jsonb_agg(item.value order by item.ordinality desc)
    into rows_value
    from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
  end if;
  exit column_pass when not board_columns_mode;
  board_column_pages := board_column_pages || pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('column', board_column_item, 'rows', rows_value, 'next', next_value)
  );
  end loop column_pass;
  if board_columns_mode then
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed',
      'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
      'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
      'columns', board_column_pages
    );
  end if;
  if group_member_mode then
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed',
      'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
      'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
      'groupByFieldIds', pg_catalog.to_jsonb(group_by_ids),
      'groupValues', group_selector_values,
      'rows', rows_value,
      'next', next_value
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
    'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
    'rows', rows_value,
    'next', next_value,
    'opposite', opposite_value
  );
end
$function$;
alter function vortex_record.run_module_query(uuid,uuid,bigint,jsonb,jsonb,integer,jsonb,jsonb,jsonb,text,uuid) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid)
  to vortex_request;
comment on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid) is
  'One bounded keyset page of rows readable through read_record for one installed Module query, or one exact current human-owned preview query over isolated preview storage, each carrying the record''s concurrency number and the per-row capabilities from read_record_capabilities, each action decided exactly as its own writer decides it, with only the declared Record system values, or one refusal before any row is exposed; accepts a bound list component''s declared sortable, filterable and searchable field sets together with the viewer''s chosen sort, typed filter and search term, refuses a sort or filter outside the declared sets, keeps a user sort only over a field the record type declares sortable and the reader is guaranteed to see, ANDs the user filter with the published filter so it can only narrow, and matches a search only through searchable fields the returned row exposes to the reader; requires every filtered field to be declared filterable; pushes a filter or a sort into the candidate scan only for fields the reader is guaranteed to see for the whole record type, evaluates a filter on a possibly-withheld field per row, and keeps the keyset cursor over readable sort values and a record identity so no cursor carries a hidden field value and the scan order and budget never depend on one; narrows an installed scan with one predicate that OR-s every eligible alternative''s exact owner, owner-group and direct-share route test with its saved condition compiled over the record''s own catalogue columns where that condition can be expressed as a superset of the per-row decision, leaves the installed scan unrestricted where a route or condition has no exact stored form, and still decides every returned row through read_record; validates every preview stage against the current human, candidate revision and exact release and storage pins, uses only active preview catalogue mappings and preview field bounds, and never falls through to installed resolution; works out read-time fields, such as a deadline-passed calculation, inside an installed query at one statement timestamp in the organisation time zone, so no installed query is refused for freshness; admits board members only through a separately validated board selector over the sole filterable choice grouping key, reads one column''s member page or, for a board''s first pages, the first page of every requested column in one invocation with its own budget and position per column, classifies those columns from current readable values and, when the choice field is guaranteed readable on every scanned row, narrows each column''s candidate scan to its own stored choice value so a column reads only its own cards, and admits generic grouped members only when every installed grouping value is present in the current readable projection and JSONB-equal to the closed typed selector; missing or withheld values belong to no generic group while JSON null is a value, and generic group membership never uses hidden stored values or affects scan order or budget; orders board and generic group pages by record identity, returns generic group identity even for empty pages, and binds each member operation, selector and projection in its own uncached continuation; reads the copied records of a preview like installed ones and refuses a system projection in a preview.';

create or replace function vortex_record.run_module_query_summary(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_user_inputs jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  prepared_plan jsonb;
  board_summary_mode boolean := false;
  board_summary jsonb;
begin
  if p_module_root_id is null or p_query_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_query_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_input_values is null or pg_catalog.jsonb_typeof(p_input_values) <> 'object'
    or (p_expected_release_revision is not null
      and p_expected_release_revision not between 1 and 9007199254740991) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_user_inputs is null then
    p_user_inputs := '{}'::jsonb;
  end if;
  board_summary_mode := p_user_inputs ? 'boardSummary';
  if pg_catalog.jsonb_typeof(p_user_inputs) <> 'object'
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_user_inputs) as supplied(key)
      where supplied.key not in ('filter', 'filterableFieldIds', 'boardSummary')
    ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if board_summary_mode then
    board_summary := p_user_inputs -> 'boardSummary';
    if pg_catalog.jsonb_typeof(board_summary) is distinct from 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    if board_summary - array['choiceFieldId']::text[] <> '{}'::jsonb
      or not (board_summary ? 'choiceFieldId') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    if pg_catalog.jsonb_typeof(board_summary -> 'choiceFieldId') is distinct from 'string'
      or pg_catalog.lower(board_summary ->> 'choiceFieldId') !~ uuid_pattern then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  end if;

  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'resolution', null
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'storage', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  return vortex_record.run_module_query_summary_internal(
    p_module_root_id, p_query_id, p_expected_release_revision,
    p_input_values, p_user_inputs, prepared_plan
  );
end
$function$;

alter function vortex_record.run_module_query_summary(uuid,uuid,bigint,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.run_module_query_summary(uuid, uuid, bigint, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_record.run_module_query_summary(uuid, uuid, bigint, jsonb, jsonb)
  to vortex_request;

comment on function vortex_record.run_module_query_summary(uuid, uuid, bigint, jsonb, jsonb) is
  'Runs one bounded database-backed installed Module query summary or protected board summary. It validates the request, prepares one protected read-scan access plan, and delegates the summary to the owner-only aggregate function, normalizes unreadable board choices to one unassigned bucket, summarises the own records of a preview for a preview request, and refuses neutrally above 100000 candidate rows.';

set local role vortex_owner;

reset role;
