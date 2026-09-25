-- Account offboarding inventory, organisation-shared scope (#563).
-- Completes the protected account-offboarding inventory across the
-- organisation-shared storage scope with per-record disclosure and the
-- applications each shared contract affects, lifting the temporary
-- shared_transfer_authority_undecided gate. Retained rows (active, soft
-- deleted and removal pending) and detached installations were already in
-- scope of the application-contained reader and stay in scope here.
--
-- Section boundary: a shared record is inventoried through the same pinned
-- installation as the application section, so the shared section enumerates the
-- organisation-shared contracts bound to the caller's current application. Each
-- disclosed record still reports every application its contract affects, so the
-- organisation-wide impact of including it is visible.

-- The organisation-shared affected-application set is Module-owned row data.
-- `vortex_module.installation_bindings` is owned by `vortex_module_owner` under
-- forced row-level security with an owner-only policy, and the record adapter
-- holds neither a privilege nor a policy on it. This is the second private
-- adapter-only bridge for the inventory, alongside the installation reader: it
-- resolves the organisation from the verified request context itself and
-- discloses only the application root IDs one storage contract is bound into.
set local role vortex_module_owner;

create function vortex_module.read_offboarding_inventory_contract_applications_internal(
  p_storage_contract_id uuid
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
  affected_applications jsonb;
begin
  if p_storage_contract_id is null or p_storage_contract_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();

  -- Provisioned bindings are not installed and are excluded; detached bindings
  -- are a disabled installation of a real application and stay visible, exactly
  -- as the inventory's installation reader treats them.
  select coalesce(
    pg_catalog.jsonb_agg(
      distinct binding.application_root_id order by binding.application_root_id
    ),
    '[]'::jsonb
  )
  into affected_applications
  from vortex_module.installation_bindings as binding
  where binding.organization_id = (context_value ->> 'organizationId')::uuid
    and binding.state in ('active', 'detached')
    and p_storage_contract_id = any (binding.storage_contract_ids);

  return affected_applications;
end
$function$;

revoke all on function vortex_module.read_offboarding_inventory_contract_applications_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_module.read_offboarding_inventory_contract_applications_internal(uuid)
  to vortex_record_adapter;
comment on function vortex_module.read_offboarding_inventory_contract_applications_internal(uuid) is
  'Private adapter-only bridge returning the installed application root IDs one storage contract is bound into, for account-offboarding shared impact.';

reset role;
set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create function vortex_record.list_offboarding_owned_shared_records_internal(
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
  installation jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  candidate_record_id uuid;
  contract_affected_applications jsonb;
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
  installation := vortex_module.read_current_offboarding_inventory_installation_internal();

  for catalogue_row in
    select catalogue.*
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id in (
      select (value #>> '{}')::uuid
      from pg_catalog.jsonb_array_elements(installation -> 'storageContractIds') as item(value)
    )
      and catalogue.state = 'active'
      and catalogue.storage_scope = 'organization_shared'
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

    -- The affected applications of a contract are a property of the contract,
    -- not of the page: every record disclosed from it carries the complete set.
    contract_affected_applications :=
      vortex_module.read_offboarding_inventory_contract_applications_internal(
        catalogue_row.storage_contract_id
      );

    -- A shared row has no application column value: the storage scope's own
    -- check constraint requires it to be null.
    candidate_sql := pg_catalog.format(
      'select stored.record_id
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.application_root_id is null
         and stored.owner_organisation_account_id = $2%s
       order by stored.record_id',
      catalogue_row.physical_table_token,
      case
        when p_after_storage_contract_id = catalogue_row.storage_contract_id
          then ' and stored.record_id > $3'
        else ''
      end
    );

    for candidate_record_id in execute candidate_sql
      using organization_id_value, p_source_organization_account_id, p_after_record_id
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
          -- Cancellation, resource, operator and internal failures are not
          -- record specific: swallowing one would present a truncated scan as a
          -- complete page, so those classes keep propagating to the caller.
          if pg_catalog.left(returned_sqlstate, 2)
            in ('40', '53', '57', '58', 'XX') then
            raise;
          end if;
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
        'classification', classification_value,
        'storageScope', 'organization_shared',
        'affectedApplications', contract_affected_applications
      );
      items := items || pg_catalog.jsonb_build_array(item_value);
      counts := counts || pg_catalog.jsonb_build_object(
        pg_catalog.lower(catalogue_row.record_type_id::text),
        coalesce(counts -> pg_catalog.lower(catalogue_row.record_type_id::text),
          pg_catalog.jsonb_build_object(
            'recordTypeId', catalogue_row.record_type_id,
            'storageScope', 'organization_shared',
            'transferable', 0,
            'refusedIncompatible', 0,
            'affectedApplications', contract_affected_applications
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

  -- `perRecordType` and `pageAffectedApplications` describe the records
  -- disclosed on this page only. A section-wide total would have to count
  -- records the caller may not read, so the inventory never presents one.
  return pg_catalog.jsonb_build_object(
    'outcome', 'listed',
    'section', pg_catalog.jsonb_build_object('kind', 'organization_shared'),
    'installationState', installation -> 'installationState',
    'items', items,
    'perRecordType', coalesce((
      select pg_catalog.jsonb_agg(entry.value order by entry.value ->> 'recordTypeId')
      from pg_catalog.jsonb_each(counts) as entry(key, value)
    ), '[]'::jsonb),
    'pageAffectedApplications', coalesce((
      select pg_catalog.jsonb_agg(distinct application.value order by application.value)
      from pg_catalog.jsonb_each(counts) as entry(key, value),
      lateral pg_catalog.jsonb_array_elements_text(
        entry.value -> 'affectedApplications'
      ) as application(value)
    ), '[]'::jsonb)
  ) || case when has_more then pg_catalog.jsonb_build_object(
    'next', pg_catalog.jsonb_build_object(
      'storageContractId', last_storage_contract_id,
      'recordId', last_record_id
    )
  ) else '{}'::jsonb end;
end
$function$;

revoke all on function vortex_record.list_offboarding_owned_shared_records_internal(
  uuid, text, uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
comment on function vortex_record.list_offboarding_owned_shared_records_internal(
  uuid, text, uuid, uuid, uuid, integer
) is
  'Private organisation-shared account-offboarding inventory; denied candidate records are omitted without identity or count disclosure, and a non-record failure propagates instead of truncating a page silently.';

-- The application-contained reader keeps its existing behaviour and gains the
-- same propagation rule, so one section cannot present a truncated scan as a
-- complete page while the other refuses.

create or replace function vortex_record.list_offboarding_owned_records_internal(
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
          -- Cancellation, resource, operator and internal failures are not
          -- record specific: swallowing one would present a truncated scan as a
          -- complete page, so those classes keep propagating to the caller.
          if pg_catalog.left(returned_sqlstate, 2)
            in ('40', '53', '57', '58', 'XX') then
            raise;
          end if;
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
  'Private application-contained account-offboarding inventory; denied candidate records are omitted without identity or count disclosure, and a non-record failure propagates instead of truncating a page silently.';

-- The protected entry now serves both sections. Each section paginates over its
-- own keyset, so a caller walks the application section and the shared section
-- separately and sees every disclosed record exactly once.
-- Replacing a function whose owner no longer holds EXECUTE on it is refused on a
-- fresh database, because the earlier migration revoked it from the owner. Lend
-- the owner EXECUTE for the replace; the revoke below removes it again, so the
-- final ACL is unchanged.
grant execute on function vortex_record.list_offboarding_owned_records(
  uuid, text, uuid, text, uuid, uuid, integer
) to vortex_record_adapter;
create or replace function vortex_record.list_offboarding_owned_records(
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
    inventory := vortex_record.list_offboarding_owned_shared_records_internal(
      p_source_organization_account_id, p_target_kind, p_target_id,
      p_after_storage_contract_id, p_after_record_id, p_limit
    );
    return inventory || pg_catalog.jsonb_build_object('accessVersion', scope.access_version);
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
  'Protected account-offboarding inventory: accounts.manage once and per-record exact transfer disclosure for the application-contained and organisation-shared sections.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
