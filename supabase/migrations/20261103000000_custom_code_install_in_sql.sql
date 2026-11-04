-- SEC-1: installing, upgrading or uninstalling an Application that places custom components is
-- checked in SQL. Until now the custom code permission (platform.organization.custom_code.manage)
-- and the recent sign-in an install needs were enforced only by the TypeScript installer.
-- application_release_contains_custom_components_internal decides "the release contains custom
-- components" from the release content's platformBlockDependencies (the list the runtime bundle
-- registers) against the built-in block ids in vortex_definition.platform_block_catalogue, and
-- fails closed on a malformed list. require_custom_code_manage_internal(p_recent_sign_in) checks the
-- permission and, when asked, a primary sign-in within 15 minutes. activate_application_installation
-- asks for both; detach_application_installation checks the release being removed (a recent sign-in
-- only when a replacement is named); purge_application checks an installed application it removes
-- (no second sign-in: purge already asks for one).
set local role vortex_owner;

create table if not exists vortex_definition.platform_block_catalogue (
  block_id uuid primary key
);
alter table vortex_definition.platform_block_catalogue enable row level security;
alter table vortex_definition.platform_block_catalogue force row level security;
revoke all on table vortex_definition.platform_block_catalogue
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant select on table vortex_definition.platform_block_catalogue to postgres;
comment on table vortex_definition.platform_block_catalogue is
  'The built-in platform block ids (application-composition-catalogue.source.json); a block outside it is a custom component. Read only by application_release_contains_custom_components_internal.';
insert into vortex_definition.platform_block_catalogue (block_id) values
  ('11d1a889-531f-4880-a1a4-5dda5289e5ff'),
  ('148f420f-f7db-4145-80f4-3d3fa036096b'),
  ('15b2d6f6-228d-4248-84be-1f8f45e204fc'),
  ('2bd013f9-48ad-43d3-a6eb-7fc3c130cf87'),
  ('39217bcc-8fd1-4825-afca-e97598a13f0a'),
  ('39ab6f28-c166-47cf-91a7-f0b864ded4ff'),
  ('476e2c35-07d6-40cc-bf01-6ddb22ccca44'),
  ('5e7d5839-04fe-4b33-93c7-a382521a74b8'),
  ('651460f1-5fce-4443-bc9d-4dd4b6ae8a8b'),
  ('69e284dd-e253-484a-8aad-676026eebf0e'),
  ('6f2c8d94-1a7b-4e53-8d90-3c5e7b1a4f28'),
  ('771b25f4-168b-443c-8e9d-b6a1c1673b91'),
  ('78acc234-87bc-4e8f-986f-4857369b41f8'),
  ('78bfeead-a38d-424a-81b9-7cd553b92bcc'),
  ('8d1b6a2f-4c3e-4f0a-9c2b-6f1d2e7a5b94'),
  ('9c4e7a52-6b18-4d3f-8e21-5a7c0d9f2b64'),
  ('9cd96c38-95a1-4bd4-bfaa-0e20c4acb1b9'),
  ('9f8eaf39-8d16-47ef-9ef6-f22b1c9a5421'),
  ('a399ff74-5716-4411-bca8-c5ab87ec2e7d'),
  ('a3b7065b-47ef-4c92-93d1-59300f8b059c'),
  ('a5610880-05be-426b-a82b-7f3b645bf255'),
  ('a7c95d9b-3fc2-4e6c-bebb-7a62fa912d84'),
  ('addfad00-1b11-4674-83fa-913667f87e79'),
  ('b00f7a0f-9094-4186-b8c4-066b1df6c395'),
  ('b1a7c2e4-5d3f-4a91-8c26-0e7f4b9a1d33'),
  ('c4d9e1f2-7a68-4c05-9b3d-5f2a8e6c0b47'),
  ('c6fb63eb-fdf4-4fdf-954d-7610aad7be1b'),
  ('c8645b41-48b5-489c-bd2e-02283535a7c5'),
  ('d1125b70-e83b-4fc6-bf60-7a6e36f5f56a'),
  ('d5ecf8af-a6c4-4f0a-93e1-2c6d0a56a726'),
  ('e2569df0-2f10-4b20-b41d-177b66cd136c'),
  ('e2f4a1b7-3c58-4d09-9e62-1a7b5c8d0f24'),
  ('e9418c36-3234-4806-a05a-0f259482238d'),
  ('f40dc797-ac89-4687-8aa2-157c639be233')
on conflict (block_id) do nothing;

-- Whether an Application release places a platform block that is not a built-in block. A custom
-- component is a platform block release registered outside the built-in catalogue. The decision
-- reads the release content's platformBlockDependencies, the list the runtime bundle registers
-- (write_installation_runtime_bundle), and counts any block that
-- vortex_definition.platform_block_catalogue does not hold, so a block the database does not know
-- can never skip the custom code permission and recent sign-in that installing custom code needs. A
-- list that is missing or malformed counts too. A built-in block added to the platform block
-- catalogue (application-composition-catalogue.source.json) is added to that table in the same
-- change.
create or replace function vortex_definition.application_release_contains_custom_components_internal(
  p_application_root_id uuid,
  p_application_release_revision bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select pg_catalog.jsonb_typeof(source.dependencies) is distinct from 'array'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(source.dependencies) = 'array'
            then source.dependencies else '[]'::jsonb end
        ) as dependency(value)
        where pg_catalog.jsonb_typeof(dependency.value) is distinct from 'object'
          or dependency.value ->> 'blockId' is null
          or dependency.value ->> 'blockId' !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or not exists (
            select 1 from vortex_definition.platform_block_catalogue as built_in
            where built_in.block_id = (dependency.value ->> 'blockId')::uuid
          )
      )
    from (
      select release.compilation_output #> '{canonical,content,platformBlockDependencies}'
      from vortex_definition.releases as release
      where release.root_id = p_application_root_id
        and release.release_revision = p_application_release_revision
    ) as source(dependencies)
  ), true);
$function$;

alter function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint)
  owner to vortex_owner;

revoke all on function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint)
  to postgres;

comment on function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint) is
  'Private: true when the content of an Application release names a platform block that is not a built-in block, that is, a custom component, or a malformed list.';

create or replace function vortex_definition.require_custom_code_manage_internal(p_recent_sign_in boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  decision record;
begin
  context_value := vortex_access.validated_human_request_context();
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.custom_code.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(
        'platform.organization.custom_code.manage'
      ),
      -- The recent sign-in the TypeScript builder authority asks of an installation of custom code;
      -- an uninstall asks for none.
      'recentAuthentication', case when p_recent_sign_in
        then pg_catalog.jsonb_build_object('kind', 'primary', 'maximumAgeSeconds', 900)
        else pg_catalog.jsonb_build_object('kind', 'none') end,
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  -- Missing permission is named before a stale sign-in: signing in again cannot help without it.
  if decision.outcome = 'refused' and decision.reason_code = 'authentication_unsatisfied' then
    raise exception using errcode = 'V3150',
      message = 'Changing custom code needs a recent sign-in';
  end if;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.custom_code.manage'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.access_version is distinct from (context_value ->> 'accessVersion')::bigint
    or decision.organization_id is distinct from (context_value ->> 'organizationId')::uuid
    or decision.organization_account_id
      is distinct from (context_value ->> 'organizationAccountId')::uuid
    or decision.correlation_id is distinct from (context_value ->> 'correlationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Changing custom code needs the custom code permission';
  end if;
end
$function$;

alter function vortex_definition.require_custom_code_manage_internal(boolean)
  owner to vortex_owner;

revoke all on function vortex_definition.require_custom_code_manage_internal(boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.require_custom_code_manage_internal(boolean)
  to postgres;

comment on function vortex_definition.require_custom_code_manage_internal(boolean) is
  'Private check for installing, upgrading from or to, or uninstalling an Application that places custom components: the current person holds platform.organization.custom_code.manage and, when asked, signed in within 15 minutes.';

create or replace function vortex_definition.activate_application_installation(
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
  initial_authority record;
  current_authority record;
  application_release vortex_definition.releases%rowtype;
  permission_snapshot record;
  pin record;
  locked_binding vortex_definition.installation_bindings%rowtype;
  storage_provision record;
  expected_count integer;
  pin_count integer;
  all_provisioned boolean;
  all_active boolean;
  changed_value boolean;
  binding_evidence jsonb;
  sort_index_status jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) = 0
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or not item.value ?& array['moduleRootId', 'bindingRevision']
        or item.value - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
        or (item.value ->> 'moduleRootId')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
        or (item.value ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
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
      message = 'Application installation activation command is invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where root.root_id = p_application_root_id
    and root.organization_id = initial_authority.organization_id
    and root.kind = 'application'
    and release.release_revision = p_application_release_revision
    and release.validation_contract_version = any (vortex_definition.accepted_contract_version('application'))
    and release.compilation_output #>> '{kind}' = 'application'
    and release.compilation_output #>> '{canonical,envelope,rootId}' = p_application_root_id::text
    and release.compilation_output #>> '{validationContractVersion}' = any (vortex_definition.accepted_contract_version('application'));

  -- An Application that places custom components needs the custom code permission and a recent
  -- sign-in, decided here from the stored release and not only by the TypeScript installer.
  if vortex_definition.application_release_contains_custom_components_internal(
    p_application_root_id, p_application_release_revision
  ) then
    perform vortex_definition.require_custom_code_manage_internal(true);
  end if;

  select pg_catalog.count(*)::integer into pin_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if pin_count = 0 or expected_count <> pin_count
    or exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
        where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
      )
    ) then
    raise exception using errcode = '23514',
      message = 'Application installation binding set is incomplete';
  end if;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'vortex_definition.binding:' || initial_authority.organization_id::text || ':' ||
          p_application_root_id::text || ':' || pin.target_root_id::text,
        0
      )
    );
    perform 1
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id
    for update;
  end loop;

  select locked.* into strict current_authority
  from vortex_access.lock_application_installation_authority() as locked;
  if current_authority.organization_id <> initial_authority.organization_id
    or current_authority.organization_account_id <> initial_authority.organization_account_id
    or current_authority.access_version <> initial_authority.access_version
    or current_authority.correlation_id <> initial_authority.correlation_id then
    raise exception using errcode = '40001',
      message = 'Application installation authority changed';
  end if;

  select pg_catalog.bool_and(coalesce(
      binding.state = 'provisioned'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    )),
    pg_catalog.bool_and(coalesce(
      binding.state = 'active'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    ))
  into all_provisioned, all_active
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  left join vortex_definition.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id
  left join lateral (
    select (expected.value ->> 'bindingRevision')::bigint as binding_revision
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
  ) as expected on true
  ;
  if all_provisioned is null or (not all_provisioned and not all_active)
    or exists (
      select 1 from vortex_definition.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.state <> 'detached'
        and not exists (
          select 1 from vortex_definition.reachable_module_dependency_edges(
            p_application_root_id, p_application_release_revision
          ) as required
          where required.target_root_id = binding.module_root_id
        )
    ) then
    raise exception using errcode = '40001',
      message = 'Application installation bindings changed or are incomplete';
  end if;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    select binding.* into strict locked_binding
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id;

    select provision.* into strict storage_provision
    from vortex_record.read_exact_module_storage_provision(
      pin.target_root_id, pin.target_release_revision
    ) as provision;

    if locked_binding.storage_contract_ids <> storage_provision.storage_contract_ids then
      raise exception using errcode = '40001',
        message = 'Application installation storage evidence changed or is incomplete';
    end if;
  end loop;

  select snapshot.* into permission_snapshot
  from vortex_access.read_application_permission_snapshot(
    initial_authority.organization_id, p_application_root_id
  ) as snapshot;
  if not found
    or permission_snapshot.release_revision <> p_application_release_revision
    or permission_snapshot.definition_key <> (
      select root.key from vortex_definition.roots as root
      where root.root_id = p_application_root_id
    )
    or permission_snapshot.release_version <> application_release.release_version
    or permission_snapshot.validation_contract_version <> application_release.validation_contract_version
    or permission_snapshot.content_fingerprint <> application_release.content_fingerprint
    or permission_snapshot.resolution_fingerprint <> application_release.resolution_fingerprint then
    raise exception using errcode = '40001',
      message = 'Application permission registration is stale or unavailable';
  end if;

  changed_value := all_provisioned;
  if changed_value then
    if exists (
      select 1 from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      join vortex_definition.installation_bindings as binding
        on binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.module_root_id = required.target_root_id
      where binding.binding_revision = 9007199254740991
    ) then
      raise exception using errcode = '22003',
        message = 'Application installation binding revision is exhausted';
    end if;
    update vortex_definition.installation_bindings as binding
    set state = 'active', binding_revision = binding.binding_revision + 1,
      changed_at = pg_catalog.statement_timestamp()
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = required.target_root_id
      and binding.state = 'provisioned';
    if not found then
      raise exception using errcode = '40001',
        message = 'Application installation bindings changed';
    end if;
    sort_index_status := vortex_record.sync_published_sort_indexes_internal();
    perform vortex_platform.enqueue_installation_backfill_internal(
      initial_authority.organization_id, p_application_root_id, p_application_release_revision
    );
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'organizationId', binding.organization_id,
    'applicationRootId', binding.application_root_id,
    'moduleRootId', binding.module_root_id,
    'bindingRevision', binding.binding_revision,
    'applicationReleaseRevision', binding.application_release_revision,
    'moduleReleaseRevision', binding.module_release_revision,
    'state', binding.state
  ) order by binding.module_root_id) into binding_evidence
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  join vortex_definition.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'state', 'active', 'changed', changed_value,
    'sortIndexes', sort_index_status,
    'moduleBindings', binding_evidence
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application installation evidence is ambiguous';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Application installation activation command is invalid';
end
$function$;

alter function vortex_definition.activate_application_installation(uuid,bigint,jsonb) owner to vortex_owner;

revoke all on function vortex_definition.activate_application_installation(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.activate_application_installation(uuid, bigint, jsonb)
  to vortex_request;
comment on function vortex_definition.activate_application_installation(uuid, bigint, jsonb) is
  'Revision-checked atomic activation of the complete exact Module pin set for one Application release.';

create or replace function vortex_definition.detach_application_installation(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb,
  p_replacement_release_revision bigint default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  initial_authority record;
  current_authority record;
  pin record;
  expected_count integer;
  pin_count integer;
  all_active boolean;
  all_provisioned boolean;
  all_detached boolean;
  changed_value boolean;
  binding_evidence jsonb;
  sort_index_status jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) = 0
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or not item.value ?& array['moduleRootId', 'bindingRevision']
        or item.value - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
        or (item.value ->> 'moduleRootId')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
        or (item.value ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
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
      message = 'Application installation detach command is invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;

  -- Detaching only retires bindings, so an installed release of an earlier definition contract
  -- stays detachable: its identity is checked, never its contract version.
  if not exists (
    select 1
    from vortex_definition.roots as root
    join vortex_definition.releases as release on release.root_id = root.root_id
    where root.root_id = p_application_root_id
      and root.organization_id = initial_authority.organization_id
      and root.kind = 'application'
      and release.release_revision = p_application_release_revision
      and release.compilation_output #>> '{kind}' = 'application'
      and release.compilation_output #>> '{canonical,envelope,rootId}' = p_application_root_id::text
  ) then
    raise exception using errcode = 'P0002',
      message = 'Exact Application release is unavailable';
  end if;

  -- Removing an Application release that places custom components needs the custom code
  -- permission, whether it is uninstalled or replaced by an upgrade; an upgrade also needs a recent
  -- sign-in, as installing does (builder-authority.ts). Activation checks the replacing release.
  if vortex_definition.application_release_contains_custom_components_internal(
    p_application_root_id, p_application_release_revision
  ) then
    perform vortex_definition.require_custom_code_manage_internal(
      p_replacement_release_revision is not null
    );
  end if;

  -- A platform system Application is never uninstalled (architecture decision 11): it is detached
  -- only to be replaced by another release of the same Application, as an upgrade does.
  if exists (
    select 1
    from vortex_definition.roots as root
    where root.root_id = p_application_root_id
      and root.application_origin_kind = 'platform_system_application'
  ) and (
    p_replacement_release_revision is null
    or p_replacement_release_revision <= p_application_release_revision
    or not exists (
      select 1 from vortex_definition.releases as replacement
      where replacement.root_id = p_application_root_id
        and replacement.release_revision = p_replacement_release_revision
        and replacement.compilation_output #>> '{kind}' = 'application'
        and replacement.compilation_output #>> '{canonical,envelope,rootId}' = p_application_root_id::text
    )
  ) then
    raise exception using errcode = '42501',
      message = 'A platform application cannot be uninstalled';
  end if;
  -- The replacement is proved at commit: the deferred trigger
  -- system_application_stays_installed refuses a transaction that leaves a platform system
  -- Application without an active binding.

  select pg_catalog.count(*)::integer into pin_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if pin_count = 0 or expected_count <> pin_count
    or exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
        where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
      )
    ) then
    raise exception using errcode = '23514',
      message = 'Application installation binding set is incomplete';
  end if;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'vortex_definition.binding:' || initial_authority.organization_id::text || ':' ||
          p_application_root_id::text || ':' || pin.target_root_id::text,
        0
      )
    );
    perform 1
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id
    for update;
  end loop;

  select locked.* into strict current_authority
  from vortex_access.lock_application_installation_authority() as locked;
  if current_authority.organization_id <> initial_authority.organization_id
    or current_authority.organization_account_id <> initial_authority.organization_account_id
    or current_authority.access_version <> initial_authority.access_version
    or current_authority.correlation_id <> initial_authority.correlation_id then
    raise exception using errcode = '40001',
      message = 'Application installation authority changed';
  end if;

  -- Each accepted state must hold for the complete exact set; mixed states are refused.
  select pg_catalog.bool_and(coalesce(
      binding.state = 'active'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    )),
    pg_catalog.bool_and(coalesce(
      binding.state = 'provisioned'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    )),
    pg_catalog.bool_and(coalesce(
      binding.state = 'detached'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    ))
  into all_active, all_provisioned, all_detached
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  left join vortex_definition.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id
  left join lateral (
    select (expected.value ->> 'bindingRevision')::bigint as binding_revision
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
  ) as expected on true
  ;
  if all_active is null or (not all_active and not all_provisioned and not all_detached)
    or exists (
      select 1 from vortex_definition.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.state <> 'detached'
        and not exists (
          select 1 from vortex_definition.reachable_module_dependency_edges(
            p_application_root_id, p_application_release_revision
          ) as required
          where required.target_root_id = binding.module_root_id
        )
    ) then
    raise exception using errcode = '40001',
      message = 'Application installation bindings changed or are incomplete';
  end if;

  changed_value := all_active or all_provisioned;
  if changed_value then
    if exists (
      select 1 from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      join vortex_definition.installation_bindings as binding
        on binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.module_root_id = required.target_root_id
      where binding.binding_revision = 9007199254740991
    ) then
      raise exception using errcode = '22003',
        message = 'Application installation binding revision is exhausted';
    end if;
    update vortex_definition.installation_bindings as binding
    set state = 'detached', binding_revision = binding.binding_revision + 1,
      changed_at = pg_catalog.statement_timestamp()
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = required.target_root_id
      and binding.state in ('active', 'provisioned');
    if not found then
      raise exception using errcode = '40001',
        message = 'Application installation bindings changed';
    end if;
    sort_index_status := vortex_record.sync_published_sort_indexes_internal();
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'organizationId', binding.organization_id,
    'applicationRootId', binding.application_root_id,
    'moduleRootId', binding.module_root_id,
    'bindingRevision', binding.binding_revision,
    'applicationReleaseRevision', binding.application_release_revision,
    'moduleReleaseRevision', binding.module_release_revision,
    'state', binding.state
  ) order by binding.module_root_id) into binding_evidence
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  join vortex_definition.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'state', 'detached', 'changed', changed_value,
    'sortIndexes', sort_index_status,
    'moduleBindings', binding_evidence
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application installation evidence is ambiguous';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Application installation detach command is invalid';
end
$function$;

alter function vortex_definition.detach_application_installation(uuid,bigint,jsonb,bigint) owner to vortex_owner;

revoke all on function vortex_definition.detach_application_installation(uuid, bigint, jsonb, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.detach_application_installation(uuid, bigint, jsonb, bigint)
  to vortex_request;
comment on function vortex_definition.detach_application_installation(uuid, bigint, jsonb, bigint) is
  'Revision-checked atomic detach of one complete Application Module binding set while retaining storage and records. A platform system Application is detached only to be replaced by another release of it. A release that places custom components needs the custom code permission to be removed.';

-- Counts, or with p_apply removes, everything one ordinary application and the modules it owns
-- hold in the validated organisation, in one transaction under the application installation
-- authority. The proof of what may be removed (purge_application_review_internal) and the
-- deletion of the protected history (purge_application_history_internal, owned by the only role
-- the history protection lets delete) both prove it again themselves; this function only
-- sequences them, then removes the roots and records the change.
create or replace function vortex_definition.purge_application(
  p_application_root_id uuid,
  p_apply boolean,
  p_delete_only boolean,
  p_confirmed_name text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  impact jsonb;
  context_value jsonb;
begin
  if p_application_root_id is null or p_apply is null or p_delete_only is null then
    raise exception using errcode = '22023',
      message = 'Application purge command is invalid';
  end if;

  -- Purging or deleting needs a recent sign-in, as the installation authority in TypeScript says.
  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority(
    case when p_apply then pg_catalog.jsonb_build_object('kind', 'primary', 'maximumAgeSeconds', 900) end
  ) as locked;

  -- Purging an installed Application that places custom components uninstalls custom code.
  if p_apply and exists (
    select 1
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.state <> 'detached'
      and vortex_definition.application_release_contains_custom_components_internal(
        binding.application_root_id, binding.application_release_revision
      )
  ) then
    perform vortex_definition.require_custom_code_manage_internal(false);
  end if;

  -- Without a typed name this only reads; with p_apply the typed name is required and proved.
  impact := vortex_definition.purge_application_review_internal(
    authority.organization_id,
    p_application_root_id,
    p_delete_only,
    case when p_apply then coalesce(p_confirmed_name, '') else null end);
  if not p_apply then
    return impact;
  end if;

  perform vortex_definition.purge_application_history_internal(
    authority.organization_id, p_application_root_id, p_delete_only, p_confirmed_name);
  perform vortex_definition.purge_application_roots_internal(
    authority.organization_id, p_application_root_id);

  context_value := vortex_access.validated_human_request_context();
  perform vortex_access.increment_organization_access_version(
    authority.organization_id,
    authority.organization_account_id,
    authority.correlation_id,
    'application_access_changed'
  );
  perform vortex_record.append_organization_activity_entry(
    authority.organization_id,
    pg_catalog.gen_random_uuid(),
    pg_catalog.statement_timestamp(),
    'organization_account',
    authority.organization_account_id,
    case when p_delete_only then 'delete_application' else 'purge_application' end,
    array[p_application_root_id]::uuid[],
    array[]::uuid[],
    vortex_platform.channel(),
    (context_value ->> 'correlationId')::uuid,
    'completed'
  );

  return pg_catalog.jsonb_build_object(
    'roles', impact -> 'roles',
    'role_assignments', impact -> 'role_assignments',
    'permission_entries', impact -> 'permission_entries',
    'releases', impact -> 'releases',
    'records', impact -> 'records',
    'record_tables', impact -> 'record_tables'
  );
end
$function$;

revoke all on function vortex_definition.purge_application(uuid, boolean, boolean, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.purge_application(uuid, boolean, boolean, text)
  to vortex_request;

comment on function vortex_definition.purge_application(uuid, boolean, boolean, text) is
  'Counts, or with p_apply removes, everything one ordinary Application and the Modules it owns hold in the validated organisation, in one transaction under the application installation authority: the protected history through the one role allowed to delete it, then the roots. A system application, the default application and an application another one depends on are refused; p_delete_only also refuses an installed application; the typed name is required and proved to remove.';

alter function vortex_definition.purge_application(uuid, boolean, boolean, text) owner to vortex_owner;

reset role;
