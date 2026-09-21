-- Account offboarding inventory. Application-contained previews are a protected
-- read: accounts.manage admits the preview and the existing exact transfer
-- decision admits each disclosed record. Organisation-shared authority remains
-- deliberately blocked until its product rule is selected.

-- Keep the generic account-lifecycle scope private to Request. This bridge is
-- the sole adapter capability for the inventory's fixed accounts.manage check;
-- it exposes only the scope tuple the public inventory entry needs.
create function vortex_access.organization_accounts_offboarding_inventory_scope_internal()
returns table (
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint
)
language sql
volatile
security definer
set search_path = ''
as $function$
  select authorized.tenant_id, authorized.organization_id,
    authorized.organization_account_id, authorized.access_version
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
$function$;

revoke all on function vortex_access.organization_accounts_offboarding_inventory_scope_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.organization_accounts_offboarding_inventory_scope_internal()
  to vortex_record_adapter;
comment on function vortex_access.organization_accounts_offboarding_inventory_scope_internal() is
  'Private adapter-only bridge for the fixed accounts.manage check in account-offboarding inventory.';

set local role vortex_module_owner;

create function vortex_module.read_current_offboarding_inventory_installation_internal()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installation jsonb;
  installation_state text;
  context_value jsonb;
  storage_contract_ids jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory requires an application context';
  end if;

  begin
    installation := vortex_module.read_current_active_installation();
    installation_state := 'active';
  exception
    when no_data_found then
      installation := vortex_module.read_current_detached_installation_for_transfer_internal();
      installation_state := 'detached';
  end;

  select coalesce(pg_catalog.jsonb_agg(contract_id order by contract_id), '[]'::jsonb)
  into storage_contract_ids
  from (
    select distinct unnest(binding.storage_contract_ids) as contract_id
    from vortex_module.installation_bindings as binding
    where binding.organization_id = (context_value ->> 'organizationId')::uuid
      and binding.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and binding.state = installation_state
      and binding.application_release_revision =
        (installation ->> 'applicationReleaseRevision')::bigint
  ) as contracts;

  if storage_contract_ids = '[]'::jsonb then
    raise exception using errcode = '55000',
      message = 'Offboarding inventory installation bindings are unavailable';
  end if;

  return installation || pg_catalog.jsonb_build_object(
    'installationState', installation_state,
    'storageContractIds', storage_contract_ids
  );
end
$function$;

revoke all on function vortex_module.read_current_offboarding_inventory_installation_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_module.read_current_offboarding_inventory_installation_internal()
  to vortex_record_adapter;
comment on function vortex_module.read_current_offboarding_inventory_installation_internal() is
  'Private exact active-or-detached installation reader with the bound storage contracts for account-offboarding inventory.';

reset role;
set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create function vortex_record.list_offboarding_owned_records_internal(
  p_source_organization_account_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_after_storage_contract_id uuid,
  p_after_record_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  installation jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  candidate_record_id uuid;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  lifecycle_state_value text;
  classification_value text;
  item_value jsonb;
  items jsonb := '[]'::jsonb;
  counts jsonb := '{}'::jsonb;
  item_count integer := 0;
  has_more boolean := false;
  last_storage_contract_id uuid;
  last_record_id uuid;
  candidate_sql text;
begin
  if p_source_organization_account_id is null
    or p_source_organization_account_id = nil_uuid
    or p_target_id is null
    or p_target_id = nil_uuid
    or p_target_kind not in ('organization_account', 'group')
    or p_limit not between 1 and 50
    or ((p_after_storage_contract_id is null) <> (p_after_record_id is null)) then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory requires an application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  installation := vortex_module.read_current_offboarding_inventory_installation_internal();

  for catalogue_row in
    select catalogue.*
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id in (
      select (value #>> '{}')::uuid
      from pg_catalog.jsonb_array_elements(installation -> 'storageContractIds') as item(value)
    )
      and catalogue.state = 'active'
      and catalogue.storage_scope = 'application_contained'
      and catalogue.record_type_definition ->> 'ownershipMode' = 'organization_account'
      and (
        p_after_storage_contract_id is null
        or catalogue.storage_contract_id >= p_after_storage_contract_id
      )
    order by catalogue.storage_contract_id
  loop
    if p_after_storage_contract_id is not null
      and catalogue_row.storage_contract_id = p_after_storage_contract_id
      and p_after_record_id is null then
      continue;
    end if;

    candidate_sql := pg_catalog.format(
      'select stored.record_id
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.application_root_id = $2
         and stored.owner_organisation_account_id = $3%s
       order by stored.record_id',
      catalogue_row.physical_table_token,
      case
        when p_after_storage_contract_id = catalogue_row.storage_contract_id
          then ' and stored.record_id > $4'
        else ''
      end
    );

    for candidate_record_id in execute candidate_sql
      using organization_id_value, application_root_id_value,
        p_source_organization_account_id, p_after_record_id
    loop
      -- Once the page is full, continue only until a further disclosed record
      -- establishes that the returned keyset cursor has another visible page.
      begin
        loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
          catalogue_row.record_type_id, candidate_record_id, null, installation
        );
        if loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
          continue;
        end if;

        decision := vortex_access.evaluate_organization_record_access_internal(
          loaded -> 'declaration', candidate_record_id, loaded -> 'facts'
        );
        if decision ->> 'outcome' <> 'allowed' then
          continue;
        end if;

        select item.value into record_fact
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
        where (item.value -> 'recordScope' ->> 'recordId')::uuid = candidate_record_id;
        select item.value into record_type_fact
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
        where (item.value ->> 'recordTypeId')::uuid = catalogue_row.record_type_id;
        if record_fact is null or record_type_fact is null
          or record_type_fact ->> 'ownershipMode' <> 'organization_account' then
          continue;
        end if;

        lifecycle_state_value := record_fact ->> 'lifecycleState';
        classification_value := case
          when p_target_kind <> 'organization_account'
            or lifecycle_state_value = 'removal_pending'
            then 'refused_incompatible'
          else 'transferable'
        end;
      exception
        when others then
          -- Candidate failures carry record-specific detail. They are treated
          -- exactly like a refused access decision: absent from the response.
          continue;
      end;

      if item_count >= p_limit then
        has_more := true;
        exit;
      end if;

      item_value := pg_catalog.jsonb_build_object(
        'storageContractId', catalogue_row.storage_contract_id,
        'recordTypeId', catalogue_row.record_type_id,
        'recordId', candidate_record_id,
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'lifecycleState', lifecycle_state_value,
        'installationState', installation -> 'installationState',
        'classification', classification_value
      );
      items := items || pg_catalog.jsonb_build_array(item_value);
      counts := counts || pg_catalog.jsonb_build_object(
        pg_catalog.lower(catalogue_row.record_type_id::text),
        coalesce(counts -> pg_catalog.lower(catalogue_row.record_type_id::text),
          pg_catalog.jsonb_build_object(
            'recordTypeId', catalogue_row.record_type_id,
            'transferable', 0,
            'refusedIncompatible', 0
          )) || pg_catalog.jsonb_build_object(
            case classification_value
              when 'transferable' then 'transferable'
              else 'refusedIncompatible'
            end,
            coalesce((counts -> pg_catalog.lower(catalogue_row.record_type_id::text)
              ->> case classification_value
                when 'transferable' then 'transferable'
                else 'refusedIncompatible'
              end)::integer, 0) + 1
          )
      );
      item_count := item_count + 1;
      last_storage_contract_id := catalogue_row.storage_contract_id;
      last_record_id := candidate_record_id;
    end loop;
    exit when has_more;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'listed',
    'section', pg_catalog.jsonb_build_object(
      'kind', 'application', 'applicationRootId', application_root_id_value
    ),
    'installationState', installation -> 'installationState',
    'items', items,
    'perRecordType', coalesce((
      select pg_catalog.jsonb_agg(entry.value order by entry.value ->> 'recordTypeId')
      from pg_catalog.jsonb_each(counts) as entry(key, value)
    ), '[]'::jsonb)
  ) || case when has_more then pg_catalog.jsonb_build_object(
    'next', pg_catalog.jsonb_build_object(
      'storageContractId', last_storage_contract_id,
      'recordId', last_record_id
    )
  ) else '{}'::jsonb end;
end
$function$;

revoke all on function vortex_record.list_offboarding_owned_records_internal(
  uuid, text, uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
comment on function vortex_record.list_offboarding_owned_records_internal(
  uuid, text, uuid, uuid, uuid, integer
) is
  'Private application-contained account-offboarding inventory; denied candidate records are omitted without identity or count disclosure.';

reset role;
set local role vortex_record_adapter;

create function vortex_record.list_offboarding_owned_records(
  p_source_organization_account_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_section_kind text,
  p_after_storage_contract_id uuid default null,
  p_after_record_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  inventory jsonb;
begin
  select authorized.* into strict scope
  from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;

  if p_section_kind = 'organization_shared' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'blocked',
      'reasonCode', 'shared_transfer_authority_undecided',
      'section', pg_catalog.jsonb_build_object('kind', 'organization_shared'),
      'accessVersion', scope.access_version
    );
  end if;
  if p_section_kind <> 'application' then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory section is invalid';
  end if;

  inventory := vortex_record.list_offboarding_owned_records_internal(
    p_source_organization_account_id, p_target_kind, p_target_id,
    p_after_storage_contract_id, p_after_record_id, p_limit
  );
  return inventory || pg_catalog.jsonb_build_object('accessVersion', scope.access_version);
end
$function$;

revoke all on function vortex_record.list_offboarding_owned_records(
  uuid, text, uuid, text, uuid, uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.list_offboarding_owned_records(
  uuid, text, uuid, text, uuid, uuid, integer
) to vortex_request;
comment on function vortex_record.list_offboarding_owned_records(
  uuid, text, uuid, text, uuid, uuid, integer
) is
  'Protected account-offboarding inventory: accounts.manage once and per-record exact transfer disclosure for the current application; shared authority is explicitly blocked pending product policy.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
