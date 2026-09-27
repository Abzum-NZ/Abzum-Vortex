create or replace function vortex_record.create_record_storage_table_internal(
  p_storage_contract_id uuid,
  p_module_root_id uuid,
  p_record_type_id uuid,
  p_storage_scope text,
  p_ownership_mode text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  table_token text;
  scope_index_columns text;
  scope_check text;
  owner_check text;
begin
  if not vortex_context.is_non_nil_uuid(p_storage_contract_id::text)
    or not vortex_context.is_non_nil_uuid(p_module_root_id::text)
    or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or p_storage_scope not in ('organization_shared', 'application_contained')
    or p_ownership_mode not in ('none', 'organization_account', 'group', 'inherited') then
    raise exception using errcode = '22023', message = 'Record storage identity is invalid';
  end if;

  table_token := 'rt_' || pg_catalog.replace(
    pg_catalog.lower(p_storage_contract_id::text), '-', ''
  );
  scope_index_columns := case p_storage_scope
    when 'organization_shared' then 'organisation_id'
    else 'organisation_id, application_root_id'
  end;
  scope_check := case p_storage_scope
    when 'organization_shared' then 'application_root_id is null'
    else 'application_root_id is not null'
  end;
  owner_check := case p_ownership_mode
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
    )', table_token, p_module_root_id, p_record_type_id, p_storage_contract_id,
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
end
$function$;

revoke all on function vortex_record.create_record_storage_table_internal(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.create_record_storage_table_internal(uuid, uuid, uuid, text, text)
  to vortex_record_owner;
comment on function vortex_record.create_record_storage_table_internal(uuid, uuid, uuid, text, text) is
  'Creates one generated Record storage table with its fixed scope checks and request-adapter policies.';
