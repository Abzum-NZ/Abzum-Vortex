-- #1495: immutable runtime bundles belong to one exact installation release and pin set.

begin;

grant usage on schema extensions to vortex_module_owner;
grant execute on function extensions.digest(bytea, text) to vortex_module_owner;
grant usage on schema vortex_identity to vortex_module_owner;

set local role vortex_module_owner;

create table vortex_module.installation_runtime_bundles (
  organization_id uuid not null references vortex_identity.organizations,
  application_root_id uuid not null,
  application_release_revision bigint not null
    check (application_release_revision between 1 and 9007199254740991),
  bundle_format_version integer not null check (bundle_format_version > 0),
  pin_fingerprint text not null check (pin_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  parts jsonb not null check (
    pg_catalog.jsonb_typeof(parts) = 'array'
    and pg_catalog.jsonb_array_length(parts) >= 8
  ),
  total_size_bytes bigint not null check (total_size_bytes between 1 and 9007199254740991),
  built_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint installation_runtime_bundles_pk primary key (
    organization_id, application_root_id, application_release_revision, bundle_format_version
  ),
  constraint installation_runtime_bundles_application_release_fk
    foreign key (application_root_id, application_release_revision)
    references vortex_definition.releases (root_id, release_revision)
);

create table vortex_module.installation_runtime_bundle_parts (
  organization_id uuid not null,
  application_root_id uuid not null,
  application_release_revision bigint not null,
  bundle_format_version integer not null,
  section text not null check (section in (
    'pages', 'navigation', 'flows', 'trigger_index', 'theme', 'component_registry',
    'access_plan', 'tool_bundle'
  )),
  ordinal integer not null check (ordinal >= 0),
  content_bytes bytea not null check (
    pg_catalog.octet_length(content_bytes) between 1 and 1048575
  ),
  constraint installation_runtime_bundle_parts_pk primary key (
    organization_id, application_root_id, application_release_revision,
    bundle_format_version, section, ordinal
  ),
  constraint installation_runtime_bundle_parts_bundle_fk foreign key (
    organization_id, application_root_id, application_release_revision, bundle_format_version
  ) references vortex_module.installation_runtime_bundles (
    organization_id, application_root_id, application_release_revision, bundle_format_version
  )
);

alter table vortex_module.installation_runtime_bundles enable row level security;
alter table vortex_module.installation_runtime_bundles force row level security;
alter table vortex_module.installation_runtime_bundle_parts enable row level security;
alter table vortex_module.installation_runtime_bundle_parts force row level security;

create policy installation_runtime_bundles_owner
  on vortex_module.installation_runtime_bundles to vortex_module_owner
  using (true) with check (true);
create policy installation_runtime_bundle_parts_owner
  on vortex_module.installation_runtime_bundle_parts to vortex_module_owner
  using (true) with check (true);

revoke all on table vortex_module.installation_runtime_bundles,
  vortex_module.installation_runtime_bundle_parts
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter;

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
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_bundle_format_version is distinct from 1
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
    bundle_format_version, pin_fingerprint, parts, total_size_bytes
  ) values (
    selected_organization_id, p_application_root_id, p_application_release_revision,
    p_bundle_format_version, p_pin_fingerprint, parts_manifest, total_size_value
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
    if stored_bundle.pin_fingerprint <> p_pin_fingerprint then
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
    or p_bundle_format_version is null or p_bundle_format_version < 1 then
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

create or replace function vortex_module.read_installation_runtime_bundle_parts(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_bundle_format_version integer,
  p_sections jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  allowed_sections constant text[] := array[
    'pages', 'navigation', 'flows', 'trigger_index', 'theme', 'component_registry',
    'access_plan', 'tool_bundle'
  ];
  checked_context jsonb;
  selected_organization_id uuid;
  requested_sections text[];
  parts_value jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_bundle_format_version is null or p_bundle_format_version < 1
    or p_sections is null or pg_catalog.jsonb_typeof(p_sections) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle read command is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_sections) not between 1 and
    pg_catalog.cardinality(allowed_sections) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle read command is invalid';
  end if;
  if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_sections) as requested(value)
      where pg_catalog.jsonb_typeof(requested.value) is distinct from 'string'
        or not ((requested.value #>> '{}') = any (allowed_sections))
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_sections) as requested(value)
      group by requested.value
      having pg_catalog.count(*) > 1
    ) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle read command is invalid';
  end if;
  select pg_catalog.array_agg(requested.value #>> '{}' order by requested.ordinality)
  into requested_sections
  from pg_catalog.jsonb_array_elements(p_sections) with ordinality as requested(value, ordinality);

  checked_context := vortex_access.validated_human_request_context();
  selected_organization_id := (checked_context ->> 'organizationId')::uuid;
  if selected_organization_id is null then
    raise exception using errcode = '42501',
      message = 'Installation runtime bundle organisation is unavailable';
  end if;

  if not exists (
    select 1 from vortex_module.installation_runtime_bundles as stored
    where stored.organization_id = selected_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.application_release_revision = p_application_release_revision
      and stored.bundle_format_version = p_bundle_format_version
  ) then
    raise exception using errcode = 'P0002',
      message = 'Installation runtime bundle is unavailable';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'section', part.section,
      'ordinal', part.ordinal,
      'byteSize', pg_catalog.octet_length(part.content_bytes),
      'sha256', 'sha256:' || pg_catalog.encode(
        extensions.digest(part.content_bytes, 'sha256'), 'hex'
      ),
      'content', pg_catalog.convert_from(part.content_bytes, 'UTF8')
    ) order by pg_catalog.array_position(requested_sections, part.section), part.ordinal
  ), '[]'::jsonb)
  into parts_value
  from vortex_module.installation_runtime_bundle_parts as part
  where part.organization_id = selected_organization_id
    and part.application_root_id = p_application_root_id
    and part.application_release_revision = p_application_release_revision
    and part.bundle_format_version = p_bundle_format_version
    and part.section = any (requested_sections);

  return parts_value;
end
$function$;

revoke all on function vortex_module.read_installation_runtime_bundle_parts(
  uuid, bigint, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.read_installation_runtime_bundle_parts(
  uuid, bigint, integer, jsonb
) to vortex_request;
comment on function vortex_module.read_installation_runtime_bundle_parts(
  uuid, bigint, integer, jsonb
) is
  'Reads selected immutable runtime bundle parts by exact key inside the verified organisation context.';

reset role;

commit;
