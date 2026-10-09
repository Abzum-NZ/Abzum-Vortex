-- #1496: prepare an immutable first-install runtime bundle from the complete current publication and Record mapping.
-- Format-1 rows remain historical evidence; first activation accepts only the source-bound format 2 bundle.

begin;

set local role vortex_module_owner;
alter table vortex_module.installation_runtime_bundles
  add column source_manifest jsonb;
alter table vortex_module.installation_runtime_bundles
  add constraint installation_runtime_bundles_source_manifest_valid check (
    (bundle_format_version <> 2 or source_manifest is not null)
    and (source_manifest is null or pg_catalog.jsonb_typeof(source_manifest) = 'object')
  );
reset role;

-- The Module owner rechecks registration, exact release, and the complete locked provisioned pin map.
set local role vortex_module_owner;
create or replace function vortex_module.lock_prepared_installation_runtime_mapping_internal(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  none_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  initial_authority record;
  current_authority record;
  registration_revision bigint;
  required_count integer;
  expected_count integer;
  binding_item jsonb;
  pin_facts jsonb;
  binding_facts jsonb;
  pin_fingerprint text;
begin
  if p_application_root_id is null or p_application_root_id = none_uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) < 1
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not item.value ?& array[
          'moduleRootId', 'moduleReleaseRevision', 'bindingRevision', 'state'
        ]
        or item.value - array[
          'moduleRootId', 'moduleReleaseRevision', 'bindingRevision', 'state'
        ] <> '{}'::jsonb
        or (item.value ->> 'moduleRootId') !~* '^[0-9a-f-]{36}$'
        or (item.value ->> 'moduleReleaseRevision') !~ '^[1-9][0-9]*$'
        or (item.value ->> 'bindingRevision') !~ '^[1-9][0-9]*$'
        or item.value ->> 'state' is distinct from 'provisioned'
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      group by (item.value ->> 'moduleRootId')::uuid
      having pg_catalog.count(*) <> 1
    )
    or p_expected_module_bindings is distinct from (
      select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'moduleRootId')::uuid)
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
    ) then
    raise exception using errcode = '22023',
      message = 'Prepared installation mapping command is invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;

  select snapshot.release_revision into registration_revision
  from vortex_access.read_application_permission_snapshot(
    initial_authority.organization_id, p_application_root_id
  ) as snapshot;
  if registration_revision is distinct from p_application_release_revision then
    raise exception using errcode = '42501',
      message = 'Prepared installation registration is unavailable';
  end if;

  if not exists (
    select 1
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = p_application_release_revision
    where root.root_id = p_application_root_id
      and root.organization_id = initial_authority.organization_id
      and root.kind = 'application'
      and release.validation_contract_version = any (
        vortex_definition.accepted_contract_version('application')
      )
      and release.compilation_output #>> '{kind}' = 'application'
      and release.compilation_output #>> '{canonical,envelope,rootId}' = p_application_root_id::text
      and release.compilation_output #>> '{validationContractVersion}' = any (
        vortex_definition.accepted_contract_version('application')
      )
  ) then
    raise exception using errcode = 'P0002',
      message = 'Prepared installation Application release is unavailable';
  end if;

  select pg_catalog.count(*)::integer into required_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if required_count = 0 or expected_count <> required_count
    or exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
        where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
          and (expected.value ->> 'moduleReleaseRevision')::bigint = required.target_release_revision
      )
    ) then
    raise exception using errcode = '23514',
      message = 'Prepared installation pin set is incomplete';
  end if;

  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
    order by (item.value ->> 'moduleRootId')::uuid
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'vortex_module.binding:' || initial_authority.organization_id::text || ':' ||
          p_application_root_id::text || ':' || (binding_item ->> 'moduleRootId'),
        0
      )
    );
    perform 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = (binding_item ->> 'moduleRootId')::uuid
    for update;
  end loop;

  select locked.* into strict current_authority
  from vortex_access.lock_application_installation_authority() as locked;
  if current_authority.organization_id <> initial_authority.organization_id
    or current_authority.organization_account_id <> initial_authority.organization_account_id
    or current_authority.access_version <> initial_authority.access_version
    or current_authority.correlation_id <> initial_authority.correlation_id then
    raise exception using errcode = '40001',
      message = 'Prepared installation authority changed';
  end if;

  if exists (
    select 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.state <> 'detached'
      and not exists (
        select 1
        from vortex_definition.reachable_module_dependency_edges(
          p_application_root_id, p_application_release_revision
        ) as required
        where required.target_root_id = binding.module_root_id
      )
  ) or exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    left join vortex_module.installation_bindings as binding
      on binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = required.target_root_id
    left join lateral (
      select (expected.value ->> 'bindingRevision')::bigint as binding_revision
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
      where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
        and (expected.value ->> 'moduleReleaseRevision')::bigint = required.target_release_revision
    ) as expected on true
    where binding.state is distinct from 'provisioned'
      or binding.application_release_revision is distinct from p_application_release_revision
      or binding.module_release_revision is distinct from required.target_release_revision
      or binding.binding_revision is distinct from expected.binding_revision
  ) then
    raise exception using errcode = '40001',
      message = 'Prepared installation binding set changed';
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId', pin.target_root_id,
      'moduleReleaseRevision', pin.target_release_revision,
      'contentFingerprint', release.content_fingerprint,
      'resolutionFingerprint', release.resolution_fingerprint
    ) order by pin.target_root_id)
  into pin_facts
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as pin
  join vortex_definition.releases as release
    on release.root_id = pin.target_root_id
    and release.release_revision = pin.target_release_revision;
  if pin_facts is null or pg_catalog.jsonb_array_length(pin_facts) <> required_count then
    raise exception using errcode = '55000',
      message = 'Prepared installation source pins are unavailable';
  end if;
  pin_fingerprint := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pin_facts::text, 'UTF8')),
    'hex'
  );

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId', binding.module_root_id,
      'moduleReleaseRevision', binding.module_release_revision,
      'bindingRevision', binding.binding_revision,
      'state', binding.state
    ) order by binding.module_root_id)
  into binding_facts
  from vortex_module.installation_bindings as binding
  where binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.state = 'provisioned';
  if binding_facts is distinct from p_expected_module_bindings then
    raise exception using errcode = '40001',
      message = 'Prepared installation expected bindings changed';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'organizationAccountId', initial_authority.organization_account_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'accessVersion', initial_authority.access_version,
    'correlationId', initial_authority.correlation_id,
    'registeredReleaseRevision', registration_revision,
    'pinFingerprint', pin_fingerprint,
    'pinFacts', pin_facts,
    'moduleBindings', binding_facts
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Prepared installation mapping evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Prepared installation mapping evidence is ambiguous';
end
$function$;

alter function vortex_module.lock_prepared_installation_runtime_mapping_internal(uuid,bigint,jsonb)
  owner to vortex_module_owner;
revoke all on function vortex_module.lock_prepared_installation_runtime_mapping_internal(uuid,bigint,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;
grant execute on function vortex_module.lock_prepared_installation_runtime_mapping_internal(uuid,bigint,jsonb)
  to vortex_record_adapter;
comment on function vortex_module.lock_prepared_installation_runtime_mapping_internal(uuid,bigint,jsonb) is
  'Locks the current human installation authority and exact complete provisioned Module pin mapping for first-install runtime preparation.';

reset role;

-- Record owns the schema; the adapter gets only this migration-scoped CREATE privilege.
set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;
create or replace function vortex_record.resolve_prepared_record_access_plan_internal(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  organization_id_value uuid;
  application_root_id_value uuid;
  application_release_revision_value bigint;
  pin_fingerprint_value text;
  current_mapping jsonb;
  current_bindings jsonb;
  resolved_plan jsonb;
  mapping_fingerprint_value text;
  plan_key_value text;
  prepared_plan jsonb;
  stored_plan vortex_record.installation_access_plans%rowtype;
  inserted_rows bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) < 1 then
    raise exception using errcode = '22023',
      message = 'Prepared Record access plan command is invalid';
  end if;

  select locked.* into current_mapping
  from vortex_module.lock_prepared_installation_runtime_mapping_internal(
    p_application_root_id,
    p_application_release_revision,
    p_expected_module_bindings
  ) as locked;
  organization_id_value := (current_mapping ->> 'organizationId')::uuid;
  application_root_id_value := (current_mapping ->> 'applicationRootId')::uuid;
  application_release_revision_value :=
    (current_mapping ->> 'applicationReleaseRevision')::bigint;
  pin_fingerprint_value := current_mapping ->> 'pinFingerprint';
  if current_mapping is null
    or application_root_id_value is distinct from p_application_root_id
    or application_release_revision_value is distinct from p_application_release_revision
    or pin_fingerprint_value is null
    or pin_fingerprint_value !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '40001',
      message = 'Prepared Record access plan mapping changed';
  end if;
  current_bindings := current_mapping -> 'moduleBindings';
  resolved_plan := vortex_record.resolve_installation_access_plan_internal(
    pg_catalog.jsonb_build_object(
      'organizationId', organization_id_value,
      'applicationRootId', application_root_id_value,
      'applicationReleaseRevision', application_release_revision_value,
      'moduleBindings', current_bindings
    )
  );
  if resolved_plan is null
    or (resolved_plan ->> 'organizationId')::uuid is distinct from organization_id_value
    or (resolved_plan ->> 'applicationRootId')::uuid is distinct from application_root_id_value
    or (resolved_plan ->> 'applicationReleaseRevision')::bigint
      is distinct from application_release_revision_value then
    raise exception using errcode = '55000',
      message = 'Prepared Record access plan is unavailable';
  end if;

  mapping_fingerprint_value := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      (pg_catalog.jsonb_build_object(
        'recordTypes', resolved_plan -> 'recordTypes',
        'relationships', resolved_plan -> 'relationships',
        'sharingConditions', resolved_plan -> 'sharingConditions',
        'permissions', resolved_plan -> 'permissions'
      ))::text,
      'UTF8'
    )),
    'hex'
  );
  plan_key_value := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'vortex.installation-runtime-bundle.prepared-record-access-plan.v2|' ||
        organization_id_value::text || '|' || application_root_id_value::text || '|' ||
        application_release_revision_value::text || '|2|' || pin_fingerprint_value,
      'UTF8'
    )),
    'hex'
  );
  prepared_plan := pg_catalog.jsonb_build_object(
    'planKey', plan_key_value,
    'mappingFingerprint', mapping_fingerprint_value,
    'plan', resolved_plan
  );

  insert into vortex_record.installation_access_plans (
    plan_key, organization_id, application_root_id, application_release_revision, plan
  ) values (
    plan_key_value, organization_id_value, application_root_id_value,
    application_release_revision_value, prepared_plan
  ) on conflict (plan_key) do nothing;
  get diagnostics inserted_rows = row_count;
  if inserted_rows = 0 then
    select stored.* into strict stored_plan
    from vortex_record.installation_access_plans as stored
    where stored.plan_key = plan_key_value
    for update;
    if stored_plan.organization_id is distinct from organization_id_value
      or stored_plan.application_root_id is distinct from application_root_id_value
      or stored_plan.application_release_revision is distinct from application_release_revision_value
      or stored_plan.plan is distinct from prepared_plan then
      raise exception using errcode = '23505',
        message = 'Prepared Record access plan immutable identity differs';
    end if;
    prepared_plan := stored_plan.plan;
  end if;
  return prepared_plan;
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Prepared Record access plan evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Prepared Record access plan evidence is ambiguous';
end
$function$;

alter function vortex_record.resolve_prepared_record_access_plan_internal(uuid,bigint,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.resolve_prepared_record_access_plan_internal(uuid,bigint,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.resolve_prepared_record_access_plan_internal(uuid,bigint,jsonb)
  to vortex_module_owner;
comment on function vortex_record.resolve_prepared_record_access_plan_internal(uuid,bigint,jsonb) is
  'Resolves and immutably stores the exact prepared Record access plan for a first-install provisioned Module mapping.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

-- Preserve the existing postgres-owned, SECURITY INVOKER projection and grant only its exact Module caller.
set local role postgres;
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
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'resolutionFingerprint', dependency.evidence_fingerprint
          )
          when 'connection_type' then pg_catalog.jsonb_build_object(
            'kind', 'connection_type',
            'key', dependency.dependency_reference,
            'rootId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'catalogueFingerprint', dependency.evidence_fingerprint
          )
          when 'platform_block' then pg_catalog.jsonb_build_object(
            'kind', 'platform_block',
            'blockId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'catalogueFingerprint', dependency.evidence_fingerprint
          )
          when 'platform_theme' then pg_catalog.jsonb_build_object(
            'kind', 'platform_theme',
            'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'catalogueFingerprint', dependency.evidence_fingerprint
          )
          else dependency.dependency_entry
        end
        order by dependency.dependency_kind collate "C",
          dependency.dependency_reference collate "C",
          dependency.dependency_version collate "C"
      )
      from vortex_definition.release_dependencies as dependency
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
      from vortex_definition.release_dependencies as dependency
      join vortex_definition.releases as target
        on target.root_id = dependency.target_root_id
        and target.release_revision = dependency.target_release_revision
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
        and dependency.dependency_kind = 'module'
    ), '[]'::jsonb)
  )
  from vortex_definition.roots as root
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = p_release_revision
  where root.root_id = p_root_id
    and root.kind = p_kind
$function$;

revoke all on function vortex_definition.project_consumer_release_evidence(text, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.project_consumer_release_evidence(text, uuid, bigint) to vortex_module_owner;
comment on function vortex_definition.project_consumer_release_evidence(text, uuid, bigint) is
  'Owner-private projection of one exact immutable release; performs no scope selection.';

reset role;

-- The request-scoped reader and writer use current immutable evidence and the stored source manifest.
set local role vortex_module_owner;
create or replace function vortex_module.read_prepared_installation_runtime_source(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  mapping jsonb;
  prepared_record_plan jsonb;
  application_evidence jsonb;
  module_evidence jsonb;
begin
  mapping := vortex_module.lock_prepared_installation_runtime_mapping_internal(
    p_application_root_id,
    p_application_release_revision,
    p_expected_module_bindings
  );
  select vortex_definition.project_consumer_release_evidence(
    'application', p_application_root_id, p_application_release_revision
  ) into application_evidence;
  if application_evidence is null
    or (application_evidence ->> 'organizationId')::uuid
      is distinct from (mapping ->> 'organizationId')::uuid then
    raise exception using errcode = 'P0002',
      message = 'Prepared Application source is unavailable';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
      vortex_definition.project_consumer_release_evidence(
        'module', (pin.value ->> 'moduleRootId')::uuid,
        (pin.value ->> 'moduleReleaseRevision')::bigint
      ) order by (pin.value ->> 'moduleRootId')::uuid
    ), '[]'::jsonb)
  into module_evidence
  from pg_catalog.jsonb_array_elements(mapping -> 'moduleBindings') as pin(value);

  prepared_record_plan := vortex_record.resolve_prepared_record_access_plan_internal(
    p_application_root_id,
    p_application_release_revision,
    mapping -> 'moduleBindings'
  );
  if prepared_record_plan is null
    or pg_catalog.jsonb_typeof(prepared_record_plan) is distinct from 'object'
    or not prepared_record_plan ?& array['planKey', 'mappingFingerprint', 'plan'] then
    raise exception using errcode = '55000',
      message = 'Prepared Record access plan is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', mapping -> 'organizationId',
    'applicationRootId', mapping -> 'applicationRootId',
    'applicationReleaseRevision', mapping -> 'applicationReleaseRevision',
    'accessVersion', mapping -> 'accessVersion',
    'correlationId', mapping -> 'correlationId',
    'pinFingerprint', mapping -> 'pinFingerprint',
    'mappingFingerprint', prepared_record_plan -> 'mappingFingerprint',
    'moduleBindings', mapping -> 'moduleBindings',
    'application', application_evidence,
    'modules', module_evidence,
    'preparedRecordAccessPlan', prepared_record_plan
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Prepared runtime source evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Prepared runtime source evidence is ambiguous';
end
$function$;

alter function vortex_module.read_prepared_installation_runtime_source(uuid,bigint,jsonb)
  owner to vortex_module_owner;
revoke all on function vortex_module.read_prepared_installation_runtime_source(uuid,bigint,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.read_prepared_installation_runtime_source(uuid,bigint,jsonb)
  to vortex_request;
comment on function vortex_module.read_prepared_installation_runtime_source(uuid,bigint,jsonb) is
  'Reads exact immutable Application and complete Module source plus the current prepared Record plan inside the verified human installation transaction.';

create or replace function vortex_module.assert_prepared_installation_runtime_bundle(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb,
  p_pin_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  expected_sections constant text[] := array[
    'pages', 'navigation', 'flows', 'trigger_index', 'theme', 'component_registry',
    'access_plan', 'tool_bundle'
  ];
  checked_context jsonb;
  selected_organization_id uuid;
  prepared_source jsonb;
  source_manifest jsonb;
  application_content jsonb;
  expected_access_plan jsonb;
  access_plan_text text;
  access_plan_value jsonb;
  stored_bundle vortex_module.installation_runtime_bundles%rowtype;
  part_item record;
  metadata_item jsonb;
  metadata_count integer;
  stored_part_count integer;
  section_value text;
  ordinal_value bigint;
  byte_size_value bigint;
  total_size_value bigint := 0;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_pin_fingerprint is null
    or p_pin_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) < 1 then
    raise exception using errcode = '22023',
      message = 'Prepared runtime bundle assertion is invalid';
  end if;
  checked_context := vortex_access.validated_human_request_context();
  selected_organization_id := (checked_context ->> 'organizationId')::uuid;
  if selected_organization_id is null then
    raise exception using errcode = '42501',
      message = 'Prepared runtime bundle authority is unavailable';
  end if;
  prepared_source := vortex_module.read_prepared_installation_runtime_source(
    p_application_root_id,
    p_application_release_revision,
    p_expected_module_bindings
  );
  if prepared_source is null
    or (prepared_source ->> 'organizationId')::uuid is distinct from selected_organization_id
    or prepared_source ->> 'pinFingerprint' is distinct from p_pin_fingerprint then
    raise exception using errcode = '40001',
      message = 'Prepared runtime bundle source changed';
  end if;
  source_manifest := pg_catalog.jsonb_build_object(
    'bundleFormatVersion', 2,
    'application', pg_catalog.jsonb_build_object(
      'rootId', prepared_source #> '{application,rootId}',
      'definitionKey', prepared_source #> '{application,key}',
      'releaseRevision', prepared_source #> '{application,releaseRevision}',
      'releaseVersion', prepared_source #> '{application,releaseVersion}',
      'validationContractVersion', prepared_source #> '{application,validationContractVersion}',
      'contentFingerprint', prepared_source #> '{application,contentFingerprint}',
      'resolutionFingerprint', prepared_source #> '{application,resolutionFingerprint}'
    ),
    'modules', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'rootId', module.value -> 'rootId',
          'definitionKey', module.value -> 'key',
          'releaseRevision', module.value -> 'releaseRevision',
          'releaseVersion', module.value -> 'releaseVersion',
          'validationContractVersion', module.value -> 'validationContractVersion',
          'contentFingerprint', module.value -> 'contentFingerprint',
          'resolutionFingerprint', module.value -> 'resolutionFingerprint'
        ) order by (module.value ->> 'rootId') collate "C")
      from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value)
    ), '[]'::jsonb),
    'pinFingerprint', prepared_source -> 'pinFingerprint',
    'preparedRecordAccessPlan', pg_catalog.jsonb_build_object(
      'planKey', prepared_source #> '{preparedRecordAccessPlan,planKey}',
      'mappingFingerprint', prepared_source #> '{preparedRecordAccessPlan,mappingFingerprint}'
    )
  );
  select stored.* into strict stored_bundle
  from vortex_module.installation_runtime_bundles as stored
  where stored.organization_id = selected_organization_id
    and stored.application_root_id = p_application_root_id
    and stored.application_release_revision = p_application_release_revision
    and stored.bundle_format_version = 2;
  if stored_bundle.pin_fingerprint is distinct from p_pin_fingerprint
    or stored_bundle.source_manifest is distinct from source_manifest then
    raise exception using errcode = '23505',
      message = 'Prepared runtime bundle identity differs';
  end if;

  if pg_catalog.jsonb_typeof(stored_bundle.parts) is distinct from 'array'
    or pg_catalog.jsonb_array_length(stored_bundle.parts) < pg_catalog.cardinality(expected_sections)
    or exists (
      select 1
      from pg_catalog.unnest(expected_sections) as required(section)
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
        where item.value ->> 'section' = required.section
      )
    ) then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle parts are incomplete';
  end if;
  select pg_catalog.count(*)::integer into metadata_count
  from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value);
  select pg_catalog.count(*)::integer into stored_part_count
  from vortex_module.installation_runtime_bundle_parts as part
  where part.organization_id = selected_organization_id
    and part.application_root_id = p_application_root_id
    and part.application_release_revision = p_application_release_revision
    and part.bundle_format_version = 2;
  if metadata_count is distinct from stored_part_count then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle part count differs';
  end if;
  for metadata_item in
    select item.value from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
  loop
    if pg_catalog.jsonb_typeof(metadata_item) is distinct from 'object'
      or not metadata_item ?& array['section','ordinal','byteSize','sha256']
      or metadata_item - array['section','ordinal','byteSize','sha256'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(metadata_item -> 'section') is distinct from 'string'
      or pg_catalog.jsonb_typeof(metadata_item -> 'ordinal') is distinct from 'number'
      or pg_catalog.jsonb_typeof(metadata_item -> 'byteSize') is distinct from 'number'
      or pg_catalog.jsonb_typeof(metadata_item -> 'sha256') is distinct from 'string'
      or not (metadata_item ->> 'section' = any (expected_sections))
      or (metadata_item ->> 'ordinal') !~ '^(0|[1-9][0-9]*)$'
      or pg_catalog.length(metadata_item ->> 'ordinal') > 10
      or (metadata_item ->> 'byteSize') !~ '^[1-9][0-9]*$'
      or pg_catalog.length(metadata_item ->> 'byteSize') > 7
      or (metadata_item ->> 'sha256') !~ '^sha256:[a-f0-9]{64}$' then
      raise exception using errcode = '55000',
        message = 'Prepared runtime bundle part metadata is invalid';
    end if;
    section_value := metadata_item ->> 'section';
    ordinal_value := (metadata_item ->> 'ordinal')::bigint;
    byte_size_value := (metadata_item ->> 'byteSize')::bigint;
    if ordinal_value > 2147483647 or byte_size_value > 1048575 then
      raise exception using errcode = '55000',
        message = 'Prepared runtime bundle part metadata exceeds its limit';
    end if;
    total_size_value := total_size_value + byte_size_value;
    if total_size_value > 9007199254740991 then
      raise exception using errcode = '55000',
        message = 'Prepared runtime bundle total size exceeds its limit';
    end if;
    select part.* into strict part_item
    from vortex_module.installation_runtime_bundle_parts as part
    where part.organization_id = selected_organization_id
      and part.application_root_id = p_application_root_id
      and part.application_release_revision = p_application_release_revision
      and part.bundle_format_version = 2
      and part.section = section_value
      and part.ordinal = ordinal_value::integer;
    if pg_catalog.octet_length(part_item.content_bytes) is distinct from byte_size_value
      or ('sha256:' || pg_catalog.encode(
        extensions.digest(part_item.content_bytes, 'sha256'), 'hex'
      )) is distinct from metadata_item ->> 'sha256' then
      raise exception using errcode = '55000',
        message = 'Prepared runtime bundle bytes do not match their manifest';
    end if;
  end loop;
  if total_size_value is distinct from stored_bundle.total_size_bytes
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
      group by item.value ->> 'section', (item.value ->> 'ordinal')::integer
      having pg_catalog.count(*) > 1
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
      group by item.value ->> 'section'
      having pg_catalog.min((item.value ->> 'ordinal')::integer) <> 0
        or pg_catalog.max((item.value ->> 'ordinal')::integer) <>
          pg_catalog.count(*) - 1
    )
    or exists (
      select 1
      from pg_catalog.unnest(expected_sections) as required(section)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
        where item.value ->> 'section' = required.section
      )
    ) then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle metadata is incomplete';
  end if;

  application_content := prepared_source #> '{application,compilationOutput,canonical,content}';
  select pg_catalog.jsonb_build_object(
    'preparedRecordAccessPlan', prepared_source -> 'preparedRecordAccessPlan',
    'declaredPermissions', pg_catalog.jsonb_build_object(
      'application', application_content -> 'permissions',
      'modules', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'rootId', module.value -> 'rootId',
            'permissions', module.value #> '{compilationOutput,canonical,content,permissions}'
          ) order by (module.value ->> 'rootId') collate "C")
        from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value)
      ), '[]'::jsonb)
    )
  ) into expected_access_plan;
  select pg_catalog.string_agg(pg_catalog.convert_from(part.content_bytes, 'UTF8'), ''
    order by part.ordinal)
  into access_plan_text
  from vortex_module.installation_runtime_bundle_parts as part
  where part.organization_id = selected_organization_id
    and part.application_root_id = p_application_root_id
    and part.application_release_revision = p_application_release_revision
    and part.bundle_format_version = 2
    and part.section = 'access_plan';
  begin
    access_plan_value := access_plan_text::jsonb;
  exception when others then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle access plan is invalid';
  end;
  if access_plan_value is distinct from expected_access_plan then
    raise exception using errcode = '23505',
      message = 'Prepared runtime bundle Record plan differs from current source';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'verified',
    'organizationId', selected_organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'bundleFormatVersion', 2,
    'pinFingerprint', stored_bundle.pin_fingerprint,
    'sourceManifest', stored_bundle.source_manifest
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Prepared runtime bundle is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle evidence is ambiguous';
end
$function$;

alter function vortex_module.assert_prepared_installation_runtime_bundle(uuid,bigint,jsonb,text)
  owner to vortex_module_owner;
revoke all on function vortex_module.assert_prepared_installation_runtime_bundle(uuid,bigint,jsonb,text)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.assert_prepared_installation_runtime_bundle(uuid,bigint,jsonb,text)
  to vortex_request;
comment on function vortex_module.assert_prepared_installation_runtime_bundle(uuid,bigint,jsonb,text) is
  'Re-derives first-install source and plan identity, then verifies the complete immutable format-2 bundle and its stored bytes before activation.';

create or replace function vortex_module.read_installation_runtime_bundle_index(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_bundle_format_version integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  selected_organization_id uuid;
  stored_bundle vortex_module.installation_runtime_bundles%rowtype;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_bundle_format_version is distinct from 2 then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle key is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  selected_organization_id := (checked_context ->> 'organizationId')::uuid;
  if selected_organization_id is null then
    raise exception using errcode = '42501',
      message = 'Installation runtime bundle organisation is unavailable';
  end if;

  select stored.* into stored_bundle
  from vortex_module.installation_runtime_bundles as stored
  where stored.organization_id = selected_organization_id
    and stored.application_root_id = p_application_root_id
    and stored.application_release_revision = p_application_release_revision
    and stored.bundle_format_version = p_bundle_format_version;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Installation runtime bundle is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', stored_bundle.organization_id,
    'applicationRootId', stored_bundle.application_root_id,
    'applicationReleaseRevision', stored_bundle.application_release_revision,
    'bundleFormatVersion', stored_bundle.bundle_format_version,
    'pinFingerprint', stored_bundle.pin_fingerprint,
    'sourceManifest', stored_bundle.source_manifest,
    'parts', stored_bundle.parts,
    'totalSizeBytes', stored_bundle.total_size_bytes,
    'builtAt', stored_bundle.built_at
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Installation runtime bundle is unavailable';
end
$function$;

alter function vortex_module.read_installation_runtime_bundle_index(uuid,bigint,integer) owner to vortex_module_owner;

revoke all on function vortex_module.read_installation_runtime_bundle_index(
  uuid, bigint, integer
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.read_installation_runtime_bundle_index(
  uuid, bigint, integer
) to vortex_request;
comment on function vortex_module.read_installation_runtime_bundle_index(
  uuid, bigint, integer
) is
  'Reads one exact immutable runtime bundle index inside the verified organisation context.';

create or replace function vortex_module.write_installation_runtime_bundle_internal(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_bundle_format_version integer,
  p_pin_fingerprint text,
  p_parts jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  expected_sections constant text[] := array[
    'pages', 'navigation', 'flows', 'trigger_index', 'theme', 'component_registry',
    'access_plan', 'tool_bundle'
  ];
  permission_decision record;
  delegation_decision record;
  checked_context jsonb;
  selected_organization_id uuid;
  part_item jsonb;
  section_value text;
  ordinal_value bigint;
  byte_size_value bigint;
  content_text text;
  content_bytes bytea;
  sha256_value text;
  total_size_value bigint := 0;
  parts_manifest jsonb;
  inserted_rows bigint;
  stored_bundle vortex_module.installation_runtime_bundles%rowtype;
  expected_module_bindings jsonb;
  prepared_source jsonb;
  source_manifest jsonb;
  section_payloads jsonb := '{}'::jsonb;
  section_text text;
  application_content jsonb;
  expected_modules jsonb;
  expected_trigger_index jsonb;
  expected_access_plan jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_bundle_format_version is distinct from 2
    or p_pin_fingerprint is null or p_pin_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or p_parts is null or pg_catalog.jsonb_typeof(p_parts) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle command is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_parts) < pg_catalog.cardinality(expected_sections) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle command is invalid';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Module installation authority is unavailable';
  end if;

  select evaluated.* into strict delegation_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install_scope',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
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
    raise exception using errcode = '42501',
      message = 'Module installation delegation is unavailable';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '40001',
      message = 'Module installation context changed';
  end if;
  selected_organization_id := permission_decision.organization_id;

  if not exists (
    select 1
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = p_application_release_revision
    where root.root_id = p_application_root_id
      and root.organization_id = selected_organization_id
      and root.kind = 'application'
      and release.validation_contract_version = any (
        vortex_definition.accepted_contract_version('application')
      )
      and release.compilation_output #>> '{kind}' = 'application'
      and release.compilation_output #>> '{canonical,envelope,rootId}' =
        p_application_root_id::text
      and release.compilation_output #>> '{validationContractVersion}' = any (
        vortex_definition.accepted_contract_version('application')
      )
  ) then
    raise exception using errcode = 'P0002',
      message = 'Installation Application release is unavailable';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId', binding.module_root_id,
      'moduleReleaseRevision', binding.module_release_revision,
      'bindingRevision', binding.binding_revision,
      'state', binding.state
    ) order by binding.module_root_id), '[]'::jsonb)
  into expected_module_bindings
  from vortex_module.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.state = 'provisioned';
  prepared_source := vortex_module.read_prepared_installation_runtime_source(
    p_application_root_id,
    p_application_release_revision,
    expected_module_bindings
  );
  if prepared_source is null
    or (prepared_source ->> 'organizationId')::uuid is distinct from selected_organization_id
    or (prepared_source ->> 'applicationRootId')::uuid is distinct from p_application_root_id
    or (prepared_source ->> 'applicationReleaseRevision')::bigint is distinct from p_application_release_revision
    or prepared_source ->> 'pinFingerprint' is distinct from p_pin_fingerprint then
    raise exception using errcode = '40001',
      message = 'Installation runtime bundle source changed';
  end if;
  source_manifest := pg_catalog.jsonb_build_object(
    'bundleFormatVersion', 2,
    'application', pg_catalog.jsonb_build_object(
      'rootId', prepared_source #> '{application,rootId}',
      'definitionKey', prepared_source #> '{application,key}',
      'releaseRevision', prepared_source #> '{application,releaseRevision}',
      'releaseVersion', prepared_source #> '{application,releaseVersion}',
      'validationContractVersion', prepared_source #> '{application,validationContractVersion}',
      'contentFingerprint', prepared_source #> '{application,contentFingerprint}',
      'resolutionFingerprint', prepared_source #> '{application,resolutionFingerprint}'
    ),
    'modules', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'rootId', module.value -> 'rootId',
          'definitionKey', module.value -> 'key',
          'releaseRevision', module.value -> 'releaseRevision',
          'releaseVersion', module.value -> 'releaseVersion',
          'validationContractVersion', module.value -> 'validationContractVersion',
          'contentFingerprint', module.value -> 'contentFingerprint',
          'resolutionFingerprint', module.value -> 'resolutionFingerprint'
        ) order by (module.value ->> 'rootId') collate "C")
      from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value)
    ), '[]'::jsonb),
    'pinFingerprint', prepared_source -> 'pinFingerprint',
    'preparedRecordAccessPlan', pg_catalog.jsonb_build_object(
      'planKey', prepared_source #> '{preparedRecordAccessPlan,planKey}',
      'mappingFingerprint', prepared_source #> '{preparedRecordAccessPlan,mappingFingerprint}'
    )
  );
  for section_value in
    select required.section
    from pg_catalog.unnest(expected_sections) as required(section)
  loop
    select pg_catalog.string_agg(item.value ->> 'content', '' order by
      (item.value ->> 'ordinal')::integer)
    into section_text
    from pg_catalog.jsonb_array_elements(p_parts) as item(value)
    where item.value ->> 'section' = section_value;
    if section_text is null then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle section is unavailable';
    end if;
    begin
      section_payloads := section_payloads || pg_catalog.jsonb_build_object(
        section_value, section_text::jsonb
      );
    exception when others then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle section is invalid';
    end;
  end loop;
  application_content := prepared_source #> '{application,compilationOutput,canonical,content}';
  if application_content is null then
    raise exception using errcode = '55000',
      message = 'Installation runtime bundle Application content is unavailable';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'identity', pg_catalog.jsonb_build_object(
        'rootId', module.value -> 'rootId',
        'definitionKey', module.value -> 'key',
        'releaseRevision', module.value -> 'releaseRevision',
        'releaseVersion', module.value -> 'releaseVersion',
        'validationContractVersion', module.value -> 'validationContractVersion',
        'contentFingerprint', module.value -> 'contentFingerprint',
        'resolutionFingerprint', module.value -> 'resolutionFingerprint'
      ),
      'content', module.value #> '{compilationOutput,canonical,content}'
    ) order by (module.value ->> 'rootId') collate "C"), '[]'::jsonb)
  into expected_modules
  from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'flowId', flow.value -> 'id', 'trigger', trigger.value
    ) order by (flow.value ->> 'id') collate "C", (trigger.value ->> 'id') collate "C"), '[]'::jsonb)
  into expected_trigger_index
  from pg_catalog.jsonb_array_elements(application_content -> 'flows') as flow(value)
  cross join lateral pg_catalog.jsonb_array_elements(flow.value -> 'triggers') as trigger(value);
  select pg_catalog.jsonb_build_object(
    'preparedRecordAccessPlan', prepared_source -> 'preparedRecordAccessPlan',
    'declaredPermissions', pg_catalog.jsonb_build_object(
      'application', application_content -> 'permissions',
      'modules', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'rootId', module.value -> 'rootId',
            'permissions', module.value #> '{compilationOutput,canonical,content,permissions}'
          ) order by (module.value ->> 'rootId') collate "C")
        from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value)
      ), '[]'::jsonb)
    )
  ) into expected_access_plan;
  if section_payloads -> 'navigation' is distinct from application_content -> 'navigation'
    or section_payloads -> 'flows' is distinct from pg_catalog.jsonb_build_object(
      'flows', application_content -> 'flows',
      'flowBindings', application_content -> 'flowBindings'
    )
    or section_payloads -> 'trigger_index' is distinct from expected_trigger_index
    or section_payloads -> 'theme' is distinct from application_content -> 'theme'
    or section_payloads -> 'component_registry' is distinct from application_content -> 'platformBlockDependencies'
    or section_payloads -> 'tool_bundle' is distinct from prepared_source #> '{application,compilationOutput,toolBundle}'
    or section_payloads -> 'access_plan' is distinct from expected_access_plan
    or section_payloads #> '{pages,application,identity}' is distinct from pg_catalog.jsonb_build_object(
      'rootId', prepared_source #> '{application,rootId}',
      'definitionKey', prepared_source #> '{application,key}',
      'releaseRevision', prepared_source #> '{application,releaseRevision}',
      'releaseVersion', prepared_source #> '{application,releaseVersion}',
      'validationContractVersion', prepared_source #> '{application,validationContractVersion}',
      'contentFingerprint', prepared_source #> '{application,contentFingerprint}',
      'resolutionFingerprint', prepared_source #> '{application,resolutionFingerprint}'
    )
    or section_payloads #> '{pages,application,content}' is distinct from
      application_content - array[
        'navigation', 'flows', 'flowBindings', 'theme',
        'platformBlockDependencies', 'shells', 'pages'
      ]::text[]
    or section_payloads #> '{pages,application,shells}' is distinct from application_content -> 'shells'
    or section_payloads #> '{pages,application,pages}' is distinct from application_content -> 'pages'
    or section_payloads #> '{pages,modules}' is distinct from expected_modules
    or pg_catalog.jsonb_typeof(section_payloads #> '{pages,resolvedCompositions}') is distinct from 'array'
    or pg_catalog.jsonb_array_length(section_payloads #> '{pages,resolvedCompositions}') <>
      pg_catalog.jsonb_array_length(application_content -> 'pages') then
    raise exception using errcode = '23514',
      message = 'Installation runtime bundle sections do not match current immutable source';
  end if;
  for part_item in
    select item.value from pg_catalog.jsonb_array_elements(p_parts) as item(value)
  loop
    if pg_catalog.jsonb_typeof(part_item) is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;
    if not (part_item ?& array['section', 'ordinal', 'byteSize', 'sha256', 'content'])
      or part_item - array['section', 'ordinal', 'byteSize', 'sha256', 'content'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(part_item -> 'section') is distinct from 'string'
      or pg_catalog.jsonb_typeof(part_item -> 'ordinal') is distinct from 'number'
      or pg_catalog.jsonb_typeof(part_item -> 'byteSize') is distinct from 'number'
      or pg_catalog.jsonb_typeof(part_item -> 'sha256') is distinct from 'string'
      or pg_catalog.jsonb_typeof(part_item -> 'content') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;

    section_value := part_item ->> 'section';
    if not (section_value = any (expected_sections))
      or (part_item ->> 'ordinal') !~ '^(0|[1-9][0-9]*)$'
      or pg_catalog.length(part_item ->> 'ordinal') > 10
      or (part_item ->> 'byteSize') !~ '^[1-9][0-9]*$'
      or pg_catalog.length(part_item ->> 'byteSize') > 7 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;
    ordinal_value := (part_item ->> 'ordinal')::bigint;
    byte_size_value := (part_item ->> 'byteSize')::bigint;
    content_text := part_item ->> 'content';
    if ordinal_value > 2147483647 or byte_size_value > 1048575 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part exceeds its limit';
    end if;

    content_bytes := pg_catalog.convert_to(content_text, 'UTF8');
    if pg_catalog.octet_length(content_bytes) <> byte_size_value then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part size is invalid';
    end if;
    sha256_value := 'sha256:' || pg_catalog.encode(
      extensions.digest(content_bytes, 'sha256'), 'hex'
    );
    if (part_item ->> 'sha256') !~ '^sha256:[a-f0-9]{64}$'
      or sha256_value <> (part_item ->> 'sha256') then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part fingerprint is invalid';
    end if;
    total_size_value := total_size_value + byte_size_value;
    if total_size_value > 9007199254740991 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle is too large';
    end if;
  end loop;

  if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_parts) as item(value)
      group by item.value ->> 'section', (item.value ->> 'ordinal')::integer
      having pg_catalog.count(*) > 1
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_parts) as item(value)
      group by item.value ->> 'section'
      having pg_catalog.min((item.value ->> 'ordinal')::integer) <> 0
        or pg_catalog.max((item.value ->> 'ordinal')::integer) <>
          pg_catalog.count(*) - 1
    )
    or exists (
      select 1
      from pg_catalog.unnest(expected_sections) as required(section)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_parts) as item(value)
        where item.value ->> 'section' = required.section
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle sections are incomplete';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'section', item.value ->> 'section',
      'ordinal', (item.value ->> 'ordinal')::integer,
      'byteSize', (item.value ->> 'byteSize')::bigint,
      'sha256', item.value ->> 'sha256'
    ) order by pg_catalog.array_position(
      expected_sections, item.value ->> 'section'
    ), (item.value ->> 'ordinal')::integer
  )
  into parts_manifest
  from pg_catalog.jsonb_array_elements(p_parts) as item(value);

  insert into vortex_module.installation_runtime_bundles (
    organization_id, application_root_id, application_release_revision,
    bundle_format_version, pin_fingerprint, source_manifest, parts, total_size_bytes
  ) values (
    selected_organization_id, p_application_root_id, p_application_release_revision,
    p_bundle_format_version, p_pin_fingerprint, source_manifest, parts_manifest, total_size_value
  ) on conflict (
    organization_id, application_root_id, application_release_revision, bundle_format_version
  ) do nothing;
  get diagnostics inserted_rows = row_count;

  if inserted_rows = 0 then
    select stored.* into stored_bundle
    from vortex_module.installation_runtime_bundles as stored
    where stored.organization_id = selected_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.application_release_revision = p_application_release_revision
      and stored.bundle_format_version = p_bundle_format_version;
    if not found then
      raise exception using errcode = '40001',
        message = 'Installation runtime bundle changed concurrently';
    end if;
    if stored_bundle.pin_fingerprint <> p_pin_fingerprint
      or stored_bundle.source_manifest is distinct from source_manifest
      or stored_bundle.parts is distinct from parts_manifest
      or stored_bundle.total_size_bytes is distinct from total_size_value
      or (select pg_catalog.count(*) from vortex_module.installation_runtime_bundle_parts as part
        where part.organization_id = selected_organization_id
          and part.application_root_id = p_application_root_id
          and part.application_release_revision = p_application_release_revision
          and part.bundle_format_version = p_bundle_format_version)
        <> pg_catalog.jsonb_array_length(p_parts)
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_parts) as item(value)
        left join vortex_module.installation_runtime_bundle_parts as part
          on part.organization_id = selected_organization_id
          and part.application_root_id = p_application_root_id
          and part.application_release_revision = p_application_release_revision
          and part.bundle_format_version = p_bundle_format_version
          and part.section = item.value ->> 'section'
          and part.ordinal = (item.value ->> 'ordinal')::integer
        where part.content_bytes is distinct from pg_catalog.convert_to(item.value ->> 'content', 'UTF8')
      ) then
      raise exception using errcode = '23505',
        message = 'Installation runtime bundle pin fingerprint differs';
    end if;
  else
    for part_item in
      select item.value from pg_catalog.jsonb_array_elements(p_parts) as item(value)
    loop
      insert into vortex_module.installation_runtime_bundle_parts (
        organization_id, application_root_id, application_release_revision,
        bundle_format_version, section, ordinal, content_bytes
      ) values (
        selected_organization_id, p_application_root_id, p_application_release_revision,
        p_bundle_format_version, part_item ->> 'section',
        (part_item ->> 'ordinal')::integer,
        pg_catalog.convert_to(part_item ->> 'content', 'UTF8')
      );
    end loop;

    select stored.* into strict stored_bundle
    from vortex_module.installation_runtime_bundles as stored
    where stored.organization_id = selected_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.application_release_revision = p_application_release_revision
      and stored.bundle_format_version = p_bundle_format_version;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', stored_bundle.organization_id,
    'applicationRootId', stored_bundle.application_root_id,
    'applicationReleaseRevision', stored_bundle.application_release_revision,
    'bundleFormatVersion', stored_bundle.bundle_format_version,
    'pinFingerprint', stored_bundle.pin_fingerprint,
    'sourceManifest', stored_bundle.source_manifest,
    'parts', stored_bundle.parts,
    'totalSizeBytes', stored_bundle.total_size_bytes,
    'builtAt', stored_bundle.built_at
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Installation runtime bundle evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installation runtime bundle evidence is ambiguous';
end
$function$;

alter function vortex_module.write_installation_runtime_bundle_internal(uuid,bigint,integer,text,jsonb) owner to vortex_module_owner;

revoke all on function vortex_module.write_installation_runtime_bundle_internal(
  uuid, bigint, integer, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.write_installation_runtime_bundle_internal(
  uuid, bigint, integer, text, jsonb
) to vortex_request;
comment on function vortex_module.write_installation_runtime_bundle_internal(
  uuid, bigint, integer, text, jsonb
) is
  'Atomically stores one immutable runtime bundle for an authorised exact Application release and pin fingerprint.';



reset role;

commit;
