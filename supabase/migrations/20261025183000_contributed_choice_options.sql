set local role vortex_owner;

create or replace function vortex_record.field_storage_compatible(
  p_stored jsonb,
  p_requested jsonb,
  p_requested_is_older boolean
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  stored_meaning jsonb := vortex_record.field_storage_meaning(p_stored);
  requested_meaning jsonb := vortex_record.field_storage_meaning(p_requested);
  earlier_options jsonb;
  later_options jsonb;
begin
  if p_requested ->> 'type' in ('choice', 'several_choices') then
    earlier_options := case when p_requested_is_older then p_requested else p_stored end #> '{settings,options}';
    later_options := case when p_requested_is_older then p_stored else p_requested end #> '{settings,options}';
    if pg_catalog.jsonb_typeof(earlier_options) is distinct from 'array'
      or pg_catalog.jsonb_typeof(later_options) is distinct from 'array' then
      return false;
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(earlier_options) as earlier(value)
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(later_options) as later(value)
        where later.value = earlier.value
      )
    ) then
      return false;
    end if;
    stored_meaning := stored_meaning #- '{settings,options}';
    requested_meaning := requested_meaning #- '{settings,options}';
  end if;
  return stored_meaning is not distinct from requested_meaning;
end
$function$;

alter function vortex_record.field_storage_compatible(jsonb,jsonb,boolean) owner to vortex_owner;
revoke all on function vortex_record.field_storage_compatible(jsonb,jsonb,boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.field_storage_compatible(jsonb,jsonb,boolean) to vortex_owner;

create or replace function vortex_record.create_system_projection_companion_storage_internal(
  p_storage_contract_id uuid,
  p_target_module_root_id uuid,
  p_record_type_id uuid,
  p_contributor_module_root_id uuid,
  p_contributor_release_revision bigint,
  p_field_definition jsonb,
  p_validate_only boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  contributor_revision bigint;
  field_id_value uuid;
  database_type text;
  sql_type text;
  table_token text;
  column_token text;
  protected_view_key text;
  reader_schema_value text;
  reader_function_value text;
  reader_function_oid oid;
  relation_oid oid;
  owner_role_oid oid := 'vortex_owner'::regrole::oid;
  adapter_role_oid oid := 'vortex_record_adapter'::regrole::oid;
  has_mapping boolean;
  expected_columns text[];
  existing_columns text[];
  acl_adapter_count integer;
  acl_adapter_invalid_count integer;
  acl_other_count integer;
  policy_expression text;
begin
  if not vortex_platform.is_non_nil_uuid(p_storage_contract_id::text)
    or not vortex_platform.is_non_nil_uuid(p_target_module_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_platform.is_non_nil_uuid(p_contributor_module_root_id::text)
    or p_contributor_release_revision is null
    or p_contributor_release_revision not between 1 and 9007199254740991
    or p_target_module_root_id = p_contributor_module_root_id
    or pg_catalog.jsonb_typeof(p_field_definition) is distinct from 'object'
    or p_validate_only is null then
    raise exception using errcode = '22023',
      message = 'Projection companion storage identity is invalid';
  end if;

  begin
    field_id_value := (p_field_definition ->> 'fieldId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023',
      message = 'Projection companion field identity is invalid';
  end;
  if not vortex_platform.is_non_nil_uuid(field_id_value::text)
    or p_field_definition -> 'required' is distinct from 'false'::jsonb
    or p_field_definition -> 'unique' is distinct from 'false'::jsonb
    or p_field_definition -> 'filterable' is distinct from 'false'::jsonb
    or p_field_definition -> 'sortable' is distinct from 'false'::jsonb then
    raise exception using errcode = '23514',
      message = 'A system projection contribution must be optional and unindexed';
  end if;
  database_type := vortex_record.database_value_type(p_field_definition);
  sql_type := vortex_record.sql_value_type(database_type);
  if database_type is null or sql_type is null
    or pg_catalog.to_regtype(sql_type) is null then
    raise exception using errcode = '23514',
      message = 'Contributed field type is unsupported';
  end if;

  select catalogue.* into strict catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
  for update;
  protected_view_key := catalogue_row.protected_read_model_key;
  table_token := 'cp_' || pg_catalog.replace(
    pg_catalog.lower(p_storage_contract_id::text), '-', ''
  );
  column_token := 'f_' || pg_catalog.replace(
    pg_catalog.lower(field_id_value::text), '-', ''
  );
  if catalogue_row.module_root_id <> p_target_module_root_id
    or catalogue_row.record_type_id <> p_record_type_id
    or catalogue_row.storage_scope is distinct from 'organization_shared'
    or catalogue_row.state is distinct from 'active'
    or catalogue_row.physical_schema_token is distinct from 'system_projection'
    or catalogue_row.physical_table_token is distinct from
      ('rt_' || pg_catalog.replace(pg_catalog.lower(p_storage_contract_id::text), '-', ''))
    or protected_view_key is null then
    raise exception using errcode = '55000',
      message = 'Target record storage lineage is incompatible';
  end if;

  select registered.reader_schema, registered.reader_function
  into reader_schema_value, reader_function_value
  from vortex_record.protected_read_model_views as registered
  where registered.protected_read_model_key = protected_view_key;
  if not found then
    raise exception using errcode = '55000',
      message = 'Protected projection reader is unavailable';
  end if;
  reader_function_oid := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.%I(uuid[],text,text,jsonb,integer,jsonb)', reader_schema_value, reader_function_value
  ))::oid;
  if reader_function_oid is null or not exists (
    select 1 from pg_catalog.pg_proc as reader
    where reader.oid = reader_function_oid and reader.prosecdef
      and reader.proowner = owner_role_oid
      and reader.proconfig @> array['search_path=""']::text[]
  ) then
    raise exception using errcode = '55000',
      message = 'Protected projection reader lineage is incompatible';
  end if;

  select mapping.* into mapping_row
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_storage_contract_id
    and mapping.field_id = field_id_value
  for update;
  has_mapping := found;
  if has_mapping then
    select pg_catalog.max(provision.release_revision) into contributor_revision
    from vortex_record.release_provisions as provision
    where provision.module_root_id = p_contributor_module_root_id;
    if mapping_row.introduced_by_module_root_id <> p_contributor_module_root_id
      or mapping_row.physical_column_token <> column_token
      or mapping_row.database_value_type <> database_type
      or mapping_row.state not in ('active', 'retired')
      or not vortex_record.field_storage_compatible(
        mapping_row.field_definition, p_field_definition,
        p_contributor_release_revision < contributor_revision
      ) then
      raise exception using errcode = '55000',
        message = 'Existing contributed field storage is incompatible';
    end if;
  end if;

  if exists (
    select 1
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = p_storage_contract_id
      and mapping.introduced_by_module_root_id <> p_target_module_root_id
      and mapping.state not in ('active', 'retired')
  ) then
    raise exception using errcode = '55000',
      message = 'Existing contributed field storage is incompatible';
  end if;
  select coalesce(
      pg_catalog.array_agg(mapping.physical_column_token order by mapping.physical_column_token),
      array[]::text[]
    )
  into expected_columns
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_storage_contract_id
    and mapping.introduced_by_module_root_id <> p_target_module_root_id;

  relation_oid := pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token))::oid;
  if relation_oid is null then
    if has_mapping or pg_catalog.cardinality(expected_columns) > 0 then
      raise exception using errcode = '55000',
        message = 'Existing contributed field storage is incompatible';
    end if;
    if p_validate_only then
      return;
    end if;
    execute pg_catalog.format(
      'create table record_data.%I (
        organisation_id uuid not null,
        record_id uuid not null,
        %I %s,
        primary key (organisation_id, record_id)
      )', table_token, column_token, sql_type
    );
    execute pg_catalog.format('alter table record_data.%I enable row level security', table_token);
    execute pg_catalog.format('alter table record_data.%I force row level security', table_token);
    execute pg_catalog.format(
      'create policy projection_companion_record_access on record_data.%I
        for all to vortex_record_adapter
        using (organisation_id = vortex_platform.organization_id())
        with check (organisation_id = vortex_platform.organization_id())', table_token
    );
    execute pg_catalog.format(
      'revoke all on record_data.%I from public, anon, authenticated, service_role,
        vortex_runtime, vortex_request, vortex_owner', table_token
    );
    execute pg_catalog.format(
      'grant select, insert, update on record_data.%I to vortex_record_adapter', table_token
    );
    expected_columns := expected_columns || column_token;
  else
    if not exists (
      select 1
      from pg_catalog.pg_class as relation
      where relation.oid = relation_oid
        and relation.relkind = 'r'
        and relation.relpersistence = 'p'
        and not relation.relispartition
        and relation.relowner = owner_role_oid
        and relation.relrowsecurity
        and relation.relforcerowsecurity
    )
      or exists (
        select 1 from pg_catalog.pg_inherits as inheritance
        where inheritance.inhrelid = relation_oid
      )
      or exists (
        select 1 from pg_catalog.pg_trigger as trigger
        where trigger.tgrelid = relation_oid and not trigger.tgisinternal
      )
      or exists (
        select 1 from pg_catalog.pg_rewrite as rule
        where rule.ev_class = relation_oid
      ) then
      raise exception using errcode = '55000',
        message = 'Existing projection companion relation is incompatible';
    end if;
    select coalesce(
        pg_catalog.array_agg(attribute.attname order by attribute.attname),
        array[]::text[]
      )
    into existing_columns
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = relation_oid
      and attribute.attnum > 0
      and not attribute.attisdropped
      and attribute.attname not in ('organisation_id', 'record_id');
    if existing_columns is distinct from expected_columns
      or exists (
        select 1
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_oid
          and attribute.attname in ('organisation_id', 'record_id')
          and (attribute.atttypid <> 'uuid'::regtype
            or not attribute.attnotnull
            or attribute.atthasdef
            or exists (
              select 1 from pg_catalog.pg_attrdef as default_row
              where default_row.adrelid = attribute.attrelid
                and default_row.adnum = attribute.attnum
            )
            or attribute.attgenerated <> ''
            or attribute.attidentity <> ''
            or attribute.attnum < 1
            or attribute.attisdropped)
      )
      or (
        select pg_catalog.count(*) from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_oid
          and attribute.attname in ('organisation_id', 'record_id')
          and attribute.attnum > 0 and not attribute.attisdropped
      ) <> 2
      or exists (
        select 1
        from pg_catalog.pg_constraint as constraint_row
        where constraint_row.conrelid = relation_oid
          and constraint_row.contype <> 'p'
      )
      or not exists (
        select 1
        from pg_catalog.pg_constraint as constraint_row
        cross join lateral pg_catalog.unnest(constraint_row.conkey)
          with ordinality as key_column(attnum, ordinal_position)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = relation_oid and attribute.attnum = key_column.attnum
        where constraint_row.conrelid = relation_oid
          and constraint_row.contype = 'p'
        group by constraint_row.oid, constraint_row.convalidated
        having constraint_row.convalidated
          and not constraint_row.condeferrable
          and not constraint_row.condeferred
          and pg_catalog.array_agg(attribute.attname order by key_column.ordinal_position)
            = array['organisation_id', 'record_id']::name[]
      )
      or (
        select pg_catalog.count(*) from pg_catalog.pg_constraint as constraint_row
        where constraint_row.conrelid = relation_oid and constraint_row.contype = 'p'
      ) <> 1
      or exists (
        select 1 from pg_catalog.pg_index as index_row
        where index_row.indrelid = relation_oid and not index_row.indisprimary
      ) then
      raise exception using errcode = '55000',
        message = 'Existing projection companion relation is incompatible';
    end if;

    if exists (
      select 1
      from vortex_record.field_storage_mappings as mapping
      left join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = relation_oid
        and attribute.attname = mapping.physical_column_token
        and attribute.attnum > 0 and not attribute.attisdropped
      left join pg_catalog.pg_attrdef as default_row
        on default_row.adrelid = attribute.attrelid
        and default_row.adnum = attribute.attnum
      where mapping.storage_contract_id = p_storage_contract_id
        and mapping.introduced_by_module_root_id <> p_target_module_root_id
        and (attribute.attnum is null
          or attribute.attnotnull
          or attribute.atthasdef
          or default_row.oid is not null
          or attribute.attgenerated <> ''
          or attribute.attidentity <> ''
          or attribute.atttypid is distinct from
            pg_catalog.to_regtype(vortex_record.sql_value_type(mapping.database_value_type))::oid)
    ) then
      raise exception using errcode = '55000',
        message = 'Existing projection companion relation is incompatible';
    end if;
    if not has_mapping then
      if exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_oid
          and attribute.attname = column_token
          and attribute.attnum > 0 and not attribute.attisdropped
      ) then
        raise exception using errcode = '55000',
          message = 'Existing contributed field storage is incompatible';
      end if;
      expected_columns := expected_columns || column_token;
    end if;

    select pg_catalog.count(*) filter (
        where privilege.grantee = adapter_role_oid
          and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE')
      ),
      pg_catalog.count(*) filter (
        where privilege.grantee = adapter_role_oid
          and (privilege.privilege_type not in ('SELECT', 'INSERT', 'UPDATE')
            or privilege.is_grantable)
      ),
      pg_catalog.count(*) filter (
        where privilege.grantee not in (owner_role_oid, adapter_role_oid)
      )
    into acl_adapter_count, acl_adapter_invalid_count, acl_other_count
    from pg_catalog.pg_class as relation
    cross join lateral pg_catalog.aclexplode(coalesce(
      relation.relacl, pg_catalog.acldefault('r', relation.relowner)
    )) as privilege
    where relation.oid = relation_oid;
    if acl_adapter_count <> 3
      or acl_adapter_invalid_count <> 0
      or acl_other_count <> 0
      or exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_oid and attribute.attacl is not null
      ) then
      raise exception using errcode = '55000',
        message = 'Existing projection companion grants are incompatible';
    end if;

    select pg_catalog.regexp_replace(pg_catalog.lower(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
      ), '\s+', '', 'g')
    into policy_expression
    from pg_catalog.pg_policy as policy
    where policy.polrelid = relation_oid
      and policy.polname = 'projection_companion_record_access';
    if policy_expression is distinct from '(organisation_id=vortex_platform.organization_id())'
      or not exists (
        select 1 from pg_catalog.pg_policy as policy
        where policy.polrelid = relation_oid
          and policy.polname = 'projection_companion_record_access'
          and policy.polpermissive
          and policy.polcmd = '*'
          and policy.polroles = array[adapter_role_oid]::oid[]
          and pg_catalog.regexp_replace(pg_catalog.lower(
            pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
          ), '\s+', '', 'g')
            = '(organisation_id=vortex_platform.organization_id())'
      )
      or (
        select pg_catalog.count(*) from pg_catalog.pg_policy as policy
        where policy.polrelid = relation_oid
      ) <> 1 then
      raise exception using errcode = '55000',
        message = 'Existing projection companion policies are incompatible';
    end if;

    if p_validate_only then
      return;
    end if;
    if not has_mapping then
      execute pg_catalog.format(
        'alter table record_data.%I add column %I %s', table_token, column_token, sql_type
      );
    end if;
  end if;

  relation_oid := pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token))::oid;
  select coalesce(
      pg_catalog.array_agg(expected_column.value order by expected_column.value),
      array[]::text[]
    )
  into expected_columns
  from pg_catalog.unnest(expected_columns) as expected_column(value);
  select coalesce(
      pg_catalog.array_agg(attribute.attname order by attribute.attname),
      array[]::text[]
    )
  into existing_columns
  from pg_catalog.pg_attribute as attribute
  where attribute.attrelid = relation_oid
    and attribute.attnum > 0
    and not attribute.attisdropped
    and attribute.attname not in ('organisation_id', 'record_id');
  if existing_columns is distinct from expected_columns
    or not exists (
      select 1 from pg_catalog.pg_attribute as attribute
      where attribute.attrelid = relation_oid
        and attribute.attname = column_token
        and attribute.attnum > 0 and not attribute.attisdropped
        and not attribute.attnotnull
        and not attribute.atthasdef
        and not exists (
          select 1 from pg_catalog.pg_attrdef as default_row
          where default_row.adrelid = attribute.attrelid
            and default_row.adnum = attribute.attnum
        )
        and attribute.attgenerated = ''
        and attribute.attidentity = ''
        and attribute.atttypid = pg_catalog.to_regtype(sql_type)::oid
    ) then
    raise exception using errcode = '55000',
      message = 'Existing projection companion relation is incompatible';
  end if;
end
$function$;
alter function vortex_record.create_system_projection_companion_storage_internal(uuid,uuid,uuid,uuid,bigint,jsonb,boolean)
  owner to vortex_owner;

revoke all on function vortex_record.create_system_projection_companion_storage_internal(uuid, uuid, uuid, uuid, bigint, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.create_system_projection_companion_storage_internal(uuid, uuid, uuid, uuid, bigint, jsonb, boolean)
  to vortex_owner;
comment on function vortex_record.create_system_projection_companion_storage_internal(uuid, uuid, uuid, uuid, bigint, jsonb, boolean) is
  'Privately preflights or provisions one optional unindexed companion field for an exact system-projection storage contract. Companion rows are organisation-scoped and are never written by a separate Record command.';

create or replace function vortex_record.provision_exact_module_storage(
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns table (
  module_root_id uuid,
  release_revision bigint,
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
  projection_expression_pair record;
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
  stored_projection_role text;
  requested_projection_role text;
  stored_database_type text;
  requested_database_type text;
  stored_sql_type text;
  requested_sql_type text;
  stored_expression jsonb;
  requested_expression jsonb;
  shape_fingerprint text;
  scope_index_columns text;
  result_storage_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
  is_projection boolean;
  protected_view_key text;
begin
  if not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Record storage release selector is invalid';
  end if;

  select release.* into strict release_row
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision
    and root.kind = 'module';
  -- Module V3 reuses the Module V2 record-type content, so both validation
  -- contracts allocate identical storage. The source contract must agree with
  -- the validation contract, and the embedded identity is compared with
  -- IS DISTINCT FROM so an absent JSON member cannot evade the gate.
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
  -- A Module may hold no record types yet; its release is provisioned with no storage.
  if pg_catalog.jsonb_typeof(record_types) is distinct from 'array' then
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
      and provision.release_revision = p_module_release_revision;
    if result_storage_ids is distinct from coalesce((
      select pg_catalog.array_agg((item.value ->> 'storageContractId')::uuid order by item.value ->> 'storageContractId')
      from pg_catalog.jsonb_array_elements(record_types) as item(value)
    ), array[]::uuid[]) then
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
    if not vortex_platform.is_non_nil_uuid(storage_id::text)
      or not vortex_platform.is_non_nil_uuid(record_type_id_value::text)
      or storage_scope_value not in ('organization_shared', 'application_contained')
      or ownership_mode_value not in ('none', 'organization_account', 'group', 'inherited')
      or pg_catalog.jsonb_typeof(record_type -> 'fields') <> 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') <> 'array' then
      raise exception using errcode = '42501', message = 'Module record storage definition is invalid';
    end if;
    if (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
      where field.value -> 'sortable' = 'true'::jsonb) > 8 then
      raise exception using errcode = '23514', message = 'A record type may declare at most eight sortable fields';
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

    -- System projections keep definition and field mappings only. Every row
    -- is supplied by the registered bounded reader, never a record_data view.
    is_projection := record_type ? 'systemProjection';
    protected_view_key := null;
    if is_projection then
      protected_view_key := record_type #>> '{systemProjection,protectedView}';
      perform 1 from vortex_record.protected_read_model_views as registered
      where registered.protected_read_model_key = protected_view_key;
      if not found then
        raise exception using errcode = '42501', message = 'Protected projection reader is unavailable';
      end if;
      if storage_scope_value <> 'organization_shared' then
        raise exception using errcode = '42501',
          message = 'Protected projection storage must be organisation shared';
      end if;
    end if;

    select catalogue.* into stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_id
    for update;

    if not found then
      if not is_projection then
        perform vortex_record.create_record_storage_table_internal(
          storage_id, p_module_root_id, record_type_id_value,
          storage_scope_value, ownership_mode_value, true
        );
      end if;

      insert into vortex_record.storage_catalogue (
        storage_contract_id, physical_schema_token, physical_table_token,
        module_root_id, record_type_id, storage_scope,
        first_compatible_release_revision, last_compatible_release_revision,
        state, content_fingerprint, record_type_definition, protected_read_model_key
      ) values (
        storage_id,
        case when is_projection then 'system_projection' else 'record_data' end,
        table_token, p_module_root_id, record_type_id_value, storage_scope_value,
        p_module_release_revision, p_module_release_revision, 'active',
        shape_fingerprint, record_type, protected_view_key
      );
      any_change := true;
    else
      if stored_catalogue.record_type_definition ->> 'ownershipMode'
          is distinct from ownership_mode_value
        or stored_catalogue.record_type_definition ->> 'ownershipRelationshipId'
          is distinct from record_type ->> 'ownershipRelationshipId' then
        raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
      end if;
      if is_projection then
        if stored_catalogue.module_root_id <> p_module_root_id
          or stored_catalogue.record_type_id <> record_type_id_value
          or stored_catalogue.storage_scope <> storage_scope_value
          or stored_catalogue.state <> 'active'
          or stored_catalogue.physical_schema_token <> 'system_projection'
          or stored_catalogue.protected_read_model_key is distinct from protected_view_key
          or stored_catalogue.physical_table_token <> table_token then
          raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
        end if;
        if pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition) is distinct from 'object'
          or pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition -> 'fields') is distinct from 'array'
          or pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition -> 'systemProjection') is distinct from 'object'
          or pg_catalog.jsonb_typeof(record_type -> 'systemProjection') is distinct from 'object' then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;

        -- The catalogue keeps the newest compatible exact definition. Compare
        -- only shared field identities so an older subset and newer additions
        -- retain their existing release-order behavior. These descriptors
        -- describe the bounded reader values, including the
        -- protected attribute key, JSON/text extraction, and cast.
        for projection_expression_pair in
          select requested_item.value as requested_field,
            stored_item.value as stored_field
          from pg_catalog.jsonb_array_elements(record_type -> 'fields') as requested_item(value)
          join pg_catalog.jsonb_array_elements(
            stored_catalogue.record_type_definition -> 'fields'
          ) as stored_item(value)
            on stored_item.value ->> 'fieldId' = requested_item.value ->> 'fieldId'
          order by requested_item.value ->> 'fieldId'
        loop
          stored_projection_role := case
            when projection_expression_pair.stored_field ->> 'fieldId'
              = stored_catalogue.record_type_definition #>> '{systemProjection,organizationFieldId}'
              then 'organization'
            when projection_expression_pair.stored_field ->> 'fieldId'
              = stored_catalogue.record_type_definition #>> '{systemProjection,revisionFieldId}'
              then 'revision'
            else 'attribute'
          end;
          requested_projection_role := case
            when projection_expression_pair.requested_field ->> 'fieldId'
              = record_type #>> '{systemProjection,organizationFieldId}'
              then 'organization'
            when projection_expression_pair.requested_field ->> 'fieldId'
              = record_type #>> '{systemProjection,revisionFieldId}'
              then 'revision'
            else 'attribute'
          end;
          stored_database_type := vortex_record.database_value_type(
            projection_expression_pair.stored_field
          );
          requested_database_type := vortex_record.database_value_type(
            projection_expression_pair.requested_field
          );
          if stored_projection_role is distinct from requested_projection_role
            or stored_database_type is null
            or requested_database_type is null then
            raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
          end if;
          stored_sql_type := vortex_record.sql_value_type(stored_database_type);
          requested_sql_type := vortex_record.sql_value_type(requested_database_type);
          stored_expression := case stored_projection_role
            when 'organization' then pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.organization_id',
              'cast', 'text'
            )
            when 'revision' then pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.revision',
              'cast', stored_sql_type
            )
            else pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.attribute_values',
              'key', projection_expression_pair.stored_field ->> 'key',
              'extraction', case when stored_database_type = 'json' then '->' else '->>' end,
              'cast', case when stored_database_type = 'json' then null else stored_sql_type end
            )
          end;
          requested_expression := case requested_projection_role
            when 'organization' then pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.organization_id',
              'cast', 'text'
            )
            when 'revision' then pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.revision',
              'cast', requested_sql_type
            )
            else pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.attribute_values',
              'key', projection_expression_pair.requested_field ->> 'key',
              'extraction', case when requested_database_type = 'json' then '->' else '->>' end,
              'cast', case when requested_database_type = 'json' then null else requested_sql_type end
            )
          end;
          if stored_expression is distinct from requested_expression then
            raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
          end if;
        end loop;
      else
        if stored_catalogue.module_root_id <> p_module_root_id
          or stored_catalogue.record_type_id <> record_type_id_value
          or stored_catalogue.storage_scope <> storage_scope_value
          or stored_catalogue.state <> 'active'
          or stored_catalogue.physical_schema_token <> 'record_data'
          or stored_catalogue.physical_table_token <> table_token
          or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
          raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
        end if;
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

      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.state <> 'active'
          or not vortex_record.field_storage_compatible(
            stored_field.field_definition, field_value,
            p_module_release_revision < stored_catalogue.last_compatible_release_revision
          )
          or (not is_projection and not exists (
            select 1
            from pg_catalog.pg_attribute as attribute
            where attribute.attrelid = pg_catalog.to_regclass(
                pg_catalog.format('%I.%I', 'record_data', table_token)
              )
              and attribute.attname = column_token
              and attribute.attnum > 0
              and not attribute.attisdropped
          )) then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;
        if field_value ->> 'type' in ('choice', 'several_choices')
          and p_module_release_revision > stored_catalogue.last_compatible_release_revision
          and stored_field.field_definition is distinct from field_value then
          update vortex_record.field_storage_mappings
          set field_definition = field_value
          where storage_contract_id = storage_id and field_id = field_id_value;
          any_change := true;
        end if;
      else
        if not is_projection then
          if stored_catalogue.storage_contract_id is not null
            and (field_value ->> 'required')::boolean then
            raise exception using errcode = '55000', message = 'Compatible storage upgrades may add only nullable fields';
          end if;
          execute pg_catalog.format(
            'alter table record_data.%I add column %I %s%s',
            table_token, column_token, sql_type,
            case when (field_value ->> 'required')::boolean then ' not null' else '' end
          );
        end if;
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          storage_id, field_id_value, column_token, database_type, field_value,
          p_module_root_id, p_module_release_revision, 'active'
        );
        -- A projection field has no generated column or index. Its protected
        -- reader applies visibility, ordering and filtering.
        if is_projection then
          null;
        elsif (field_value ->> 'unique')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'uniqueness', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        elsif (field_value ->> 'filterable')::boolean or (field_value ->> 'sortable')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'performance', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        end if;
        any_change := true;
      end if;
    end loop;

    -- Only a field this Module itself introduced can prove a removed field. A
    -- field another Module contributed keeps its retained lineage and never
    -- refuses this Module's own storage.
    if exists (
      select 1 from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.state = 'active'
        and mapping.introduced_by_module_root_id = p_module_root_id
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


  select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[]) into result_storage_ids
  from pg_catalog.unnest(result_storage_ids) as item(value);
  insert into vortex_record.release_provisions (
    module_root_id, release_revision, storage_contract_ids
  ) values (
    p_module_root_id, p_module_release_revision, result_storage_ids
  ) on conflict on constraint release_provisions_pkey do nothing;

  return query select p_module_root_id, p_module_release_revision,
    result_storage_ids, any_change;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module storage evidence is ambiguous';
end
$function$;

alter function vortex_record.provision_exact_module_storage(uuid,bigint) owner to vortex_owner;

revoke all on function vortex_record.provision_exact_module_storage(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.provision_exact_module_storage(uuid, bigint)
  to vortex_owner;
comment on function vortex_record.provision_exact_module_storage(uuid, bigint) is
  'Private exact-release Module storage provisioner: creates or evolves generated record_data storage, or registers definition and field mappings for a system projection read only through its bounded protected reader, for one published Module release.';

create or replace function vortex_record.provision_exact_module_contributions(
  p_module_root_id uuid,
  p_module_release_revision bigint,
  p_contributions jsonb
)
returns table (
  module_root_id uuid,
  release_revision bigint,
  contribution_ids uuid[],
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  contribution jsonb;
  contribution_id uuid;
  contribution_kind text;
  contributor_root_id uuid;
  target_module_root_id uuid;
  target_module_version text;
  target_extension_point_id uuid;
  target_record_type_id uuid;
  source_record_type_id uuid;
  field_id_value uuid;
  source_field jsonb;
  storage_id uuid;
  storage_ids uuid[] := array[]::uuid[];
  target_release vortex_definition.releases%rowtype;
  target_content jsonb;
  target_record_type jsonb;
  target_point jsonb;
  stored_catalogue vortex_record.storage_catalogue%rowtype;
  stored_field vortex_record.field_storage_mappings%rowtype;
  contributor_revision bigint;
  table_token text;
  column_token text;
  storage_scope_value text;
  scope_index_columns text;
  database_type text;
  sql_type text;
  is_projection boolean;
  protected_view_key text;
  contribution_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
begin
  if not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_contributions) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_contributions) < 1
    or pg_catalog.jsonb_array_length(p_contributions) > 100 then
    raise exception using errcode = '22023',
      message = 'Module contribution storage command is invalid';
  end if;

  select release.* into strict release_row
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision
    and root.kind = 'module';
  if release_row.validation_contract_version
      <> all (vortex_definition.accepted_contract_version('module'))
    or release_row.source_contract_version
      is distinct from release_row.validation_contract_version
    or release_row.compilation_output #>> '{kind}' is distinct from 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}'
      is distinct from release_row.validation_contract_version then
    raise exception using errcode = '23514',
      message = 'Exact contributor Module release is incompatible';
  end if;

  -- Resolve every target record table first, then take its storage lineage lock
  -- in canonical storage-identity order, so a concurrent provisioner and this
  -- helper acquire the same locks in the same order.
  for contribution in
    select item.value
    from pg_catalog.jsonb_array_elements(p_contributions) as item(value)
    order by pg_catalog.lower(item.value ->> 'targetModuleRootId'),
      pg_catalog.lower(item.value ->> 'targetRecordTypeId'),
      pg_catalog.lower(item.value ->> 'contributionId')
  loop
    if pg_catalog.jsonb_typeof(contribution) is distinct from 'object'
      or pg_catalog.jsonb_typeof(contribution -> 'contributorModuleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(contribution -> 'targetModuleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(contribution -> 'targetRecordTypeId') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Module contribution identity is invalid';
    end if;
    begin
      contributor_root_id := (contribution ->> 'contributorModuleRootId')::uuid;
      target_module_root_id := (contribution ->> 'targetModuleRootId')::uuid;
      target_record_type_id := (contribution ->> 'targetRecordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Module contribution identity is invalid';
    end;
    if not vortex_platform.is_non_nil_uuid(contributor_root_id::text)
      or not vortex_platform.is_non_nil_uuid(target_module_root_id::text)
      or not vortex_platform.is_non_nil_uuid(target_record_type_id::text)
      or contributor_root_id <> p_module_root_id
      or target_module_root_id = p_module_root_id then
      raise exception using errcode = '22023', message = 'Module contribution binding is invalid';
    end if;
    select catalogue.storage_contract_id into storage_id
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = target_module_root_id
      and catalogue.record_type_id = target_record_type_id
      and catalogue.state = 'active';
    if storage_id is null then
      raise exception using errcode = '55000',
        message = 'Target record storage is unavailable';
    end if;
    storage_ids := storage_ids || storage_id;
  end loop;

  for storage_id in
    select distinct item.value
    from pg_catalog.unnest(storage_ids) as item(value)
    order by item.value
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || storage_id::text, 0)
    );
  end loop;

  -- Preflight every projection field in the complete contribution array before
  -- the first generated-table or companion-storage DDL. A later unsupported
  -- projection field therefore cannot follow an earlier physical change.
  for contribution in
    select item.value
    from pg_catalog.jsonb_array_elements(p_contributions) as item(value)
    order by pg_catalog.lower(item.value ->> 'targetModuleRootId'),
      pg_catalog.lower(item.value ->> 'targetRecordTypeId'),
      pg_catalog.lower(item.value ->> 'contributionId')
  loop
    if contribution ->> 'kind' is distinct from 'field' then
      continue;
    end if;
    begin
      target_module_root_id := (contribution ->> 'targetModuleRootId')::uuid;
      target_extension_point_id := (contribution ->> 'targetExtensionPointId')::uuid;
      target_record_type_id := (contribution ->> 'targetRecordTypeId')::uuid;
      source_record_type_id := (contribution ->> 'recordTypeId')::uuid;
      field_id_value := (contribution ->> 'fieldId')::uuid;
      contribution_id := (contribution ->> 'contributionId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Contributed field identity is invalid';
    end;
    target_module_version := contribution ->> 'targetModuleReleaseVersion';
    if target_module_version is null
      or not vortex_platform.is_non_nil_uuid(target_module_root_id::text)
      or not vortex_platform.is_non_nil_uuid(target_extension_point_id::text)
      or not vortex_platform.is_non_nil_uuid(target_record_type_id::text)
      or not vortex_platform.is_non_nil_uuid(source_record_type_id::text)
      or not vortex_platform.is_non_nil_uuid(field_id_value::text)
      or not vortex_platform.is_non_nil_uuid(contribution_id::text)
      or field_id_value <> contribution_id then
      raise exception using errcode = '22023', message = 'Contributed field identity is invalid';
    end if;

    select release.* into strict target_release
    from vortex_definition.releases as release
    join vortex_definition.roots as root on root.root_id = release.root_id
    where release.root_id = target_module_root_id
      and release.release_version = target_module_version
      and root.kind = 'module';
    if target_release.validation_contract_version
      <> all (vortex_definition.accepted_contract_version('module')) then
      raise exception using errcode = '23514',
        message = 'Exact target Module release is incompatible';
    end if;
    target_content := target_release.compilation_output #> '{canonical,content}';
    select item.value into target_record_type
    from pg_catalog.jsonb_array_elements(target_content -> 'recordTypes') as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId')
      = pg_catalog.lower(target_record_type_id::text);
    if target_record_type is null then
      raise exception using errcode = '23514', message = 'Target record type is unavailable';
    end if;
    is_projection := target_record_type ? 'systemProjection';
    if not is_projection then
      continue;
    end if;

    -- Projection fields are optional and unindexed by contract. Use JSONB
    -- identity comparisons so a missing or non-boolean flag cannot pass.
    select item.value into target_point
    from pg_catalog.jsonb_array_elements(target_content -> 'extensionPoints') as item(value)
    where pg_catalog.lower(item.value ->> 'extensionPointId')
      = pg_catalog.lower(target_extension_point_id::text);
    if target_point is null
      or pg_catalog.lower(target_point ->> 'recordTypeId')
        <> pg_catalog.lower(target_record_type_id::text)
      or not coalesce((target_point -> 'accepts') ? 'field', false) then
      raise exception using errcode = '23514', message = 'Target extension point is unavailable';
    end if;
    if not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
          coalesce(release_row.compilation_output #> '{canonical,content,contributions}', '[]'::jsonb)
        ) as item(value)
      where pg_catalog.lower(item.value ->> 'contributionId')
          = pg_catalog.lower(contribution ->> 'contributionId')
        and item.value ->> 'kind' = 'field'
        and pg_catalog.lower(item.value #>> '{targetModule,moduleRootId}')
          = pg_catalog.lower(target_module_root_id::text)
        and pg_catalog.lower(item.value ->> 'targetExtensionPointId')
          = pg_catalog.lower(target_extension_point_id::text)
        and pg_catalog.lower(item.value ->> 'recordTypeId')
          = pg_catalog.lower(source_record_type_id::text)
    ) then
      raise exception using errcode = '23514',
        message = 'Module contribution declaration is unavailable';
    end if;
    source_field := null;
    select item.value into source_field
    from pg_catalog.jsonb_array_elements(
        release_row.compilation_output #> '{canonical,content,recordTypes}'
      ) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'fields'
    ) as item(value)
    where pg_catalog.lower(record_item.value ->> 'recordTypeId')
        = pg_catalog.lower(source_record_type_id::text)
      and pg_catalog.lower(item.value ->> 'fieldId')
        = pg_catalog.lower(field_id_value::text);
    if source_field is null then
      raise exception using errcode = '23514',
        message = 'Contributed field definition is unavailable';
    end if;
    if source_field -> 'required' is distinct from 'false'::jsonb
      or source_field -> 'unique' is distinct from 'false'::jsonb
      or source_field -> 'filterable' is distinct from 'false'::jsonb
      or source_field -> 'sortable' is distinct from 'false'::jsonb then
      raise exception using errcode = '23514',
        message = 'A system projection contribution must be optional and unindexed';
    end if;
    database_type := vortex_record.database_value_type(source_field);
    sql_type := vortex_record.sql_value_type(database_type);
    if database_type is null or sql_type is null then
      raise exception using errcode = '23514',
        message = 'Contributed field type is unsupported';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(target_record_type -> 'fields') as item(value)
      where pg_catalog.lower(item.value ->> 'fieldId')
        = pg_catalog.lower(field_id_value::text)
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(target_content -> 'actions') as item(value)
      where pg_catalog.lower(item.value ->> 'actionId')
        = pg_catalog.lower(field_id_value::text)
    ) then
      raise exception using errcode = '55000',
        message = 'Contributed field collides with target storage';
    end if;

    begin
      storage_id := (target_record_type ->> 'storageContractId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '55000',
        message = 'Target record storage lineage is incompatible';
    end;
    protected_view_key := target_record_type #>> '{systemProjection,protectedView}';
    select catalogue.* into strict stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = target_module_root_id
      and catalogue.record_type_id = target_record_type_id
      and catalogue.state = 'active';
    if not vortex_platform.is_non_nil_uuid(storage_id::text)
      or not (storage_id = any (storage_ids))
      or storage_id <> stored_catalogue.storage_contract_id
      or not exists (
        select 1
        from vortex_record.release_provisions as provision
        where provision.module_root_id = target_release.root_id
          and provision.release_revision = target_release.release_revision
          and storage_id = any (provision.storage_contract_ids)
      )
      or target_record_type ->> 'storageScope' is distinct from 'organization_shared'
      or stored_catalogue.storage_scope is distinct from 'organization_shared'
      or stored_catalogue.physical_schema_token is distinct from 'system_projection'
      or stored_catalogue.physical_table_token is distinct from
        ('rt_' || pg_catalog.replace(pg_catalog.lower(storage_id::text), '-', ''))
      or stored_catalogue.protected_read_model_key is distinct from protected_view_key
      or protected_view_key is null then
      raise exception using errcode = '55000',
        message = 'Target record storage lineage is incompatible';
    end if;
    perform vortex_record.create_system_projection_companion_storage_internal(
      storage_id, target_module_root_id, target_record_type_id,
      p_module_root_id, p_module_release_revision, source_field, true
    );
  end loop;

  for contribution in
    select item.value
    from pg_catalog.jsonb_array_elements(p_contributions) as item(value)
    order by pg_catalog.lower(item.value ->> 'targetModuleRootId'),
      pg_catalog.lower(item.value ->> 'targetRecordTypeId'),
      pg_catalog.lower(item.value ->> 'contributionId')
  loop
    begin
      contribution_id := (contribution ->> 'contributionId')::uuid;
      target_module_root_id := (contribution ->> 'targetModuleRootId')::uuid;
      target_extension_point_id := (contribution ->> 'targetExtensionPointId')::uuid;
      target_record_type_id := (contribution ->> 'targetRecordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Module contribution identity is invalid';
    end;
    contribution_kind := contribution ->> 'kind';
    target_module_version := contribution ->> 'targetModuleReleaseVersion';
    if contribution_id is null
      or contribution_kind is null
      or target_module_version is null
      or not vortex_platform.is_non_nil_uuid(contribution_id::text)
      or not vortex_platform.is_non_nil_uuid(target_extension_point_id::text)
      or contribution_kind not in ('field', 'action') then
      raise exception using errcode = '22023', message = 'Module contribution binding is invalid';
    end if;

    -- The target is the exact dependency release the resolver bound; it must
    -- still declare the accepting extension point on the named record type.
    select release.* into strict target_release
    from vortex_definition.releases as release
    join vortex_definition.roots as root on root.root_id = release.root_id
    where release.root_id = target_module_root_id
      and release.release_version = target_module_version
      and root.kind = 'module';
    if target_release.validation_contract_version
      <> all (vortex_definition.accepted_contract_version('module')) then
      raise exception using errcode = '23514',
        message = 'Exact target Module release is incompatible';
    end if;
    target_content := target_release.compilation_output #> '{canonical,content}';
    select item.value into target_record_type
    from pg_catalog.jsonb_array_elements(target_content -> 'recordTypes') as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId')
      = pg_catalog.lower(target_record_type_id::text);
    if target_record_type is null then
      raise exception using errcode = '23514', message = 'Target record type is unavailable';
    end if;
    select item.value into target_point
    from pg_catalog.jsonb_array_elements(target_content -> 'extensionPoints') as item(value)
    where pg_catalog.lower(item.value ->> 'extensionPointId')
      = pg_catalog.lower(target_extension_point_id::text);
    if target_point is null
      or pg_catalog.lower(target_point ->> 'recordTypeId')
        <> pg_catalog.lower(target_record_type_id::text)
      or not coalesce((target_point -> 'accepts') ? contribution_kind, false) then
      raise exception using errcode = '23514',
        message = 'Target extension point is unavailable';
    end if;

    -- The contributor's own exact release must declare this contribution to this
    -- target Module's extension point; a caller cannot attach an undeclared field
    -- or action.
    if not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
          coalesce(release_row.compilation_output #> '{canonical,content,contributions}', '[]'::jsonb)
        ) as item(value)
      where pg_catalog.lower(item.value ->> 'contributionId')
          = pg_catalog.lower(contribution_id::text)
        and item.value ->> 'kind' = contribution_kind
        and pg_catalog.lower(item.value #>> '{targetModule,moduleRootId}')
          = pg_catalog.lower(target_module_root_id::text)
        and pg_catalog.lower(item.value ->> 'targetExtensionPointId')
          = pg_catalog.lower(target_extension_point_id::text)
        and (contribution_kind <> 'field'
          or pg_catalog.lower(item.value ->> 'recordTypeId')
            = pg_catalog.lower(contribution ->> 'recordTypeId'))
    ) then
      raise exception using errcode = '23514',
        message = 'Module contribution declaration is unavailable';
    end if;

    if contribution_kind = 'action' then
      -- An action contribution has no physical storage; the exact resolved
      -- binding already carries the capability, so only its identity is echoed.
      if not exists (
        select 1
        from pg_catalog.jsonb_array_elements(release_row.compilation_output #> '{canonical,content,actions}') as item(value)
        where pg_catalog.lower(item.value ->> 'actionId') = pg_catalog.lower(contribution_id::text)
      ) then
        raise exception using errcode = '23514',
          message = 'Contributed action definition is unavailable';
      end if;
      contribution_ids := contribution_ids || contribution_id;
      continue;
    end if;

    -- A field contribution reuses the contributor's exact field definition and
    -- adds its permanent value storage to the target's generated table or projection companion.
    begin
      source_record_type_id := (contribution ->> 'recordTypeId')::uuid;
      field_id_value := (contribution ->> 'fieldId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Contributed field identity is invalid';
    end;
    if not vortex_platform.is_non_nil_uuid(source_record_type_id::text)
      or not vortex_platform.is_non_nil_uuid(field_id_value::text)
      or field_id_value <> contribution_id then
      raise exception using errcode = '22023', message = 'Contributed field identity is invalid';
    end if;
    source_field := null;
    select item.value into source_field
    from pg_catalog.jsonb_array_elements(
        release_row.compilation_output #> '{canonical,content,recordTypes}'
      ) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'fields'
    ) as item(value)
    where pg_catalog.lower(record_item.value ->> 'recordTypeId')
        = pg_catalog.lower(source_record_type_id::text)
      and pg_catalog.lower(item.value ->> 'fieldId')
        = pg_catalog.lower(field_id_value::text);
    if source_field is null then
      raise exception using errcode = '23514',
        message = 'Contributed field definition is unavailable';
    end if;

    -- The contributed identity may not collide with the target's own component.
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(target_record_type -> 'fields') as item(value)
      where pg_catalog.lower(item.value ->> 'fieldId')
        = pg_catalog.lower(field_id_value::text)
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(target_content -> 'actions') as item(value)
      where pg_catalog.lower(item.value ->> 'actionId')
        = pg_catalog.lower(field_id_value::text)
    ) then
      raise exception using errcode = '55000',
        message = 'Contributed field collides with target storage';
    end if;

    select catalogue.* into strict stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = target_module_root_id
      and catalogue.record_type_id = target_record_type_id
      and catalogue.state = 'active';
    table_token := stored_catalogue.physical_table_token;
    storage_scope_value := stored_catalogue.storage_scope;
    scope_index_columns := vortex_record.index_scope_columns(storage_scope_value);
    is_projection := target_record_type ? 'systemProjection';
    column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
    database_type := vortex_record.database_value_type(source_field);
    sql_type := vortex_record.sql_value_type(database_type);
    if database_type is null or sql_type is null then
      raise exception using errcode = '23514', message = 'Contributed field type is unsupported';
    end if;

    select mapping.* into stored_field
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = stored_catalogue.storage_contract_id
      and mapping.field_id = field_id_value
    for update;
    if found then
      select pg_catalog.max(provision.release_revision) into contributor_revision
      from vortex_record.release_provisions as provision
      where provision.module_root_id = p_module_root_id;
      if stored_field.physical_column_token <> column_token
        or stored_field.database_value_type <> database_type
        or stored_field.introduced_by_module_root_id <> p_module_root_id
        or not vortex_record.field_storage_compatible(
          stored_field.field_definition, source_field,
          p_module_release_revision < contributor_revision
        )
        or stored_field.state not in ('active', 'retired') then
        raise exception using errcode = '55000',
          message = 'Existing contributed field storage is incompatible';
      end if;
      if source_field ->> 'type' in ('choice', 'several_choices')
        and p_module_release_revision >= contributor_revision
        and stored_field.field_definition is distinct from source_field then
        update vortex_record.field_storage_mappings as mapping
        set field_definition = source_field
        where mapping.storage_contract_id = stored_catalogue.storage_contract_id
          and mapping.field_id = field_id_value;
        any_change := true;
      end if;
    end if;

    if is_projection then
      begin
        storage_id := (target_record_type ->> 'storageContractId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '55000',
          message = 'Target record storage lineage is incompatible';
      end;
      if storage_id is distinct from stored_catalogue.storage_contract_id
        or stored_catalogue.storage_scope is distinct from 'organization_shared'
        or stored_catalogue.physical_schema_token is distinct from 'system_projection'
        or stored_catalogue.physical_table_token is distinct from
          ('rt_' || pg_catalog.replace(pg_catalog.lower(storage_id::text), '-', ''))
        or stored_catalogue.protected_read_model_key is distinct from
          (target_record_type #>> '{systemProjection,protectedView}') then
        raise exception using errcode = '55000',
          message = 'Target record storage lineage is incompatible';
      end if;
      perform vortex_record.create_system_projection_companion_storage_internal(
        stored_catalogue.storage_contract_id, target_module_root_id,
        target_record_type_id, p_module_root_id, p_module_release_revision, source_field, false
      );
      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = stored_catalogue.storage_contract_id
        and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.introduced_by_module_root_id <> p_module_root_id
          or stored_field.state not in ('active', 'retired') then
          raise exception using errcode = '55000',
            message = 'Existing contributed field storage is incompatible';
        end if;
        if stored_field.state = 'retired' then
          update vortex_record.field_storage_mappings as mapping
          set state = 'active',
              retired_by_module_root_id = null,
              retired_at_release_revision = null
          where mapping.storage_contract_id = stored_catalogue.storage_contract_id
            and mapping.field_id = field_id_value;
          any_change := true;
        end if;
      else
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          stored_catalogue.storage_contract_id, field_id_value, column_token, database_type,
          source_field, p_module_root_id, p_module_release_revision, 'active'
        );
        any_change := true;
      end if;
    else
      if stored_catalogue.physical_schema_token <> 'record_data'
        or scope_index_columns is null then
        raise exception using errcode = '55000', message = 'Target record storage is incompatible';
      end if;

      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = stored_catalogue.storage_contract_id
        and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.introduced_by_module_root_id <> p_module_root_id
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
          raise exception using errcode = '55000',
            message = 'Existing contributed field storage is incompatible';
        end if;
        if stored_field.state = 'retired' then
          update vortex_record.field_storage_mappings as mapping
          set state = 'active',
              retired_by_module_root_id = null,
              retired_at_release_revision = null
          where mapping.storage_contract_id = stored_catalogue.storage_contract_id
            and mapping.field_id = field_id_value;
          any_change := true;
        elsif stored_field.state <> 'active' then
          raise exception using errcode = '55000',
            message = 'Existing contributed field storage is incompatible';
        end if;
      else
        if (source_field ->> 'required')::boolean then
          raise exception using errcode = '55000',
            message = 'A new contributed field must be optional on shared storage';
        end if;
        -- A column without a mapping has unknown meaning and values, so it is
        -- never adopted.
        if exists (
          select 1
          from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = pg_catalog.to_regclass(
              pg_catalog.format('%I.%I', 'record_data', table_token)
            )
            and attribute.attname = column_token
            and attribute.attnum > 0
            and not attribute.attisdropped
        ) then
          raise exception using errcode = '55000',
            message = 'Existing contributed field storage is incompatible';
        end if;
        execute pg_catalog.format(
          'alter table record_data.%I add column %I %s',
          table_token, column_token, sql_type
        );
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          stored_catalogue.storage_contract_id, field_id_value, column_token, database_type,
          source_field, p_module_root_id, p_module_release_revision, 'active'
        );
        if (source_field ->> 'unique')::boolean then
          perform vortex_record.ensure_field_index_internal(
            stored_catalogue.storage_contract_id, field_id_value, 'uniqueness',
            storage_scope_value, table_token, scope_index_columns, column_token
          );
        elsif (source_field ->> 'filterable')::boolean
          or (source_field ->> 'sortable')::boolean then
          perform vortex_record.ensure_field_index_internal(
            stored_catalogue.storage_contract_id, field_id_value, 'performance',
            storage_scope_value, table_token, scope_index_columns, column_token
          );
        end if;
        any_change := true;
      end if;
    end if;

    contribution_ids := contribution_ids || contribution_id;
  end loop;

  return query select p_module_root_id, p_module_release_revision, contribution_ids, any_change;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module contribution evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module contribution evidence is ambiguous';
end
$function$;

alter function vortex_record.provision_exact_module_contributions(uuid,bigint,jsonb) owner to vortex_owner;

revoke all on function vortex_record.provision_exact_module_contributions(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.provision_exact_module_contributions(uuid, bigint, jsonb)
  to vortex_owner;
comment on function vortex_record.provision_exact_module_contributions(uuid, bigint, jsonb) is
  'Private exact-release contributor storage provisioner: adds generated-table fields or optional unindexed system-projection companion fields and records their retained lineage. It never drops a column, changes projection identity, or overwrites a value.';

drop function vortex_record.create_system_projection_companion_storage_internal(uuid, uuid, uuid, uuid, jsonb, boolean);

reset role;
