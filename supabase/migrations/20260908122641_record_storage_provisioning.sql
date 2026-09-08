-- Generic Record storage allocation from exact immutable Module V2 releases.

do $roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_record_owner') then
    create role vortex_record_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_record_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_record_adapter') then
    create role vortex_record_adapter nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_record_adapter nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_module_owner') then
    create role vortex_module_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_module_owner nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
end
$roles$;

revoke vortex_record_owner, vortex_record_adapter, vortex_module_owner
  from anon, authenticated, service_role, vortex_runtime, vortex_request;
grant vortex_record_owner, vortex_record_adapter, vortex_module_owner
  to postgres with inherit false, set true;

create schema if not exists vortex_record authorization vortex_record_owner;
create schema if not exists vortex_module authorization vortex_module_owner;
create schema if not exists record_data authorization vortex_record_owner;
alter schema vortex_record owner to vortex_record_owner;
alter schema vortex_module owner to vortex_module_owner;
alter schema record_data owner to vortex_record_owner;

set local role vortex_record_owner;
revoke all on schema vortex_record, record_data
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant usage on schema vortex_record, record_data to vortex_record_adapter;
reset role;
set local role vortex_module_owner;
revoke all on schema vortex_module
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant usage on schema vortex_module to vortex_request;
reset role;

set local role vortex_record_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
alter default privileges in schema record_data
  revoke all on tables from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
reset role;
set local role vortex_module_owner;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;
reset role;

-- The migration role may create only the reviewed objects below, then returns
-- CREATE to the canonical non-login owners before the transaction completes.
set local role vortex_record_owner;
grant create on schema vortex_record, record_data to postgres;
reset role;
set local role vortex_module_owner;
grant create on schema vortex_module to postgres;
reset role;

create table vortex_record.storage_catalogue (
  storage_contract_id uuid primary key,
  physical_schema_token text not null check (physical_schema_token = 'record_data'),
  physical_table_token text not null unique check (
    physical_table_token ~ '^rt_[a-f0-9]{32}$'
  ),
  module_root_id uuid not null,
  record_type_id uuid not null,
  storage_scope text not null check (
    storage_scope in ('organization_shared', 'application_contained')
  ),
  first_compatible_release_revision bigint not null check (
    first_compatible_release_revision between 1 and 9007199254740991
  ),
  last_compatible_release_revision bigint check (
    last_compatible_release_revision between first_compatible_release_revision
      and 9007199254740991
  ),
  state text not null check (state in ('planned', 'active', 'retired')),
  generator_contract_version text not null check (generator_contract_version = '1.0.0'),
  content_fingerprint text not null check (content_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  record_type_definition jsonb not null check (
    pg_catalog.jsonb_typeof(record_type_definition) = 'object'
  ),
  changed_at timestamptz not null default pg_catalog.statement_timestamp()
);

create table vortex_record.field_storage_mappings (
  storage_contract_id uuid not null references vortex_record.storage_catalogue,
  field_id uuid not null,
  physical_column_token text not null check (physical_column_token ~ '^f_[a-f0-9]{32}$'),
  database_value_type text not null check (database_value_type in (
    'boolean', 'date', 'decimal', 'integer', 'json', 'text',
    'timestamp_with_time_zone', 'uuid'
  )),
  field_definition jsonb not null check (pg_catalog.jsonb_typeof(field_definition) = 'object'),
  introduced_by_module_root_id uuid not null,
  introduced_at_release_revision bigint not null check (
    introduced_at_release_revision between 1 and 9007199254740991
  ),
  retired_by_module_root_id uuid,
  retired_at_release_revision bigint,
  state text not null check (state in ('planned', 'active', 'retired')),
  primary key (storage_contract_id, field_id),
  unique (storage_contract_id, physical_column_token),
  check ((retired_by_module_root_id is null) = (retired_at_release_revision is null)),
  check ((state = 'retired') = (retired_at_release_revision is not null))
);

create table vortex_record.relationship_storage_mappings (
  relationship_id uuid primary key,
  module_root_id uuid not null,
  release_revision bigint not null check (release_revision between 1 and 9007199254740991),
  source_storage_contract_id uuid not null references vortex_record.storage_catalogue,
  source_field_id uuid not null,
  target_record_type_ids uuid[] not null check (pg_catalog.cardinality(target_record_type_ids) > 0),
  cardinality text not null check (cardinality in ('one_to_one', 'many_to_one', 'many_to_many')),
  on_parent_delete text not null check (
    on_parent_delete in ('refuse', 'empty_optional', 'soft_delete_dependent')
  ),
  definition jsonb not null check (pg_catalog.jsonb_typeof(definition) = 'object'),
  foreign key (source_storage_contract_id, source_field_id)
    references vortex_record.field_storage_mappings (storage_contract_id, field_id)
);

create table vortex_record.relationship_edges (
  relationship_id uuid not null references vortex_record.relationship_storage_mappings,
  from_organisation_id uuid not null,
  to_organisation_id uuid not null,
  from_application_root_id uuid,
  to_application_root_id uuid,
  from_storage_contract_id uuid not null references vortex_record.storage_catalogue,
  from_record_id uuid not null,
  to_storage_contract_id uuid not null references vortex_record.storage_catalogue,
  to_record_id uuid not null,
  primary key (relationship_id, from_organisation_id, from_record_id,
    to_storage_contract_id, to_record_id),
  check (from_organisation_id = to_organisation_id),
  foreign key (from_organisation_id) references vortex_identity.organizations (organization_id),
  foreign key (to_organisation_id) references vortex_identity.organizations (organization_id)
);

create table vortex_record.release_provisions (
  module_root_id uuid not null,
  release_revision bigint not null,
  content_fingerprint text not null check (content_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  resolution_fingerprint text not null check (resolution_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  generator_contract_version text not null check (generator_contract_version = '1.0.0'),
  storage_contract_ids uuid[] not null check (pg_catalog.cardinality(storage_contract_ids) > 0),
  provisioned_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (module_root_id, release_revision),
  foreign key (module_root_id, release_revision)
    references vortex_definition.releases (root_id, release_revision)
);

create table vortex_module.installation_bindings (
  organization_id uuid not null references vortex_identity.organizations,
  application_root_id uuid not null,
  module_root_id uuid not null,
  binding_revision bigint not null check (binding_revision between 1 and 9007199254740991),
  application_release_revision bigint not null,
  module_release_revision bigint not null,
  state text not null check (state in ('provisioned', 'active', 'detached')),
  content_fingerprint text not null check (content_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  resolution_fingerprint text not null check (resolution_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  generator_contract_version text not null check (generator_contract_version = '1.0.0'),
  storage_contract_ids uuid[] not null check (pg_catalog.cardinality(storage_contract_ids) > 0),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (organization_id, application_root_id, module_root_id),
  foreign key (application_root_id, application_release_revision)
    references vortex_definition.releases (root_id, release_revision),
  foreign key (module_root_id, module_release_revision)
    references vortex_definition.releases (root_id, release_revision)
);

alter table vortex_record.storage_catalogue enable row level security;
alter table vortex_record.storage_catalogue force row level security;
alter table vortex_record.field_storage_mappings enable row level security;
alter table vortex_record.field_storage_mappings force row level security;
alter table vortex_record.relationship_storage_mappings enable row level security;
alter table vortex_record.relationship_storage_mappings force row level security;
alter table vortex_record.relationship_edges enable row level security;
alter table vortex_record.relationship_edges force row level security;
alter table vortex_record.release_provisions enable row level security;
alter table vortex_record.release_provisions force row level security;
alter table vortex_module.installation_bindings enable row level security;
alter table vortex_module.installation_bindings force row level security;

create policy storage_catalogue_owner on vortex_record.storage_catalogue
  to vortex_record_owner using (true) with check (true);
create policy field_storage_mappings_owner on vortex_record.field_storage_mappings
  to vortex_record_owner using (true) with check (true);
create policy relationship_storage_mappings_owner
  on vortex_record.relationship_storage_mappings
  to vortex_record_owner using (true) with check (true);
create policy relationship_edges_owner on vortex_record.relationship_edges
  to vortex_record_owner using (true) with check (true);
create policy release_provisions_owner on vortex_record.release_provisions
  to vortex_record_owner using (true) with check (true);
create policy installation_bindings_owner on vortex_module.installation_bindings
  to vortex_module_owner using (true) with check (true);

create index relationship_storage_mappings_source_idx
  on vortex_record.relationship_storage_mappings (
    source_storage_contract_id, source_field_id
  );
create index relationship_edges_from_storage_idx
  on vortex_record.relationship_edges (from_storage_contract_id);
create index relationship_edges_to_storage_idx
  on vortex_record.relationship_edges (to_storage_contract_id);
create index relationship_edges_from_organisation_idx
  on vortex_record.relationship_edges (from_organisation_id);
create index relationship_edges_to_organisation_idx
  on vortex_record.relationship_edges (to_organisation_id);
create index installation_bindings_application_release_idx
  on vortex_module.installation_bindings (
    application_root_id, application_release_revision
  );
create index installation_bindings_module_release_idx
  on vortex_module.installation_bindings (module_root_id, module_release_revision);

alter table vortex_record.storage_catalogue owner to vortex_record_owner;
alter table vortex_record.field_storage_mappings owner to vortex_record_owner;
alter table vortex_record.relationship_storage_mappings owner to vortex_record_owner;
alter table vortex_record.relationship_edges owner to vortex_record_owner;
alter table vortex_record.release_provisions owner to vortex_record_owner;
alter table vortex_module.installation_bindings owner to vortex_module_owner;

create function vortex_record.database_value_type(p_field jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when p_field ->> 'type' in ('calculation', 'total') then
      case p_field #>> '{settings,resultType}'
        when 'whole_number' then 'integer'
        when 'decimal_number' then 'decimal'
        when 'yes_no' then 'boolean'
        when 'date' then 'date'
        when 'date_time' then 'timestamp_with_time_zone'
        when 'money' then 'json'
        when 'text' then 'text'
        else null
      end
    else case p_field ->> 'type'
    when 'whole_number' then 'integer'
    when 'decimal_number' then 'decimal'
    when 'yes_no' then 'boolean'
    when 'date' then 'date'
    when 'date_time' then 'timestamp_with_time_zone'
    when 'link' then 'json'
    when 'link_to_one_of_several' then 'json'
    when 'link_to_person' then 'json'
    when 'formatted_text' then 'json'
    when 'several_choices' then 'json'
    when 'table' then 'json'
    when 'money' then 'json'
    when 'attachment' then 'json'
    when 'text' then 'text'
    when 'long_text' then 'text'
    when 'reference_number' then 'text'
    when 'email_address' then 'text'
    when 'phone_number' then 'text'
    when 'web_address' then 'text'
    when 'choice' then 'text'
    else null
    end
  end
$function$;

create function vortex_record.enforce_relationship_edge_scope()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  relationship_row vortex_record.relationship_storage_mappings%rowtype;
  source_row vortex_record.storage_catalogue%rowtype;
  target_row vortex_record.storage_catalogue%rowtype;
begin
  select mapping.* into strict relationship_row
  from vortex_record.relationship_storage_mappings as mapping
  where mapping.relationship_id = new.relationship_id;
  select catalogue.* into strict source_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = new.from_storage_contract_id;
  select catalogue.* into strict target_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = new.to_storage_contract_id;
  if relationship_row.source_storage_contract_id <> new.from_storage_contract_id
    or target_row.record_type_id <> all (relationship_row.target_record_type_ids)
    or (source_row.storage_scope = 'organization_shared') <> (new.from_application_root_id is null)
    or (target_row.storage_scope = 'organization_shared') <> (new.to_application_root_id is null)
    or (
      source_row.storage_scope = 'application_contained'
      and target_row.storage_scope = 'application_contained'
      and new.from_application_root_id <> new.to_application_root_id
    ) then
    raise exception using errcode = '23514', message = 'Relationship edge scope is invalid';
  end if;
  return new;
exception when no_data_found or too_many_rows then
  raise exception using errcode = '23514', message = 'Relationship edge mapping is unavailable';
end
$function$;

set local role vortex_record_owner;
grant trigger on vortex_record.relationship_edges to postgres;
reset role;
create trigger relationship_edges_scope
before insert or update on vortex_record.relationship_edges
for each row execute function vortex_record.enforce_relationship_edge_scope();

create function vortex_record.sql_value_type(p_database_value_type text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case p_database_value_type
    when 'integer' then 'bigint'
    when 'decimal' then 'numeric'
    when 'boolean' then 'boolean'
    when 'date' then 'date'
    when 'timestamp_with_time_zone' then 'timestamp with time zone'
    when 'uuid' then 'uuid'
    when 'json' then 'jsonb'
    else 'text'
  end
$function$;

create function vortex_record.storage_meaning(p_record_type jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'recordTypeId', p_record_type -> 'recordTypeId',
    'storageContractId', p_record_type -> 'storageContractId',
    'storageScope', p_record_type -> 'storageScope',
    'ownershipMode', p_record_type -> 'ownershipMode',
    'fields', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'fieldId', field.value -> 'fieldId',
        'type', field.value -> 'type',
        'required', field.value -> 'required',
        'unique', field.value -> 'unique',
        'filterable', field.value -> 'filterable',
        'sortable', field.value -> 'sortable',
        'settings', field.value -> 'settings'
      ) order by field.value ->> 'fieldId')
      from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as field(value)
    ), '[]'::jsonb),
    'relationships', coalesce((
      select pg_catalog.jsonb_agg(relationship.value order by relationship.value ->> 'relationshipId')
      from pg_catalog.jsonb_array_elements(p_record_type -> 'relationships') as relationship(value)
    ), '[]'::jsonb)
  )
$function$;

create function vortex_record.storage_meaning_fingerprint(p_record_type jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select 'sha256:' || pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(vortex_record.storage_meaning(p_record_type)::text, 'UTF8'), 'sha256'),
    'hex'
  )
$function$;

create function vortex_record.field_storage_meaning(p_field jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'fieldId', p_field -> 'fieldId',
    'type', p_field -> 'type',
    'required', p_field -> 'required',
    'unique', p_field -> 'unique',
    'filterable', p_field -> 'filterable',
    'sortable', p_field -> 'sortable',
    'settings', p_field -> 'settings'
  )
$function$;

grant usage on schema extensions, vortex_context, vortex_definition,
  vortex_identity, vortex_access to vortex_record_owner;
grant select on vortex_definition.roots, vortex_definition.releases,
  vortex_definition.release_dependencies to vortex_record_owner;
create policy record_storage_definition_roots_read on vortex_definition.roots
  for select to vortex_record_owner using (true);
create policy record_storage_definition_releases_read on vortex_definition.releases
  for select to vortex_record_owner using (true);
create policy record_storage_definition_dependencies_read
  on vortex_definition.release_dependencies
  for select to vortex_record_owner using (true);
grant references on vortex_definition.releases to vortex_record_owner, vortex_module_owner;
grant references on vortex_identity.organizations,
  vortex_identity.organization_accounts to vortex_record_owner, vortex_module_owner;
grant references on vortex_access.organization_groups to vortex_record_owner;
grant execute on function vortex_context.is_non_nil_uuid(text) to vortex_record_owner;
grant usage on schema vortex_context to vortex_record_adapter;
grant execute on function vortex_context.current_context(),
  vortex_context.organization_id(),
  vortex_context.application_root_id(boolean) to vortex_record_adapter;

create function vortex_record.provision_exact_module_storage(
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns table (
  module_root_id uuid,
  release_revision bigint,
  content_fingerprint text,
  resolution_fingerprint text,
  generator_contract_version text,
  storage_contract_ids uuid[],
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  record_types jsonb;
  record_type jsonb;
  stored_catalogue vortex_record.storage_catalogue%rowtype;
  stored_field vortex_record.field_storage_mappings%rowtype;
  field_value jsonb;
  relationship_value jsonb;
  target_value jsonb;
  target_ids uuid[];
  storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  relationship_id_value uuid;
  table_token text;
  column_token text;
  storage_scope_value text;
  ownership_mode_value text;
  database_type text;
  sql_type text;
  shape_fingerprint text;
  scope_check text;
  owner_check text;
  scope_index_columns text;
  result_storage_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
begin
  if not vortex_context.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Record storage release selector is invalid';
  end if;

  select release.* into strict release_row
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision
    and root.kind = 'module';
  if release_row.validation_contract_version <> '2.0.0'
    or release_row.compilation_output #>> '{kind}' <> 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}' <> p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}' <> '2.0.0' then
    raise exception using errcode = '23514', message = 'Exact Module V2 release is incompatible';
  end if;

  record_types := release_row.compilation_output #> '{canonical,content,recordTypes}';
  if pg_catalog.jsonb_typeof(record_types) <> 'array'
    or pg_catalog.jsonb_array_length(record_types) < 1 then
    raise exception using errcode = '23514', message = 'Module record storage definition is incompatible';
  end if;

  perform 1 from vortex_record.release_provisions as provision
  where provision.module_root_id = p_module_root_id
    and provision.release_revision = p_module_release_revision
  for update;
  if found then
    select provision.storage_contract_ids into result_storage_ids
    from vortex_record.release_provisions as provision
    where provision.module_root_id = p_module_root_id
      and provision.release_revision = p_module_release_revision
      and provision.content_fingerprint = release_row.content_fingerprint
      and provision.resolution_fingerprint = release_row.resolution_fingerprint
      and provision.generator_contract_version = '1.0.0';
    if result_storage_ids is null then
      raise exception using errcode = '55000', message = 'Stored release provision evidence is incompatible';
    end if;
    if result_storage_ids is distinct from (
      select pg_catalog.array_agg((item.value ->> 'storageContractId')::uuid order by item.value ->> 'storageContractId')
      from pg_catalog.jsonb_array_elements(record_types) as item(value)
    ) then
      raise exception using errcode = '55000', message = 'Stored release provision identities are incompatible';
    end if;
    result_storage_ids := array[]::uuid[];
  end if;

  if (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'storageContractId')
      or pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module record storage identities are duplicated';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    where (
      select pg_catalog.count(*) <> pg_catalog.count(distinct field_item.value ->> 'fieldId')
      from pg_catalog.jsonb_array_elements(record_item.value -> 'fields') as field_item(value)
    )
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct relationship_item.value ->> 'relationshipId')
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'relationships'
    ) as relationship_item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module field or relationship identities are duplicated';
  end if;

  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
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
    if not vortex_context.is_non_nil_uuid(storage_id::text)
      or not vortex_context.is_non_nil_uuid(record_type_id_value::text)
      or storage_scope_value not in ('organization_shared', 'application_contained')
      or ownership_mode_value not in ('none', 'organization_account', 'group', 'inherited')
      or pg_catalog.jsonb_typeof(record_type -> 'fields') <> 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') <> 'array' then
      raise exception using errcode = '42501', message = 'Module record storage definition is invalid';
    end if;
    -- The record-type loop is ordered by storage identity, so overlapping
    -- provisions acquire absent and existing lineage locks deterministically.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || storage_id::text, 0)
    );
    table_token := 'rt_' || pg_catalog.replace(pg_catalog.lower(storage_id::text), '-', '');
    shape_fingerprint := vortex_record.storage_meaning_fingerprint(record_type);
    result_storage_ids := result_storage_ids || storage_id;
    scope_index_columns := case storage_scope_value
      when 'organization_shared' then 'organisation_id'
      else 'organisation_id, application_root_id'
    end;

    select catalogue.* into stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_id
    for update;

    if not found then
      scope_check := case storage_scope_value
        when 'organization_shared' then 'application_root_id is null'
        else 'application_root_id is not null'
      end;
      owner_check := case ownership_mode_value
        when 'organization_account' then
          'owner_organisation_account_id is not null and owner_group_id is null'
        when 'group' then
          'owner_organisation_account_id is null and owner_group_id is not null'
        else 'owner_organisation_account_id is null and owner_group_id is null'
      end;
      execute pg_catalog.format(
        'create table record_data.%I (
          organisation_id uuid not null references vortex_identity.organizations (organization_id),
          module_root_id uuid not null check (module_root_id = %L::uuid),
          record_type_id uuid not null check (record_type_id = %L::uuid),
          storage_contract_id uuid not null check (storage_contract_id = %L::uuid),
          record_id uuid not null,
          application_root_id uuid,
          definition_revision bigint not null check (definition_revision between 1 and 9007199254740991),
          owner_organisation_account_id uuid,
          owner_group_id uuid,
          lifecycle_state text not null check (lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')),
          concurrency_number bigint not null check (concurrency_number between 1 and 9007199254740991),
          created_at timestamptz not null,
          created_by uuid not null,
          updated_at timestamptz not null,
          updated_by uuid not null,
          deleted_at timestamptz,
          deleted_by uuid,
          removal_due_at timestamptz,
          primary key (%s, record_id),
          foreign key (organisation_id, owner_organisation_account_id)
            references vortex_identity.organization_accounts (organization_id, organization_account_id),
          foreign key (organisation_id, owner_group_id)
            references vortex_access.organization_groups (organization_id, group_id),
          check (%s), check (%s),
          check ((deleted_at is null) = (deleted_by is null)),
          check ((lifecycle_state = ''active'') = (deleted_at is null and deleted_by is null)),
          check (updated_at >= created_at)
        )', table_token, p_module_root_id, record_type_id_value, storage_id,
        scope_index_columns, scope_check, owner_check
      );
      execute pg_catalog.format('alter table record_data.%I enable row level security', table_token);
      execute pg_catalog.format('alter table record_data.%I force row level security', table_token);
      execute pg_catalog.format(
        'create policy record_select on record_data.%I for select to vortex_record_adapter using (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'create policy record_insert on record_data.%I for insert to vortex_record_adapter with check (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'create policy record_update on record_data.%I for update to vortex_record_adapter using (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        ) with check (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'create policy record_delete on record_data.%I for delete to vortex_record_adapter using (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'grant select, insert, update, delete on record_data.%I to vortex_record_adapter',
        table_token
      );

      insert into vortex_record.storage_catalogue (
        storage_contract_id, physical_schema_token, physical_table_token,
        module_root_id, record_type_id, storage_scope,
        first_compatible_release_revision, last_compatible_release_revision,
        state, generator_contract_version, content_fingerprint, record_type_definition
      ) values (
        storage_id, 'record_data', table_token, p_module_root_id,
        record_type_id_value, storage_scope_value, p_module_release_revision,
        p_module_release_revision, 'active', '1.0.0', shape_fingerprint, record_type
      );
      any_change := true;
    else
      if stored_catalogue.module_root_id <> p_module_root_id
        or stored_catalogue.record_type_id <> record_type_id_value
        or stored_catalogue.storage_scope <> storage_scope_value
        or stored_catalogue.state <> 'active'
        or stored_catalogue.generator_contract_version <> '1.0.0'
        or stored_catalogue.physical_schema_token <> 'record_data'
        or stored_catalogue.physical_table_token <> table_token
        or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
        raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
      end if;
    end if;

    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      begin
        field_id_value := (field_value ->> 'fieldId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '42501', message = 'Record field storage identity is invalid';
      end;
      if not vortex_context.is_non_nil_uuid(field_id_value::text)
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

      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.state <> 'active'
          or vortex_record.field_storage_meaning(stored_field.field_definition)
            is distinct from vortex_record.field_storage_meaning(field_value)
          or not exists (
            select 1
            from pg_catalog.pg_attribute as attribute
            where attribute.attrelid = pg_catalog.to_regclass(
                pg_catalog.format('%I.%I', 'record_data', table_token)
              )
              and attribute.attname = column_token
              and attribute.attnum > 0
              and not attribute.attisdropped
          ) then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;
      else
        if stored_catalogue.storage_contract_id is not null
          and (field_value ->> 'required')::boolean then
          raise exception using errcode = '55000', message = 'Compatible storage upgrades may add only nullable fields';
        end if;
        execute pg_catalog.format(
          'alter table record_data.%I add column %I %s%s',
          table_token, column_token, sql_type,
          case when (field_value ->> 'required')::boolean then ' not null' else '' end
        );
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          storage_id, field_id_value, column_token, database_type, field_value,
          p_module_root_id, p_module_release_revision, 'active'
        );
        if (field_value ->> 'unique')::boolean then
          execute pg_catalog.format(
            'create unique index %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
            'ux_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', ''),
            table_token, scope_index_columns, column_token
          );
        elsif (field_value ->> 'filterable')::boolean or (field_value ->> 'sortable')::boolean then
          execute pg_catalog.format(
            'create index %I on record_data.%I (%s, %I)',
            'ix_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', ''),
            table_token, scope_index_columns, column_token
          );
        end if;
        any_change := true;
      end if;
    end loop;

    if exists (
      select 1 from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.state = 'active'
        and mapping.introduced_at_release_revision <= p_module_release_revision
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
          where item.value ->> 'fieldId' = mapping.field_id::text
        )
    ) then
      raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove fields';
    end if;

    if stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision < p_module_release_revision then
      update vortex_record.storage_catalogue
      set last_compatible_release_revision = greatest(
            last_compatible_release_revision, p_module_release_revision
          ),
          content_fingerprint = shape_fingerprint,
          record_type_definition = record_type,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
      any_change := true;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.first_compatible_release_revision > p_module_release_revision then
      -- A newer release may have created the shared table first. The loops above
      -- prove the older release is a compatible subset; retain the newer shape.
      update vortex_record.storage_catalogue
      set first_compatible_release_revision = p_module_release_revision,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision = p_module_release_revision
      and stored_catalogue.content_fingerprint <> shape_fingerprint then
      raise exception using errcode = '55000', message = 'Stored record storage meaning is incompatible';
    end if;
  end loop;

  if exists (
    select 1
    from vortex_record.relationship_storage_mappings as mapping
    where mapping.module_root_id = p_module_root_id
      and mapping.release_revision <= p_module_release_revision
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
        cross join lateral pg_catalog.jsonb_array_elements(
          record_item.value -> 'relationships'
        ) as relationship_item(value)
        where relationship_item.value ->> 'relationshipId' = mapping.relationship_id::text
      )
  ) then
    raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove relationships';
  end if;

  for record_type in select item.value from pg_catalog.jsonb_array_elements(record_types) as item(value)
  loop
    storage_id := (record_type ->> 'storageContractId')::uuid;
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'relationships') as item(value)
    loop
      relationship_id_value := (relationship_value ->> 'relationshipId')::uuid;
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      target_ids := array[]::uuid[];
      if relationship_value ? 'toRecordType' then
        target_ids := array[(relationship_value #>> '{toRecordType,recordTypeId}')::uuid];
      else
        for target_value in select item.value
          from pg_catalog.jsonb_array_elements(relationship_value -> 'toRecordTypes') as item(value)
        loop
          target_ids := target_ids || (target_value ->> 'recordTypeId')::uuid;
        end loop;
      end if;
      if pg_catalog.cardinality(target_ids) < 1 or array_position(target_ids, null) is not null then
        raise exception using errcode = '42501', message = 'Relationship target evidence is unresolved';
      end if;
      insert into vortex_record.relationship_storage_mappings (
        relationship_id, module_root_id, release_revision, source_storage_contract_id,
        source_field_id, target_record_type_ids, cardinality, on_parent_delete, definition
      ) values (
        relationship_id_value, p_module_root_id, p_module_release_revision, storage_id,
        field_id_value, target_ids, relationship_value ->> 'cardinality',
        relationship_value ->> 'onParentDelete', relationship_value
      )
      on conflict (relationship_id) do update
      set release_revision = greatest(
            vortex_record.relationship_storage_mappings.release_revision,
            excluded.release_revision
          )
      where vortex_record.relationship_storage_mappings.module_root_id = excluded.module_root_id
        and vortex_record.relationship_storage_mappings.source_storage_contract_id = excluded.source_storage_contract_id
        and vortex_record.relationship_storage_mappings.source_field_id = excluded.source_field_id
        and vortex_record.relationship_storage_mappings.target_record_type_ids = excluded.target_record_type_ids
        and vortex_record.relationship_storage_mappings.cardinality = excluded.cardinality
        and vortex_record.relationship_storage_mappings.on_parent_delete = excluded.on_parent_delete
        and vortex_record.relationship_storage_mappings.definition = excluded.definition;
      if not found then
        raise exception using errcode = '55000', message = 'Existing relationship storage is incompatible';
      end if;
    end loop;
  end loop;

  select pg_catalog.array_agg(value order by value) into result_storage_ids
  from pg_catalog.unnest(result_storage_ids) as item(value);
  insert into vortex_record.release_provisions (
    module_root_id, release_revision, content_fingerprint, resolution_fingerprint,
    generator_contract_version, storage_contract_ids
  ) values (
    p_module_root_id, p_module_release_revision, release_row.content_fingerprint,
    release_row.resolution_fingerprint, '1.0.0', result_storage_ids
  ) on conflict on constraint release_provisions_pkey do nothing;

  return query select p_module_root_id, p_module_release_revision,
    release_row.content_fingerprint, release_row.resolution_fingerprint,
    '1.0.0'::text, result_storage_ids, any_change;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module V2 release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module storage evidence is ambiguous';
end
$function$;

alter function vortex_record.database_value_type(jsonb) owner to vortex_record_owner;
alter function vortex_record.enforce_relationship_edge_scope() owner to vortex_record_owner;
alter function vortex_record.sql_value_type(text) owner to vortex_record_owner;
alter function vortex_record.storage_meaning(jsonb) owner to vortex_record_owner;
alter function vortex_record.storage_meaning_fingerprint(jsonb) owner to vortex_record_owner;
alter function vortex_record.field_storage_meaning(jsonb) owner to vortex_record_owner;
alter function vortex_record.provision_exact_module_storage(uuid, bigint)
  owner to vortex_record_owner;

set local role vortex_record_owner;
revoke all on function vortex_record.database_value_type(jsonb),
  vortex_record.enforce_relationship_edge_scope(),
  vortex_record.sql_value_type(text), vortex_record.storage_meaning(jsonb),
  vortex_record.storage_meaning_fingerprint(jsonb),
  vortex_record.field_storage_meaning(jsonb),
  vortex_record.provision_exact_module_storage(uuid, bigint)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.provision_exact_module_storage(uuid, bigint)
  to vortex_module_owner;
grant usage on schema vortex_record to vortex_module_owner;
reset role;

grant usage on schema vortex_access, vortex_context, vortex_definition
  to vortex_module_owner;
grant select on vortex_definition.roots, vortex_definition.releases,
  vortex_definition.release_dependencies to vortex_module_owner;
create policy module_installation_definition_roots_read on vortex_definition.roots
  for select to vortex_module_owner using (true);
create policy module_installation_definition_releases_read on vortex_definition.releases
  for select to vortex_module_owner using (true);
create policy module_installation_definition_dependencies_read
  on vortex_definition.release_dependencies
  for select to vortex_module_owner using (true);
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_module_owner;
grant execute on function vortex_access.validated_human_request_context()
  to vortex_module_owner;

create function vortex_module.provision_module_installation_storage(
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
  content_fingerprint text,
  resolution_fingerprint text,
  generator_contract_version text,
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
  stored_binding vortex_module.installation_bindings%rowtype;
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
    raise exception using errcode = '42501', message = 'Module installation authority is unavailable';
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
      'vortex_module.binding:' || permission_decision.organization_id::text || ':' ||
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
  if application_release.validation_contract_version <> '1.0.0'
    or application_release.compilation_output #>> '{kind}' <> 'application'
    or application_release.compilation_output #>> '{canonical,envelope,rootId}'
      <> p_application_root_id::text
    or application_release.compilation_output #>> '{validationContractVersion}' <> '1.0.0' then
    raise exception using errcode = '23514', message = 'Exact Application V1 release is unavailable';
  end if;
  if not exists (
    select 1 from vortex_definition.release_dependencies as dependency
    where dependency.root_id = p_application_root_id
      and dependency.release_revision = p_application_release_revision
      and dependency.dependency_kind = 'module'
      and dependency.target_root_id = p_module_root_id
      and dependency.target_release_revision = p_module_release_revision
  ) then
    raise exception using errcode = '23514', message = 'Exact application Module binding is unavailable';
  end if;

  select binding.* into stored_binding
  from vortex_module.installation_bindings as binding
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
    if stored_binding.content_fingerprint <> provision.content_fingerprint
      or stored_binding.resolution_fingerprint <> provision.resolution_fingerprint
      or stored_binding.generator_contract_version <> provision.generator_contract_version
      or stored_binding.storage_contract_ids <> provision.storage_contract_ids then
      raise exception using errcode = '55000', message = 'Stored Module installation evidence is incompatible';
    end if;
    return query select stored_binding.state, false, stored_binding.binding_revision,
      stored_binding.application_root_id, stored_binding.application_release_revision,
      stored_binding.module_root_id, stored_binding.module_release_revision,
      stored_binding.content_fingerprint, stored_binding.resolution_fingerprint,
      stored_binding.generator_contract_version, stored_binding.storage_contract_ids;
    return;
  end if;

  if binding_exists then
    if stored_binding.binding_revision = 9007199254740991 then
      raise exception using errcode = '22003', message = 'Module installation binding revision is exhausted';
    end if;
    next_binding_revision := stored_binding.binding_revision + 1;
    update vortex_module.installation_bindings as binding
    set binding_revision = next_binding_revision,
        application_release_revision = p_application_release_revision,
        module_release_revision = p_module_release_revision,
        state = 'provisioned',
        content_fingerprint = provision.content_fingerprint,
        resolution_fingerprint = provision.resolution_fingerprint,
        generator_contract_version = provision.generator_contract_version,
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
    insert into vortex_module.installation_bindings (
      organization_id, application_root_id, module_root_id, binding_revision,
      application_release_revision, module_release_revision, state,
      content_fingerprint, resolution_fingerprint, generator_contract_version,
      storage_contract_ids
    ) values (
      permission_decision.organization_id, p_application_root_id, p_module_root_id, 1,
      p_application_release_revision, p_module_release_revision, 'provisioned',
      provision.content_fingerprint, provision.resolution_fingerprint,
      provision.generator_contract_version, provision.storage_contract_ids
    );
  end if;

  return query select 'provisioned'::text, true, next_binding_revision,
    p_application_root_id, p_application_release_revision, p_module_root_id,
    p_module_release_revision, provision.content_fingerprint,
    provision.resolution_fingerprint, provision.generator_contract_version,
    provision.storage_contract_ids;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Module installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module installation evidence is ambiguous';
end
$function$;

alter function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) owner to vortex_module_owner;
set local role vortex_module_owner;
grant usage on schema vortex_module to vortex_request;
revoke all on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) to vortex_request;
comment on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) is 'Protected exact-release storage provisioning; commits only an inactive Module binding.';
reset role;

set local role vortex_record_owner;
revoke trigger on vortex_record.relationship_edges from postgres;
revoke create on schema vortex_record, record_data from postgres;
reset role;
set local role vortex_module_owner;
revoke create on schema vortex_module from postgres;
reset role;
