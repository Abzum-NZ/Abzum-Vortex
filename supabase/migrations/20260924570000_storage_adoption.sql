-- #626: atomic storage adoption and safe retirement (the switch and retire steps
-- of add, migrate, switch and retire; #625 prepared and ran the migrate step).
--
-- #625 leaves a converted plan with a `planned` target mapping and an `active`
-- source mapping, and nothing that switches them. This migration adds exactly
-- one protected operation, `vortex_record.adopt_storage_conversion`, and the
-- private helpers it needs. Every existing function is untouched; nothing is
-- replaced or patched.
--
-- The operation runs in the request transaction that also moves the installation
-- to the new release (detach, provision the pins before the converted Module,
-- adopt, provision the rest, activate: see runtime/module/src/storage-conversion.ts),
-- so readers, writers and the release change together or not at all:
--
-- 1. Authority: the same Application-management authority every conversion
--    operation requires, and a scope and Module derived from the validated
--    request context and the immutable catalogue -- never from the caller.
--    Switching the shared mappings changes the Module's storage for every
--    installation, so only the Module owner may make the switch; another
--    organisation may adopt its own converted plan once the switch is made.
-- 2. Locks, in the order the installer and provisioner already use: the
--    caller's binding identity first (advisory, then the row), then the storage
--    lineage locks of the converted Module's target release in the provisioner's
--    canonical order up to and including the converted lineage, then the plan
--    and the in-scope records, then the source and target mapping rows in
--    canonical field-id order. The
--    installer's own organisation Access lock, taken by the detach before this
--    runs, already excludes every other request of the organisation.
-- 3. Stale or incomplete plans are refused: the caller's plan must be
--    `converted` at the expected revision, and every record in scope must be
--    converted at its live concurrency revision (the exact candidate predicate
--    of `convert_record_storage_batch`), with a required target populated, so a
--    record written or added since the #625 batch refuses the adoption rather
--    than being silently skipped. The records are share-locked without waiting,
--    so a writer still in flight refuses the adoption as a conflict instead of
--    deadlocking against the binding lock it takes after its row write.
-- 4. Dependents: the caller's own binding must already be detached, and no
--    provisioned or active binding may still install a Module release whose
--    published content carries the source field. If any does, the adoption is
--    refused whole and both mappings stay as they were; no partial switch and no
--    retirement while a consumer remains.
-- 5. Switch: the target mapping becomes `active` and the source mapping
--    `retired` together, and the target field's exact index is created and
--    recorded, so the release provisioning and activation gates that follow in
--    the same transaction see complete storage.
--
-- Retirement is a mapping state change only. The source column and its data are
-- never dropped here (no eager physical drop), so a detached installation's
-- unconverted values are retained. Nothing here changes a permission, a
-- protection or a record's concurrency number.

begin;

-- Module owns installation facts. These two checks answer the only installation
-- questions adoption has: is the caller's own binding detached at the exact
-- source release (and locked for this transaction), and how many bindings still
-- install a release that needs the source field.
set local role vortex_module_owner;

create function vortex_module.lock_storage_adoption_binding_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_module_root_id uuid,
  p_storage_contract_id uuid,
  p_source_release_revision bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  own_binding vortex_module.installation_bindings%rowtype;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_source_release_revision is null
    or p_source_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Storage adoption binding command is invalid';
  end if;

  -- The same identity and order every binding writer uses, so this never
  -- interleaves with a provision, activation or detach of the same binding.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_module.binding:' || p_organization_id::text || ':' ||
        p_application_root_id::text || ':' || p_module_root_id::text,
      0
    )
  );

  select binding.* into own_binding
  from vortex_module.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = p_module_root_id
  for update;
  if not found
    or own_binding.module_release_revision <> p_source_release_revision
    or not (p_storage_contract_id = any (own_binding.storage_contract_ids)) then
    raise exception using errcode = '55000',
      message = 'Storage adoption installation does not install the source release';
  end if;
  -- An installation still using the source field cannot lose it.
  if own_binding.state <> 'detached' then
    raise exception using errcode = '55006',
      message = 'Storage adoption installation is still using the source storage';
  end if;
end
$function$;

create function vortex_module.count_storage_adoption_dependents_internal(
  p_module_root_id uuid,
  p_storage_contract_id uuid,
  p_dependent_release_revisions bigint[]
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  dependent_count bigint;
begin
  if p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_dependent_release_revisions is null
    or pg_catalog.array_position(p_dependent_release_revisions, null) is not null then
    raise exception using errcode = '22023',
      message = 'Storage adoption dependent count command is invalid';
  end if;

  -- Every organisation's binding counts: the mappings are shared by every
  -- installation of the Module. A provisioned binding is counted with an active
  -- one because activation does not recheck storage, so it could otherwise
  -- activate over a retired field; only a detached binding stops depending on
  -- the source field. The caller holds the storage-lineage lock, which every
  -- provision of these releases takes before it writes a binding, so no new
  -- dependent can appear unseen.
  select pg_catalog.count(*) into dependent_count
  from vortex_module.installation_bindings as binding
  where binding.module_root_id = p_module_root_id
    and binding.state in ('provisioned', 'active')
    and p_storage_contract_id = any (binding.storage_contract_ids)
    and binding.module_release_revision = any (p_dependent_release_revisions);
  return dependent_count;
end
$function$;

revoke all on function vortex_module.lock_storage_adoption_binding_internal(
  uuid, uuid, uuid, uuid, bigint
), vortex_module.count_storage_adoption_dependents_internal(uuid, uuid, bigint[])
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
grant execute on function vortex_module.lock_storage_adoption_binding_internal(
  uuid, uuid, uuid, uuid, bigint
) to vortex_record_owner;
grant execute on function vortex_module.count_storage_adoption_dependents_internal(
  uuid, uuid, bigint[]
) to vortex_record_owner;
comment on function vortex_module.lock_storage_adoption_binding_internal(
  uuid, uuid, uuid, uuid, bigint
) is 'Private storage adoption fact: locks the caller''s own binding in canonical order and requires it detached at the exact source release.';
comment on function vortex_module.count_storage_adoption_dependents_internal(
  uuid, uuid, bigint[]
) is 'Private storage adoption fact: counts every organisation''s provisioned and active bindings of the Module that install one of the named releases needing the source storage.';

reset role;

set local role vortex_record_owner;

-- The caller-scoped binding lock and the storage-lineage locks, exposed to the
-- adapter-owned operation below. The lineage locks mirror the provisioner that
-- runs next in the same transaction: it locks every lineage of the converted
-- Module's target release in ascending storage-contract order, so taking the
-- lineages before the converted one first keeps every lineage lock in that one
-- canonical order.
create function vortex_record.lock_storage_adoption_internal(
  p_conversion_contract_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  conversion vortex_record.storage_conversion_catalogue%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  target_record_types jsonb;
  lineage record;
  lineage_id uuid;
  converted_lineage_locked boolean := false;
begin
  select entry.* into strict conversion
  from vortex_record.storage_conversion_catalogue as entry
  where entry.conversion_contract_id = p_conversion_contract_id;
  select catalogue.* into strict catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = conversion.source_storage_contract_id;

  perform vortex_module.lock_storage_adoption_binding_internal(
    p_organization_id, p_application_root_id, catalogue_row.module_root_id,
    conversion.source_storage_contract_id, conversion.source_release_revision
  );

  select release.compilation_output #> '{canonical,content,recordTypes}'
  into strict target_record_types
  from vortex_definition.releases as release
  where release.root_id = catalogue_row.module_root_id
    and release.release_revision = conversion.target_release_revision;
  if pg_catalog.jsonb_typeof(target_record_types) is distinct from 'array' then
    raise exception using errcode = '55000',
      message = 'Storage adoption target release is incompatible';
  end if;

  -- The provisioner's exact loop order (by the published storage identity).
  for lineage in
    select item.value ->> 'storageContractId' as storage_contract_text
    from pg_catalog.jsonb_array_elements(target_record_types) as item(value)
    order by item.value ->> 'storageContractId'
  loop
    lineage_id := lineage.storage_contract_text::uuid;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || lineage_id::text, 0)
    );
    if lineage_id = conversion.source_storage_contract_id then
      converted_lineage_locked := true;
      exit;
    end if;
  end loop;
  if not converted_lineage_locked then
    raise exception using errcode = '55000',
      message = 'Storage adoption target release does not carry the converted storage';
  end if;
exception
  when no_data_found or too_many_rows or invalid_text_representation then
    raise exception using errcode = '55000',
      message = 'Storage adoption evidence is unavailable';
end
$function$;

-- Counts dependents, switches the two mappings and records the target field's
-- exact index. It runs after the adapter-owned operation has proved the plan
-- fresh and complete while holding the storage-lineage lock, and either returns
-- with both mappings switched or raises with neither changed.
create function vortex_record.switch_storage_conversion_mappings_internal(
  p_conversion_contract_id uuid,
  p_owns_module boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  conversion vortex_record.storage_conversion_catalogue%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  source_mapping vortex_record.field_storage_mappings%rowtype;
  target_mapping vortex_record.field_storage_mappings%rowtype;
  mapping_lock record;
  dependent_release_revisions bigint[];
  dependent_count bigint;
  index_purpose text;
begin
  if p_owns_module is null then
    raise exception using errcode = '22023',
      message = 'Storage adoption switch command is invalid';
  end if;

  select entry.* into strict conversion
  from vortex_record.storage_conversion_catalogue as entry
  where entry.conversion_contract_id = p_conversion_contract_id;
  select catalogue.* into strict catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = conversion.source_storage_contract_id;
  if catalogue_row.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Storage adoption contract is unavailable';
  end if;

  -- Both mappings, in canonical field-id order, the same order the provisioner
  -- and the #625 staging use.
  for mapping_lock in
    select mapping.field_id
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = conversion.source_storage_contract_id
      and mapping.field_id in (conversion.source_field_id, conversion.target_field_id)
    order by mapping.field_id
    for update
  loop
    null;
  end loop;

  select mapping.* into strict source_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.source_field_id;
  select mapping.* into strict target_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.target_field_id;

  -- A completed switch is an unchanged replay, for the Module owner and for
  -- any other organisation adopting its own converted plan afterwards.
  if source_mapping.state = 'retired'
    and source_mapping.retired_at_release_revision = conversion.target_release_revision
    and target_mapping.state = 'active'
    and target_mapping.introduced_at_release_revision = conversion.target_release_revision then
    return pg_catalog.jsonb_build_object('changed', false, 'dependentCount', 0);
  end if;

  -- Making the switch changes the Module's shared storage for every
  -- installation, so only the organisation that owns the Module may do it.
  if not p_owns_module then
    raise exception using errcode = '42501',
      message = 'Storage adoption switch requires the Module owner';
  end if;

  if source_mapping.state <> 'active'
    or source_mapping.database_value_type <> conversion.source_database_value_type
    or target_mapping.state <> 'planned'
    or target_mapping.database_value_type <> conversion.target_database_value_type
    or target_mapping.physical_column_token <> 'f_' || pg_catalog.replace(
      pg_catalog.lower(conversion.target_field_id::text), '-', ''
    )
    or target_mapping.introduced_at_release_revision <> conversion.target_release_revision
    or vortex_record.field_storage_meaning(target_mapping.field_definition)
      is distinct from vortex_record.field_storage_meaning(conversion.target_field_definition)
  then
    raise exception using errcode = '55000',
      message = 'Storage adoption mappings are incompatible';
  end if;

  -- Every published release of the Module whose content still carries the
  -- source field in this storage, whatever its revision: an older release
  -- provisioned after a newer one introduced the field, and a later release
  -- that kept it, both need the source column.
  select coalesce(
    pg_catalog.array_agg(release.release_revision order by release.release_revision),
    array[]::bigint[]
  )
  into dependent_release_revisions
  from vortex_definition.releases as release
  where release.root_id = catalogue_row.module_root_id
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(
            release.compilation_output #> '{canonical,content,recordTypes}'
          ) = 'array'
            then release.compilation_output #> '{canonical,content,recordTypes}'
          else '[]'::jsonb
        end
      ) as record_item(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(record_item.value -> 'fields') = 'array'
            then record_item.value -> 'fields'
          else '[]'::jsonb
        end
      ) as field_item(value)
      where pg_catalog.lower(record_item.value ->> 'storageContractId')
          = conversion.source_storage_contract_id::text
        and pg_catalog.lower(field_item.value ->> 'fieldId')
          = conversion.source_field_id::text
    );

  -- Any installation of such a release keeps the whole storage in place:
  -- retiring it would strip an installation of a required column.
  dependent_count := vortex_module.count_storage_adoption_dependents_internal(
    catalogue_row.module_root_id, conversion.source_storage_contract_id,
    dependent_release_revisions
  );
  if dependent_count > 0 then
    raise exception using errcode = '55006',
      message = 'Storage adoption is blocked while installations still use the source storage';
  end if;

  update vortex_record.field_storage_mappings as mapping
  set state = 'retired',
      retired_by_module_root_id = catalogue_row.module_root_id,
      retired_at_release_revision = conversion.target_release_revision
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.source_field_id
    and mapping.state = 'active';
  if not found then
    raise exception using errcode = '40001',
      message = 'Storage adoption source mapping changed';
  end if;

  update vortex_record.field_storage_mappings as mapping
  set state = 'active'
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.target_field_id
    and mapping.state = 'planned';
  if not found then
    raise exception using errcode = '40001',
      message = 'Storage adoption target mapping changed';
  end if;

  -- The activation gate reads the recorded index of every active field, and
  -- the provisioner only indexes a field it creates, so the switched target
  -- field's index is created here with the provisioner's branch order. A
  -- duplicate converted value refuses the uniqueness index and rolls the whole
  -- adoption back.
  index_purpose := case
    when coalesce((target_mapping.field_definition ->> 'unique')::boolean, false)
      then 'uniqueness'
    when coalesce((target_mapping.field_definition ->> 'filterable')::boolean, false)
      or coalesce((target_mapping.field_definition ->> 'sortable')::boolean, false)
      then 'performance'
    else null
  end;
  if index_purpose is not null then
    begin
      perform vortex_record.ensure_field_index_internal(
        conversion.source_storage_contract_id, conversion.target_field_id, index_purpose,
        catalogue_row.storage_scope, catalogue_row.physical_table_token,
        vortex_record.index_scope_columns(catalogue_row.storage_scope),
        target_mapping.physical_column_token
      );
    exception
      when unique_violation then
        raise exception using errcode = '55000',
          message = 'Storage adoption converted values are not unique';
    end;
  end if;

  return pg_catalog.jsonb_build_object('changed', true, 'dependentCount', dependent_count);
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '55000',
      message = 'Storage adoption evidence is unavailable';
end
$function$;

revoke all on function vortex_record.lock_storage_adoption_internal(uuid, uuid, uuid),
  vortex_record.switch_storage_conversion_mappings_internal(uuid, boolean)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.lock_storage_adoption_internal(uuid, uuid, uuid)
  to vortex_record_adapter;
grant execute on function vortex_record.switch_storage_conversion_mappings_internal(uuid, boolean)
  to vortex_record_adapter;

comment on function vortex_record.lock_storage_adoption_internal(uuid, uuid, uuid) is
  'Private helper: locks the caller''s own binding for one conversion, requires it detached at the exact source release, then takes the target release''s storage-lineage locks in the provisioner''s canonical order up to the converted lineage.';
comment on function vortex_record.switch_storage_conversion_mappings_internal(uuid, boolean) is
  'Private helper: refuses while any installation of a release carrying the source field remains, then (Module owner only) switches the target mapping to active, the source mapping to retired and records the target field''s index; a completed switch is an unchanged replay; never drops a column.';

reset role;

-- The record-row check needs the adapter, whose forced row-level security scopes
-- every read to the validated request context.
set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create function vortex_record.adopt_storage_conversion(
  p_conversion_contract_id uuid,
  p_expected_plan_revision bigint,
  p_application_root_id uuid,
  p_module_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority jsonb;
  organisation_id_value uuid;
  scope_application_root_id uuid;
  conversion vortex_record.storage_conversion_catalogue%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  plan_row vortex_record.storage_conversion_plans%rowtype;
  target_mapping vortex_record.field_storage_mappings%rowtype;
  target_required boolean;
  lock_sql text;
  check_sql text;
  unfinished_count bigint;
  switched jsonb;
begin
  if p_conversion_contract_id is null
    or p_conversion_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_plan_revision is null
    or p_expected_plan_revision not between 1 and 9007199254740991
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Storage adoption command is invalid';
  end if;

  select entry.* into conversion
  from vortex_record.storage_conversion_catalogue as entry
  where entry.conversion_contract_id = p_conversion_contract_id;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Storage conversion plan is unavailable';
  end if;

  -- The installation is already detached by this transaction, so authority is
  -- proved without requiring an active installation.
  authority := vortex_record.authorize_storage_conversion_internal(
    conversion.source_storage_contract_id, null
  );
  organisation_id_value := (authority ->> 'organizationId')::uuid;
  scope_application_root_id := (authority ->> 'applicationRootId')::uuid;
  if scope_application_root_id is not null
    and scope_application_root_id <> p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Storage adoption Application is outside the request context';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = conversion.source_storage_contract_id;
  if not found or catalogue_row.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Storage adoption contract is unavailable';
  end if;
  -- The caller names the converted Module so it can adopt at that Module's
  -- place in the canonical provisioning order; the catalogue decides it.
  if catalogue_row.module_root_id <> p_module_root_id then
    raise exception using errcode = '55000',
      message = 'Storage adoption Module is incompatible';
  end if;

  -- Binding identity first, then the storage lineages: the provisioner's order.
  perform vortex_record.lock_storage_adoption_internal(
    p_conversion_contract_id, organisation_id_value, p_application_root_id
  );

  select plan.* into plan_row
  from vortex_record.storage_conversion_plans as plan
  where plan.conversion_contract_id = p_conversion_contract_id
    and plan.organisation_id = organisation_id_value
    and plan.application_root_id is not distinct from scope_application_root_id
  for update;
  if not found then
    raise exception using errcode = '55000',
      message = 'Storage conversion plan is not allocated';
  end if;
  if plan_row.plan_revision <> p_expected_plan_revision then
    raise exception using errcode = '40001',
      message = 'Storage conversion plan changed';
  end if;
  if plan_row.state <> 'converted' then
    raise exception using errcode = '55000',
      message = 'Storage conversion plan is incomplete';
  end if;

  select mapping.* into target_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.target_field_id;
  if not found then
    raise exception using errcode = '55000',
      message = 'Storage adoption target mapping is not allocated';
  end if;
  target_required := coalesce(
    (conversion.target_field_definition ->> 'required')::boolean, false
  );

  -- Hold every in-scope record still while it is judged. A writer of this scope
  -- locks its row before it takes the binding lock this transaction already
  -- holds, so waiting for it here could deadlock: a row still locked by a writer
  -- in flight refuses the adoption as a retryable conflict instead. The next
  -- statement then reads the committed state.
  lock_sql := pg_catalog.format(
    'select 1 from record_data.%I as stored'
      || ' where stored.organisation_id = $1::uuid'
      || ' and stored.application_root_id is not distinct from $2::uuid'
      || ' order by stored.record_id'
      || ' for share of stored nowait',
    catalogue_row.physical_table_token
  );
  begin
    execute lock_sql using organisation_id_value, scope_application_root_id;
  exception
    when lock_not_available then
      raise exception using errcode = '40001',
        message = 'Storage adoption records are being changed';
  end;

  -- The exact candidate predicate of `convert_record_storage_batch`: a record
  -- never converted, or converted under an older concurrency revision, is
  -- unfinished. A required target field must also hold a value.
  check_sql := pg_catalog.format(
    'select pg_catalog.count(*)'
      || ' from record_data.%I as stored'
      || ' left join vortex_record.storage_conversion_progress as progress'
      || ' on progress.conversion_contract_id = $1::uuid'
      || ' and progress.organisation_id = stored.organisation_id'
      || ' and progress.application_root_id is not distinct from stored.application_root_id'
      || ' and progress.record_id = stored.record_id'
      || ' where stored.organisation_id = $2::uuid'
      || ' and stored.application_root_id is not distinct from $3::uuid'
      || ' and (progress.record_id is null'
      || ' or progress.source_concurrency_number <> stored.concurrency_number'
      || ' or ($4::boolean and stored.%I is null))',
    catalogue_row.physical_table_token, target_mapping.physical_column_token
  );
  execute check_sql into unfinished_count
    using p_conversion_contract_id, organisation_id_value,
      scope_application_root_id, target_required;
  if unfinished_count > 0 then
    raise exception using errcode = '55000',
      message = 'Storage conversion has records changed or missed since conversion';
  end if;

  switched := vortex_record.switch_storage_conversion_mappings_internal(
    p_conversion_contract_id, (authority ->> 'ownsModule')::boolean
  );

  return pg_catalog.jsonb_build_object(
    'conversionContractId', conversion.conversion_contract_id,
    'storageContractId', conversion.source_storage_contract_id,
    'moduleRootId', catalogue_row.module_root_id,
    'sourceFieldId', conversion.source_field_id,
    'targetFieldId', conversion.target_field_id,
    'organisationId', organisation_id_value,
    'applicationRootId', p_application_root_id,
    'sourceReleaseRevision', conversion.source_release_revision,
    'targetReleaseRevision', conversion.target_release_revision,
    'planRevision', plan_row.plan_revision,
    'dependentCount', (switched ->> 'dependentCount')::bigint,
    'changed', (switched ->> 'changed')::boolean
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '55000',
      message = 'Storage adoption evidence is unavailable';
end
$function$;

revoke all on function vortex_record.adopt_storage_conversion(uuid, bigint, uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.adopt_storage_conversion(uuid, bigint, uuid, uuid)
  to vortex_request;
comment on function vortex_record.adopt_storage_conversion(uuid, bigint, uuid, uuid) is
  'Atomic storage adoption for one detached installation: refuses stale or incomplete plans and any remaining installation of a release carrying the source field, then switches the target mapping to active and the source mapping to retired together; never drops a column.';

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
