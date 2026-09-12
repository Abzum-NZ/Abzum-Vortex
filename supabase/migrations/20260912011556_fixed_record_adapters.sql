-- Fixed parameterised record adapters over provisioned storage (#401, the
-- first slice of #45): one read adapter and one change adapter, keyed by
-- record-type identity, plus the private facts loader and value validator they
-- share.
--
-- D1. One fixed parameterised pair, not generated functions per record type.
-- The adapters resolve the physical table and columns through the owner-only
-- storage catalogue and run `format()` DML exactly as the provisioner does, so
-- there is one audited path rather than N copies of the same rule. A caller
-- supplies identifiers and values only: never a table, a column, a permission,
-- a declaration, a field set, a predicate or an access graph.
--
-- D2. Both adapters are SECURITY DEFINER owned by `vortex_record_adapter`, the
-- role the generated tables already grant DML to and whose four scope policies
-- they already carry (20260908122641_record_storage_provisioning.sql:637-671).
-- That role is `nobypassrls` and does not own those tables, so every statement
-- below stays subject to the scope policies. Adapters owned by postgres would
-- bypass row security instead of being checked by it.
--
-- D3. The row policies stay scope-only, as the isolation backstop. The complete
-- exact-record decision runs inside the adapter: once for a read, and on both
-- the old and the proposed row for a change. No policy is changed here, and no
-- `record_data` policy expression is touched.
--
-- D4/D7. The exact installed definition is the pinned Module release named by
-- `vortex_module.read_current_active_installation()`, and the declaration's
-- alternatives are every record-scoped permission of the action kind declared
-- for the exact record type by that pinned release set -- the Application
-- release for application-owned permissions, the record type's own Module
-- release for module-owned ones. That is the same set the permission registry
-- itself registers from those releases
-- (20260911090000_resolve_reachable_module_dependencies.sql:1192-1359), and the
-- shape #37's protected share path builds from the catalogue
-- (20260910114716_coordinate_protected_record_share.sql:358-384). The adapter
-- role holds no privilege on any Access table and is deliberately granted none,
-- so it names the alternatives from the definitions and lets the decision
-- resolve each one's current eligibility, current record scope and current
-- field policy from the live catalogue itself. A permission the catalogue no
-- longer carries is simply not eligible; a permission the catalogue carries but
-- the pinned definition does not is not named, and stays unusable until the
-- installation advances. Both directions fail closed.
--
-- The catalogue supplies physical tokens only. Every disagreement between the
-- pinned definition and the storage catalogue -- a missing or inactive
-- catalogue row, a different module, record type or storage scope, a field with
-- no active mapping, or a release with no provision evidence naming that
-- storage -- refuses with 55000 rather than reading a table the definition does
-- not describe.
--
-- D6. Facts are complete for the definitions: every record type, relationship
-- and saved condition of the whole installed pin set. Data is closed over the
-- target row, its inherited-ownership chain and the source rows of every
-- relationship route the named permissions reach, expanded transitively through
-- each route's own source permission. The closure is bounded by the
-- (record, permission) pairs it has already expanded. Anything the closure
-- cannot supply leaves the decision to raise `22023 Record access facts are
-- invalid`, which is the existing guard for incomplete facts and is exactly the
-- constraint an adapter for the protected share path must satisfy too
-- (20260910114716_coordinate_protected_record_share.sql:86-104).
--
-- Polymorphic relationships (`toRecordTypes`, from a `link_to_one_of_several`
-- field) are not represented: the facts contract carries one `toRecordTypeId`
-- per relationship identity, so one entry cannot describe several targets. They
-- are omitted from the facts, which makes a permission route or an ownership
-- chain over one refuse rather than silently resolve against the wrong target.
-- S2 owns edge writes and can revisit the shape then.
--
-- D5. The field-write bound is enforced here, next to the DML, from the
-- submitted field identifiers #47's fixed save writer supplies -- one
-- evaluation with no gap between check and write. The bound is the changeable
-- set of the old row's own update decision: the authority that currently
-- reaches this record is what decides which of its fields may change. Values
-- the caller did not submit -- a declared rule output or a derived value -- are
-- not bound-checked, because #47 classifies them and an adapter cannot tell
-- them apart from the final row alone.
--
-- D10. Values are canonical V2 JSON in and out. Decimals are exact canonical
-- text stored as `numeric` and read back through `numeric::text`; `date_time` is
-- stored as the instant and read back as UTC `Z`; money keeps its
-- `{amount, currency}` object with a canonical amount. A JSON `null` clears the
-- column, and a NULL column reads back as JSON `null`, so a value round-trips
-- through the same shape the saved-condition evaluator already accepts. A value
-- that fails its cast or its canonical form refuses the whole change.
--
-- D11. `read_record` refuses identically for a missing record, a record of
-- another organisation or application, and a record no held route reaches, so
-- it is no existence oracle. `change_record`'s caller is trusted, so it
-- distinguishes `conflict` and names a refusal reason.
--
-- D14/D15. System metadata is not projected here (#50) and the owner columns
-- are not writable here: initial ownership belongs to the create path (#402,
-- specification appendices/record-ownership-and-lifecycle.md) and later
-- ownership changes to the protected ownership action, never to an ordinary
-- field update. The operation keys are `record.read` and `record.update`.
--
-- Out of scope, and deliberately absent below: create, delete and restore,
-- reference numbers and relationship-edge writes (#402); activation (#43);
-- save, receipts, Activity and events (#47, #400). The relationship-edge scope
-- trigger is untouched and stays SECURITY INVOKER.

-- ============================================================================
-- The resolver's security mode, and the exact privileges the adapter owner
-- receives. Nothing here grants any Access-schema table to that role.
-- ============================================================================

-- #37's field-bounds resolver reads `permission_catalogue_entries` and
-- `permission_registrations` (20260910094534_resolve_record_field_bounds.sql).
-- Its callers were postgres-owned definers, so invoker rights sufficed. The
-- adapters below are owned by `vortex_record_adapter`, which holds no privilege
-- on those tables, so the resolver becomes definer-rights under its existing
-- owner. Its body, signature, volatility, empty search path and owner are
-- unchanged; ALTER FUNCTION changes the security mode and nothing else. One
-- role gains execution.
alter function vortex_access.resolve_record_field_bounds_internal(jsonb)
  security definer;
grant execute on function vortex_access.resolve_record_field_bounds_internal(jsonb)
  to vortex_record_adapter;

grant usage on schema vortex_access, vortex_definition to vortex_record_adapter;
grant execute on function vortex_access.validated_human_request_context()
  to vortex_record_adapter;
grant execute on function vortex_access.evaluate_organization_record_access_internal(
  jsonb, uuid, jsonb
) to vortex_record_adapter;

-- Published release content is the exact installed definition. The existing
-- Record and Module owners already read these rows the same way
-- (20260908122641_record_storage_provisioning.sql:415-423).
grant select on vortex_definition.releases to vortex_record_adapter;
create policy record_adapter_definition_releases_read on vortex_definition.releases
  for select to vortex_record_adapter using (true);

set local role vortex_module_owner;
grant usage on schema vortex_module to vortex_record_adapter;
grant execute on function vortex_module.read_current_active_installation()
  to vortex_record_adapter;
reset role;

set local role vortex_record_owner;
-- Catalogue reads: physical tokens, field mappings, relationship mappings and
-- provision evidence. Relationship edges are the only row data here, and the
-- adapter sees only its own organisation's.
grant select on vortex_record.storage_catalogue,
  vortex_record.field_storage_mappings,
  vortex_record.relationship_storage_mappings,
  vortex_record.release_provisions,
  vortex_record.relationship_edges to vortex_record_adapter;
create policy storage_catalogue_adapter_read on vortex_record.storage_catalogue
  for select to vortex_record_adapter using (true);
create policy field_storage_mappings_adapter_read on vortex_record.field_storage_mappings
  for select to vortex_record_adapter using (true);
create policy relationship_storage_mappings_adapter_read
  on vortex_record.relationship_storage_mappings
  for select to vortex_record_adapter using (true);
create policy release_provisions_adapter_read on vortex_record.release_provisions
  for select to vortex_record_adapter using (true);
create policy relationship_edges_adapter_read on vortex_record.relationship_edges
  for select to vortex_record_adapter
  using (from_organisation_id = vortex_context.organization_id());

-- The request role reaches the read adapter by name and nothing else in this
-- schema: usage on the schema, no privilege on any table in it.
grant usage on schema vortex_record to vortex_request;

-- The adapter owner may create the objects below, and loses that right again at
-- the end of this migration.
grant create on schema vortex_record to vortex_record_adapter;
reset role;

-- A newly owning role needs its own default-privilege revocation as well as the
-- explicit grants below; the postgres baseline does not apply to it
-- (supabase/README.md#platform-migrations-and-generated-business-storage).
set local role vortex_record_adapter;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;

-- ============================================================================
-- Canonical V2 value shapes, for the change path only.
--
-- A pure, immutable, boolean-returning shape check that never raises, in the
-- same style as the existing `vortex_access.permission_field_policy_is_valid`
-- (20260907223932_preserve_permission_field_policy.sql:21-95) and
-- `permission_record_scope_is_valid`
-- (20260911101613_constrain_permission_record_scope_shape.sql:33-191). It is
-- not a second field engine: it checks only that a value is the canonical V2
-- shape for its declared field type, which is what makes the cast below safe
-- and what stops a non-canonical decimal from being stored as if it were
-- canonical. Requiredness, bounds, options, references and rule output stay
-- with the owning engines (#44, #47).
-- ============================================================================
create function vortex_record.canonical_record_value_matches(
  p_value jsonb,
  p_field_type text,
  p_database_value_type text
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  -- Canonical exact decimal text: no exponent, no leading zero, no trailing
  -- fractional zero, and no negative zero -- exactly what
  -- `normalizeExactDecimal` emits (contracts/src/exact-decimal.ts:49-72).
  canonical_decimal constant text :=
    '^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?|-(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))$';
  value_text text;
begin
  if p_value is null then
    return false;
  end if;
  -- A JSON null clears the column, whatever the declared type.
  if pg_catalog.jsonb_typeof(p_value) = 'null' then
    return true;
  end if;

  if p_field_type = 'money' then
    return pg_catalog.jsonb_typeof(p_value) = 'object'
      and p_value - array['amount', 'currency']::text[] = '{}'::jsonb
      and p_value ?& array['amount', 'currency']
      and pg_catalog.jsonb_typeof(p_value -> 'amount') = 'string'
      and (p_value ->> 'amount') ~ canonical_decimal
      and pg_catalog.jsonb_typeof(p_value -> 'currency') = 'string'
      and (p_value ->> 'currency') ~ '^[A-Z]{3}$';
  elsif p_field_type = 'link_to_person' then
    return pg_catalog.jsonb_typeof(p_value) = 'object'
      and p_value - array['organizationAccountId']::text[] = '{}'::jsonb
      and p_value ? 'organizationAccountId'
      and pg_catalog.jsonb_typeof(p_value -> 'organizationAccountId') = 'string'
      and vortex_context.is_non_nil_uuid(p_value ->> 'organizationAccountId');
  elsif p_field_type = 'several_choices' then
    return pg_catalog.jsonb_typeof(p_value) = 'array'
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_value) as member(value)
        where pg_catalog.jsonb_typeof(member.value) is distinct from 'string'
      );
  elsif p_field_type = 'attachment' then
    return pg_catalog.jsonb_typeof(p_value) = 'array'
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_value) as member(value)
        where pg_catalog.jsonb_typeof(member.value) is distinct from 'string'
          or not vortex_context.is_non_nil_uuid(member.value #>> '{}')
      );
  elsif p_field_type = 'table' then
    return pg_catalog.jsonb_typeof(p_value) = 'array';
  elsif p_field_type = 'formatted_text' then
    return pg_catalog.jsonb_typeof(p_value) = 'object'
      and pg_catalog.jsonb_typeof(p_value -> 'blocks') = 'array';
  end if;

  -- Every remaining field type is decided by its storage type.
  if p_database_value_type = 'decimal' then
    return pg_catalog.jsonb_typeof(p_value) = 'string'
      and (p_value #>> '{}') ~ canonical_decimal;
  elsif p_database_value_type = 'integer' then
    if pg_catalog.jsonb_typeof(p_value) is distinct from 'number' then
      return false;
    end if;
    value_text := p_value #>> '{}';
    return value_text ~ '^-?(?:0|[1-9][0-9]*)$'
      and value_text::numeric between -9223372036854775808 and 9223372036854775807;
  elsif p_database_value_type = 'boolean' then
    return pg_catalog.jsonb_typeof(p_value) = 'boolean';
  elsif p_database_value_type = 'date' then
    return pg_catalog.jsonb_typeof(p_value) = 'string'
      and vortex_access.typed_condition_temporal_value_internal(
        p_value #>> '{}', 'date'
      ) is not null;
  elsif p_database_value_type = 'timestamp_with_time_zone' then
    -- The instant is stored; the offset it arrived with is not preserved, and
    -- the read codec returns UTC `Z`.
    return pg_catalog.jsonb_typeof(p_value) = 'string'
      and vortex_access.typed_condition_temporal_value_internal(
        p_value #>> '{}', 'date_time'
      ) is not null;
  elsif p_database_value_type = 'text' then
    return pg_catalog.jsonb_typeof(p_value) = 'string';
  elsif p_database_value_type = 'json' then
    return true;
  end if;
  return false;
end
$function$;

-- ============================================================================
-- The private facts loader.
--
-- It resolves the request context, the active installation, the pinned
-- definitions, the physical tokens and the complete fact closure, and returns
-- one envelope. Both adapters use it, so there is one resolution path and one
-- place where completeness is decided. It is invoker-rights: it runs with the
-- privileges of the adapter that calls it, so a mistaken grant could not turn
-- it into a readable projection of another role's rows.
--
-- `p_expected_concurrency_number` is supplied only by the change path. When it
-- is non-null the target row is locked before anything else is read, and a
-- stale number returns immediately, so every fact the change decision sees was
-- read under that lock.
-- ============================================================================
create function vortex_record.load_record_access_facts_internal(
  p_record_type_id uuid,
  p_action_kind text,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  installation jsonb;
  binding_item jsonb;
  release_content jsonb;
  release_revision_value bigint;
  record_type_item jsonb;
  field_item jsonb;
  relationship_item jsonb;
  condition_item jsonb;
  permission_item jsonb;
  module_root_value uuid;
  record_type_id_value uuid;
  storage_contract_value uuid;
  type_meta jsonb := '{}'::jsonb;
  relationship_by_id jsonb := '{}'::jsonb;
  condition_list jsonb := '[]'::jsonb;
  permission_by_id jsonb := '{}'::jsonb;
  required_permissions jsonb;
  declaration jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  columns_value jsonb;
  value_expression text;
  target_meta jsonb;
  target_table text;
  target_scope text;
  target_module_root_id uuid;
  target_release_revision bigint;
  records_by_id jsonb := '{}'::jsonb;
  candidate_edges jsonb := '[]'::jsonb;
  load_contracts uuid[] := array[]::uuid[];
  load_records uuid[] := array[]::uuid[];
  pair_records uuid[] := array[]::uuid[];
  pair_permissions uuid[] := array[]::uuid[];
  seen_pairs text[] := array[]::text[];
  pair_identity text;
  current_contract uuid;
  current_record uuid;
  current_permission uuid;
  current_meta jsonb;
  current_scope jsonb;
  route_item jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  load_sql text;
  record_fact jsonb;
  target_concurrency_number bigint;
  target_definition_revision bigint;
  facts jsonb;
begin
  if not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_context.is_non_nil_uuid(p_record_id::text)
    or p_action_kind not in ('read', 'update')
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740991) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  -- Step 1: the verified request context. The adapter never reads
  -- `current_user`, which is its own owner inside a definer function.
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  -- Step 2: the exact active installation. Its reader owns the pin-set and
  -- active-binding rules; this adapter consumes them and adds none.
  installation := vortex_module.read_current_active_installation();

  -- Step 3: the pinned definitions. Record types, relationships and saved
  -- conditions of every bound Module, plus the declared permissions of the
  -- Application release and of each Module release. Physical tokens are
  -- resolved here too, and every disagreement refuses.
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  loop
    module_root_value := (binding_item ->> 'moduleRootId')::uuid;
    release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;

    select release.compilation_output #> '{canonical,content}'
    into strict release_content
    from vortex_definition.releases as release
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
      storage_contract_value := (record_type_item ->> 'storageContractId')::uuid;

      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = storage_contract_value;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> module_root_value
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token <> 'record_data'
        or not exists (
          select 1
          from vortex_record.release_provisions as provision
          where provision.module_root_id = module_root_value
            and provision.release_revision = release_revision_value
            and storage_contract_value = any (provision.storage_contract_ids)
        ) then
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
        pg_catalog.format(
          '%L, %s',
          column_entry.key,
          case column_entry.value ->> 'databaseValueType'
            when 'decimal' then
              pg_catalog.format('pg_catalog.to_jsonb(%I::text)', column_entry.value ->> 'token')
            when 'timestamp_with_time_zone' then
              pg_catalog.format(
                'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', %I), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))',
                column_entry.value ->> 'token'
              )
            when 'date' then
              pg_catalog.format(
                'pg_catalog.to_jsonb(pg_catalog.to_char(%I, ''YYYY-MM-DD''))',
                column_entry.value ->> 'token'
              )
            else pg_catalog.format('pg_catalog.to_jsonb(%I)', column_entry.value ->> 'token')
          end
        ),
        ', ' order by column_entry.key collate "C"
      )
      into value_expression
      from pg_catalog.jsonb_each(columns_value) as column_entry(key, value);

      type_meta := type_meta || pg_catalog.jsonb_build_object(
        pg_catalog.lower(record_type_id_value::text),
        pg_catalog.jsonb_build_object(
          'moduleRootId', module_root_value,
          'recordTypeId', record_type_id_value,
          'storageContractId', storage_contract_value,
          'storageScope', record_type_item ->> 'storageScope',
          'ownershipMode', record_type_item ->> 'ownershipMode',
          'releaseRevision', release_revision_value,
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
        -- One declared target only; see the header on polymorphic targets.
        if relationship_item ? 'toRecordType' then
          relationship_by_id := relationship_by_id || pg_catalog.jsonb_build_object(
            pg_catalog.lower(relationship_item ->> 'relationshipId'),
            pg_catalog.jsonb_build_object(
              'relationshipId', relationship_item -> 'relationshipId',
              'fromModuleRootId', module_root_value,
              'fromRecordTypeId', record_type_item -> 'recordTypeId',
              'toModuleRootId', relationship_item #> '{toRecordType,moduleRootId}',
              'toRecordTypeId', relationship_item #> '{toRecordType,recordTypeId}'
            )
          );
        end if;
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
  from vortex_definition.releases as release
  where release.root_id = context_application_root_id
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;

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
          'ownerId', context_application_root_id,
          'recordTypeId', permission_item -> 'recordTypeId',
          'actionKind', permission_item -> 'actionKind',
          'namedAction', permission_item -> 'namedAction',
          'recordScope', permission_item -> 'recordScope'
        )
      );
    end if;
  end loop;

  target_meta := type_meta -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  target_table := target_meta ->> 'table';
  target_scope := target_meta ->> 'storageScope';
  target_module_root_id := (target_meta ->> 'moduleRootId')::uuid;
  target_release_revision := (target_meta ->> 'releaseRevision')::bigint;

  -- Step 4: the declaration. Every record-scoped permission of this action
  -- kind declared for this exact record type, owned by the context Application
  -- or by the record type's own Module, in the canonical order the eligibility
  -- core requires.
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'applicationRootId', context_application_root_id,
      'ownerKind', declared.value ->> 'ownerKind',
      'ownerId', (declared.value ->> 'ownerId')::uuid,
      'permissionId', declared.key::uuid
    )
    order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
  )
  into required_permissions
  from pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
  where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and declared.value ->> 'actionKind' = p_action_kind
    and declared.value -> 'namedAction' is null
    and (
      (declared.value ->> 'ownerKind') = 'application'
      or (declared.value ->> 'ownerId')::uuid = target_module_root_id
    );

  declaration := case
    when required_permissions is null then null
    else pg_catalog.jsonb_build_object(
      'operationKey', 'record.' || p_action_kind,
      'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
      'target', pg_catalog.jsonb_build_object(
        'kind', 'application', 'applicationRootId', context_application_root_id
      ),
      'requiredPermissions', required_permissions,
      'recordBinding', pg_catalog.jsonb_build_object(
        'moduleRootId', target_module_root_id,
        'recordTypeId', p_record_type_id,
        'storageContractId', (target_meta ->> 'storageContractId')::uuid,
        'storageScope', target_scope
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  end;

  -- Step 5: the target row. The change path locks it here, before any other
  -- row is read, and refuses a stale number without doing the closure work.
  -- Organisation and application isolation is the scope policy's, which is what
  -- makes a foreign row indistinguishable from a missing one.
  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_build_object(
       ''recordScope'', pg_catalog.jsonb_build_object(
         ''storageScope'', %L,
         ''organizationId'', stored.organisation_id,
         ''moduleRootId'', %L::uuid,
         ''recordTypeId'', %L::uuid,
         ''storageContractId'', %L::uuid,
         ''recordId'', stored.record_id
       ) || case when %L = ''application_contained''
         then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
         else ''{}''::jsonb end,
       ''lifecycleState'', stored.lifecycle_state,
       ''fieldValues'', pg_catalog.jsonb_build_object(%s)
     ) || case
       when stored.owner_organisation_account_id is not null
         then pg_catalog.jsonb_build_object(
           ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
       when stored.owner_group_id is not null
         then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
       else ''{}''::jsonb end,
     stored.concurrency_number, stored.definition_revision
     from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2%s',
    target_scope, target_module_root_id, p_record_type_id,
    (target_meta ->> 'storageContractId')::uuid, target_scope,
    target_meta ->> 'valueExpression', target_table,
    case when p_expected_concurrency_number is null then '' else ' for update' end
  );

  execute load_sql
  into record_fact, target_concurrency_number, target_definition_revision
  using context_organization_id, p_record_id;

  if record_fact is null then
    return pg_catalog.jsonb_build_object('outcome', 'missing');
  end if;

  if p_expected_concurrency_number is not null
    and target_concurrency_number <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', target_concurrency_number
    );
  end if;

  records_by_id := pg_catalog.jsonb_build_object(
    pg_catalog.lower(p_record_id::text), record_fact
  );

  -- Step 6: the fact closure. Two queues drain into one loop: rows still to
  -- load, and (record, permission) pairs still to expand. A pair is expanded at
  -- most once, which bounds the walk; an inherited-ownership chain is expanded
  -- by pushing the parent under the same permission, so the chase and the
  -- relationship routes use the same mechanism.
  if declaration is not null then
    for route_item in
      select item.value from pg_catalog.jsonb_array_elements(required_permissions) as item(value)
    loop
      pair_records := pg_catalog.array_append(pair_records, p_record_id);
      pair_permissions := pg_catalog.array_append(
        pair_permissions, (route_item ->> 'permissionId')::uuid
      );
    end loop;
  end if;

  while coalesce(pg_catalog.array_length(load_records, 1), 0) > 0
    or coalesce(pg_catalog.array_length(pair_records, 1), 0) > 0
  loop
    if coalesce(pg_catalog.array_length(load_records, 1), 0) > 0 then
      current_contract := load_contracts[pg_catalog.array_length(load_contracts, 1)];
      current_record := load_records[pg_catalog.array_length(load_records, 1)];
      load_contracts := load_contracts[1:pg_catalog.array_length(load_contracts, 1) - 1];
      load_records := load_records[1:pg_catalog.array_length(load_records, 1) - 1];

      if records_by_id ? pg_catalog.lower(current_record::text) then
        continue;
      end if;

      select meta.value into current_meta
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
      where (meta.value ->> 'storageContractId')::uuid = current_contract
      limit 1;
      if current_meta is null then
        continue;
      end if;

      load_sql := pg_catalog.format(
        'select pg_catalog.jsonb_build_object(
           ''recordScope'', pg_catalog.jsonb_build_object(
             ''storageScope'', %L,
             ''organizationId'', stored.organisation_id,
             ''moduleRootId'', %L::uuid,
             ''recordTypeId'', %L::uuid,
             ''storageContractId'', %L::uuid,
             ''recordId'', stored.record_id
           ) || case when %L = ''application_contained''
             then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
             else ''{}''::jsonb end,
           ''lifecycleState'', stored.lifecycle_state,
           ''fieldValues'', pg_catalog.jsonb_build_object(%s)
         ) || case
           when stored.owner_organisation_account_id is not null
             then pg_catalog.jsonb_build_object(
               ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
           when stored.owner_group_id is not null
             then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
           else ''{}''::jsonb end
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2',
        current_meta ->> 'storageScope', (current_meta ->> 'moduleRootId')::uuid,
        (current_meta ->> 'recordTypeId')::uuid, current_contract,
        current_meta ->> 'storageScope', current_meta ->> 'valueExpression',
        current_meta ->> 'table'
      );

      execute load_sql into record_fact using context_organization_id, current_record;
      if record_fact is not null then
        records_by_id := records_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(current_record::text), record_fact
        );
      end if;
      continue;
    end if;

    current_record := pair_records[pg_catalog.array_length(pair_records, 1)];
    current_permission := pair_permissions[pg_catalog.array_length(pair_permissions, 1)];
    pair_records := pair_records[1:pg_catalog.array_length(pair_records, 1) - 1];
    pair_permissions := pair_permissions[1:pg_catalog.array_length(pair_permissions, 1) - 1];

    pair_identity := pg_catalog.lower(current_record::text) || ':'
      || pg_catalog.lower(current_permission::text);
    if pair_identity = any (seen_pairs) then
      continue;
    end if;
    seen_pairs := pg_catalog.array_append(seen_pairs, pair_identity);

    record_fact := records_by_id -> pg_catalog.lower(current_record::text);
    if record_fact is null then
      continue;
    end if;
    current_meta := type_meta -> pg_catalog.lower(
      record_fact -> 'recordScope' ->> 'recordTypeId'
    );
    current_scope := permission_by_id -> pg_catalog.lower(current_permission::text)
      -> 'recordScope';
    if current_meta is null or current_scope is null then
      continue;
    end if;

    -- Inherited ownership: push the declared parent under the same permission,
    -- which repeats for the grandparent when that pair is expanded.
    if current_meta ->> 'ownershipMode' = 'inherited'
      and current_meta ? 'ownershipRelationshipId'
      and exists (
        select 1 from pg_catalog.jsonb_array_elements(current_scope -> 'routes') as route(value)
        where route.value ->> 'kind' = 'ownership'
      ) then
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (current_meta ->> 'ownershipRelationshipId')::uuid
          and edge.from_storage_contract_id = (current_meta ->> 'storageContractId')::uuid
          and edge.from_record_id = current_record
      loop
        load_contracts := pg_catalog.array_append(load_contracts, edge_row.to_storage_contract_id);
        load_records := pg_catalog.array_append(load_records, edge_row.to_record_id);
        pair_records := pg_catalog.array_append(pair_records, edge_row.to_record_id);
        pair_permissions := pg_catalog.array_append(pair_permissions, current_permission);
        candidate_edges := candidate_edges || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', edge_row.relationship_id,
            'fromRecordId', edge_row.from_record_id,
            'toRecordId', edge_row.to_record_id
          )
        );
      end loop;
    end if;

    -- Relationship routes: the target is always the `to` endpoint, so the
    -- sources this permission can reach it through are the `from` rows of that
    -- relationship's edges, each expanded under its own source permission.
    for route_item in
      select route.value
      from pg_catalog.jsonb_array_elements(current_scope -> 'routes') as route(value)
      where route.value ->> 'kind' = 'relationship'
    loop
      if not (relationship_by_id ? pg_catalog.lower(route_item ->> 'relationshipId')) then
        continue;
      end if;
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (route_item ->> 'relationshipId')::uuid
          and edge.to_storage_contract_id = (current_meta ->> 'storageContractId')::uuid
          and edge.to_record_id = current_record
      loop
        load_contracts := pg_catalog.array_append(
          load_contracts, edge_row.from_storage_contract_id
        );
        load_records := pg_catalog.array_append(load_records, edge_row.from_record_id);
        pair_records := pg_catalog.array_append(pair_records, edge_row.from_record_id);
        pair_permissions := pg_catalog.array_append(
          pair_permissions, (route_item ->> 'sourcePermissionId')::uuid
        );
        candidate_edges := candidate_edges || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', edge_row.relationship_id,
            'fromRecordId', edge_row.from_record_id,
            'toRecordId', edge_row.to_record_id
          )
        );
      end loop;
    end loop;
  end loop;

  -- Step 7: the facts. Every record type, relationship and saved condition of
  -- the installed definitions; the records the closure reached; and exactly the
  -- edges whose endpoints are both present, deduplicated.
  facts := pg_catalog.jsonb_build_object(
    'binding', declaration -> 'recordBinding',
    'recordTypes', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'moduleRootId', meta.value -> 'moduleRootId',
          'recordTypeId', meta.value -> 'recordTypeId',
          'storageContractId', meta.value -> 'storageContractId',
          'storageScope', meta.value -> 'storageScope',
          'ownershipMode', meta.value -> 'ownershipMode',
          'fields', meta.value -> 'fields'
        ) || case
          when meta.value ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', meta.value -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
        order by meta.key collate "C"
      )
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
    ), '[]'::jsonb),
    'relationships', coalesce((
      select pg_catalog.jsonb_agg(declared.value order by declared.key collate "C")
      from pg_catalog.jsonb_each(relationship_by_id) as declared(key, value)
    ), '[]'::jsonb),
    'sharingConditions', condition_list,
    'records', coalesce((
      select pg_catalog.jsonb_agg(stored.value order by stored.key collate "C")
      from pg_catalog.jsonb_each(records_by_id) as stored(key, value)
    ), '[]'::jsonb),
    'edges', coalesce((
      select pg_catalog.jsonb_agg(distinct edge.value)
      from pg_catalog.jsonb_array_elements(candidate_edges) as edge(value)
      where records_by_id ? pg_catalog.lower(edge.value ->> 'fromRecordId')
        and records_by_id ? pg_catalog.lower(edge.value ->> 'toRecordId')
    ), '[]'::jsonb)
  );

  return pg_catalog.jsonb_build_object(
    'outcome', 'loaded',
    'context', context_value,
    'declaration', declaration,
    'facts', facts,
    'table', target_table,
    'columns', target_meta -> 'columns',
    'concurrencyNumber', target_concurrency_number,
    'definitionRevision', target_definition_revision,
    'moduleReleaseRevision', target_release_revision,
    'fieldValues', record_fact -> 'fieldValues'
  );
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

-- ============================================================================
-- read_record: the readable projection of one record, or an identical refusal.
-- ============================================================================
create function vortex_record.read_record(
  p_record_type_id uuid,
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  columns_value jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  if p_record_type_id is null or p_record_id is null
    or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_context.is_non_nil_uuid(p_record_id::text) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'read', p_record_id, null
  );
  -- A missing record, a foreign one and one this application publishes no read
  -- permission for are one refusal, so none of them is an existence oracle.
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  columns_value := loaded -> 'columns';

  -- Only fields of the exact installed definition are projected, and a
  -- withheld field is absent rather than blank.
  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, loaded -> 'fieldValues' -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', p_record_id,
    'concurrencyNumber', loaded -> 'concurrencyNumber',
    'values', values_value
  );
end
$function$;

-- ============================================================================
-- change_record: the whole-change update. Locks, refuses a stale number,
-- decides on the old and the proposed row, enforces the field bound next to the
-- write, and returns the readable projection of what it wrote.
-- ============================================================================
create function vortex_record.change_record(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_submitted_field_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  context_value jsonb;
  columns_value jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_values jsonb;
  proposed_facts jsonb;
  proposed_records jsonb;
  entry_key text;
  entry_value jsonb;
  column_entry jsonb;
  field_type text;
  storage_type text;
  submitted_id uuid;
  assignments text[] := array[]::text[];
  update_sql text;
  changed_rows integer;
  new_concurrency_number bigint;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  -- The next number must still fit the column's own range, so the highest
  -- accepted expected number is one below its maximum.
  if p_record_type_id is null or p_record_id is null
    or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_context.is_non_nil_uuid(p_record_id::text)
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_final_values is null
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  context_value := loaded -> 'context';
  columns_value := loaded -> 'columns';

  -- The old row's own update decision, and the changeable set it carries.
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);

  -- Every submitted field must be a field of the exact installed definition and
  -- inside that changeable set. The first one outside it refuses the whole
  -- change, before any value is cast and before any statement writes.
  foreach submitted_id in array p_submitted_field_ids loop
    if not (columns_value ? pg_catalog.lower(submitted_id::text)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  -- Every final value must name a field of that same definition: an unknown
  -- identifier and a system column are the same refusal, because neither is a
  -- field of this record type.
  proposed_values := loaded -> 'fieldValues';
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    column_entry := columns_value -> entry_key;
    if column_entry is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    field_type := column_entry ->> 'type';
    storage_type := column_entry ->> 'databaseValueType';

    -- Link fields carry relationship edges, and edge writes are S2's. Refusing
    -- with a fixed code keeps a link change from being silently dropped.
    if field_type in ('link', 'link_to_one_of_several') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'link_change_unsupported'
      );
    end if;

    if not vortex_record.canonical_record_value_matches(
      entry_value, field_type, storage_type
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'value_invalid'
      );
    end if;

    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
    assignments := pg_catalog.array_append(
      assignments,
      pg_catalog.format(
        '%I = %s',
        column_entry ->> 'token',
        case
          when pg_catalog.jsonb_typeof(entry_value) = 'null' then 'null'
          else case storage_type
            when 'decimal' then pg_catalog.format('%L::numeric', entry_value #>> '{}')
            when 'timestamp_with_time_zone' then
              pg_catalog.format('%L::timestamptz', entry_value #>> '{}')
            when 'date' then pg_catalog.format('%L::date', entry_value #>> '{}')
            when 'integer' then pg_catalog.format('%L::bigint', entry_value #>> '{}')
            when 'boolean' then pg_catalog.format('%L::boolean', entry_value #>> '{}')
            when 'json' then pg_catalog.format('%L::jsonb', entry_value::text)
            else pg_catalog.format('%L::text', entry_value #>> '{}')
          end
        end
      )
    );
  end loop;

  -- The proposed row's own update decision. Values that move the record out of
  -- every route the caller holds are refused here, after the old row admitted
  -- them and before anything is written.
  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  proposed_facts := (loaded -> 'facts')
    || pg_catalog.jsonb_build_object('records', proposed_records);

  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, proposed_facts
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'proposed_record_refused'
    );
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);

  -- The write: the typed columns, the next concurrency number, and the change
  -- stamp from the verified context and the installed binding. Owner columns
  -- and lifecycle state are not writable here.
  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %s%sconcurrency_number = stored.concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       definition_revision = $4
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $5
     returning stored.concurrency_number',
    loaded ->> 'table',
    pg_catalog.array_to_string(assignments, ', '),
    case when pg_catalog.cardinality(assignments) = 0 then '' else ', ' end
  );

  execute update_sql
  into new_concurrency_number
  using (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (loaded ->> 'moduleReleaseRevision')::bigint,
    p_expected_concurrency_number;

  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001',
      message = 'Record change did not apply to exactly one row';
  end if;

  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, proposed_values -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', p_record_id,
    'concurrencyNumber', new_concurrency_number,
    'values', values_value
  );
end
$function$;

reset role;

-- ============================================================================
-- Privileges on the three new objects, and the end of the adapter owner's
-- right to create more. `vortex_request` reaches exactly one of them.
-- ============================================================================
set local role vortex_record_adapter;
revoke all on function vortex_record.canonical_record_value_matches(jsonb, text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
revoke all on function vortex_record.load_record_access_facts_internal(
  uuid, text, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
revoke all on function vortex_record.read_record(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_module_owner;
-- change_record keeps no grant at all: its owner is the only role that may
-- execute it, which is what makes #47's fixed save writer the only way in.
revoke all on function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record(uuid, uuid) to vortex_request;

comment on function vortex_record.canonical_record_value_matches(jsonb, text, text) is
  'Private pure check that one value is the canonical V2 shape for its declared field type; never raises and decides no authority.';
comment on function vortex_record.load_record_access_facts_internal(
  uuid, text, uuid, bigint
) is
  'Private loader for the fixed record adapters: the verified context, the pinned installed definitions, the physical tokens, the declaration of one action kind and the complete fact closure for one record. Locks the target row when an expected concurrency number is supplied.';
comment on function vortex_record.read_record(uuid, uuid) is
  'Fixed record read adapter: returns the readable field projection of one record under the caller''s own current authority, or an identical refusal for a missing, foreign or unreachable record.';
comment on function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[]) is
  'Fixed record change adapter: locks the row, refuses a stale concurrency number, decides the update on the old and the proposed row, enforces the changeable-field bound over the submitted fields next to the write, and returns the readable projection. Owner-only; #47''s fixed save writer is its caller.';
reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
