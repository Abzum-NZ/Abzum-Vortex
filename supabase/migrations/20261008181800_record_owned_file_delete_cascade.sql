-- #2134: same-transaction, current HUMAN Record-owned File soft-delete cascade.
--
-- This delete-only partial preserves File bytes, metadata, references and legal
-- holds. The protected request receipt and identity-only lifecycle journal bind
-- every Record effect to a private digest; the File owner validates the complete
-- same-organisation attachment inventory, applies metadata-revision CAS, and
-- settles those effects before the terminal Record writer can append outcomes.
-- Restore, File-only detach, permanent purge and whole #683 acceptance remain open.

begin;

set local role vortex_record_adapter;
alter table vortex_record.record_lifecycle_command_effects
  add column file_cascade_proof_digest text,
  add column file_cascade_settled boolean not null default false,
  add constraint record_lifecycle_effect_file_cascade_digest_valid check (
    file_cascade_proof_digest is null
    or file_cascade_proof_digest ~ '^[0-9a-f]{64}$'
  ),
  add constraint record_lifecycle_effect_file_cascade_settled_valid check (
    not file_cascade_settled or file_cascade_proof_digest is not null
  );
comment on column vortex_record.record_lifecycle_command_effects.file_cascade_proof_digest is
  'Private SHA-256 identity proof for one Record-owned File delete effect; stores no File IDs or business values.';
comment on column vortex_record.record_lifecycle_command_effects.file_cascade_settled is
  'Private marker that the same-transaction File owner completed the exact File metadata CAS for this soft_deleted effect.';
reset role;

grant update (deleted_at, removal_due_at)
  on table vortex_file.file_records to vortex_file_owner;
grant usage on schema vortex_record to vortex_file_owner, vortex_record_inventory;

-- Provision the exact same-organisation inventory read on already-existing
-- companion tables. The owning Record role validates their prior adapter-only
-- ACL and single forced-RLS policy before adding one non-grantable SELECT.
set local role vortex_record_owner;
do $record_file_companion_inventory$
declare
  relation_row record;
  relation_oid oid;
  owner_role_oid oid := 'vortex_record_owner'::regrole::oid;
  adapter_role_oid oid := 'vortex_record_adapter'::regrole::oid;
  inventory_role_oid oid := 'vortex_record_inventory'::regrole::oid;
  token_value text;
  contract_id_value uuid;
  adapter_acl_count integer;
  adapter_acl_invalid_count integer;
  inventory_acl_count integer;
  inventory_acl_invalid_count integer;
  other_acl_count integer;
begin
  for relation_row in
    select relation.oid, relation.relname
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'record_data'
      and relation.relname ~ '^cp_[0-9a-f]{32}$'
    order by relation.relname collate "C", relation.oid
  loop
    relation_oid := relation_row.oid;
    token_value := pg_catalog.substr(relation_row.relname, 4);
    contract_id_value := (
      pg_catalog.substr(token_value, 1, 8) || '-' ||
      pg_catalog.substr(token_value, 9, 4) || '-' ||
      pg_catalog.substr(token_value, 13, 4) || '-' ||
      pg_catalog.substr(token_value, 17, 4) || '-' ||
      pg_catalog.substr(token_value, 21, 12)
    )::uuid;
    if not exists (
      select 1 from pg_catalog.pg_class as relation
      where relation.oid = relation_oid
        and relation.relkind = 'r'
        and relation.relpersistence = 'p'
        and not relation.relispartition
        and relation.relowner = owner_role_oid
        and relation.relrowsecurity
        and relation.relforcerowsecurity
    )
      or not exists (
        select 1 from vortex_record.storage_catalogue as catalogue
        join vortex_record.field_storage_mappings as mapping
          on mapping.storage_contract_id = catalogue.storage_contract_id
        where catalogue.storage_contract_id = contract_id_value
          and catalogue.physical_table_token = 'rt_' || token_value
          and mapping.introduced_by_module_root_id <> catalogue.module_root_id
          and mapping.state in ('active', 'retired')
      )
      or exists (
        select 1 from pg_catalog.pg_inherits as inheritance
        where inheritance.inhrelid = relation_oid
      )
      or exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_oid
          and attribute.attnum > 0
          and not attribute.attisdropped
          and attribute.attacl is not null
      ) then
      raise exception using errcode = '55000',
        message = 'Record File companion inventory lineage is incompatible';
    end if;
    select
      pg_catalog.count(*) filter (
        where privilege.grantee = adapter_role_oid
          and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE')
          and not privilege.is_grantable
      ),
      pg_catalog.count(*) filter (
        where privilege.grantee = adapter_role_oid
          and (privilege.privilege_type not in ('SELECT', 'INSERT', 'UPDATE')
            or privilege.is_grantable)
      ),
      pg_catalog.count(*) filter (
        where privilege.grantee = inventory_role_oid
      ),
      pg_catalog.count(*) filter (
        where privilege.grantee = inventory_role_oid
          and (privilege.privilege_type <> 'SELECT' or privilege.is_grantable)
      ),
      pg_catalog.count(*) filter (
        where privilege.grantee not in (owner_role_oid, adapter_role_oid, inventory_role_oid)
      )
    into adapter_acl_count, adapter_acl_invalid_count,
      inventory_acl_count, inventory_acl_invalid_count, other_acl_count
    from pg_catalog.pg_class as relation
    cross join lateral pg_catalog.aclexplode(coalesce(
      relation.relacl, pg_catalog.acldefault('r', relation.relowner)
    )) as privilege
    where relation.oid = relation_oid;
    if adapter_acl_count <> 3
      or adapter_acl_invalid_count <> 0
      or inventory_acl_count <> 0
      or inventory_acl_invalid_count <> 0
      or other_acl_count <> 0
      or (
        select pg_catalog.count(*) from pg_catalog.pg_policy as policy
        where policy.polrelid = relation_oid
      ) <> 1
      or not exists (
        select 1 from pg_catalog.pg_policy as policy
        where policy.polrelid = relation_oid
          and policy.polname = 'projection_companion_record_access'
          and policy.polpermissive
          and policy.polcmd = '*'
          and policy.polroles = array[adapter_role_oid]::oid[]
          and pg_catalog.regexp_replace(pg_catalog.lower(
            pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
          ), '\s+', '', 'g')
            = '(organisation_id=vortex_context.organization_id())'
          and pg_catalog.regexp_replace(pg_catalog.lower(
            pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
          ), '\s+', '', 'g')
            = '(organisation_id=vortex_context.organization_id())'
      ) then
      raise exception using errcode = '55000',
        message = 'Record File companion grants or policies are incompatible';
    end if;
    execute pg_catalog.format(
      'grant select on record_data.%I to vortex_record_inventory',
      relation_row.relname
    );
    execute pg_catalog.format(
      'create policy record_account_deletion_inventory on record_data.%I
         for select to vortex_record_inventory
         using (organisation_id = vortex_context.organization_id())',
      relation_row.relname
    );
  end loop;
end
$record_file_companion_inventory$;
reset role;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter, vortex_record_inventory;
reset role;

set local role vortex_record_adapter;
create or replace function vortex_record.soft_delete_record_recursive_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_visited text[]
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  read_meta jsonb;
  read_loaded jsonb;
  read_decision jsonb;
  read_bounds jsonb;
  update_meta jsonb;
  update_loaded jsonb;
  update_decision jsonb;
  update_bounds jsonb;
  facts jsonb;
  decision jsonb;
  context_value jsonb;
  record_fact jsonb;
  identity_value text;
  incoming record;
  source_catalogue vortex_record.storage_catalogue%rowtype;
  source_meta jsonb;
  source_loaded jsonb;
  source_decision jsonb;
  source_record_type jsonb;
  source_concurrency bigint;
  source_link_column text;
  source_link_value jsonb;
  source_identity text;
  source_action_kind text;
  changed_rows integer;
  application_scope uuid;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  preview_installation jsonb;
  notice_sequence bigint;
  attachment_field jsonb;
  attachment_value jsonb;
  attachment_fields jsonb := '[]'::jsonb;
  attachment_file_ids uuid[];
  attachment_file_id uuid;
  attachment_file_text text;
  has_attachments boolean := false;
  attachment_policy jsonb;
  proof_value jsonb;
  proof_digest text;
  effect_sequence integer;
  changed_effects integer;
begin
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'delete');
  context_value := meta -> 'context';
  identity_value := pg_catalog.lower((meta ->> 'storageContractId')) || ':'
    || pg_catalog.lower(p_record_id::text);
  if identity_value = any (p_visited) then
    raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
  end if;
  p_visited := pg_catalog.array_append(p_visited, identity_value);

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'delete', p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' = 'conflict' then
    raise exception using errcode = '40001', message = 'Record delete revision is stale';
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  if record_fact ->> 'lifecycleState' <> 'active' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'binding', meta -> 'declaration' -> 'recordBinding'
  );
  decision := vortex_access.evaluate_organization_record_access_internal(
    meta -> 'declaration', p_record_id, facts
  );
  if decision ->> 'outcome' <> 'allowed'
    or nullif(decision ->> 'validUntil', '')::timestamptz is null
    or nullif(decision ->> 'validUntil', '')::timestamptz
      <= pg_catalog.statement_timestamp() then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;

  -- Capture only the IDs needed by the File owner. The complete value and
  -- current action decisions remain in memory; only a server SHA-256 proof is
  -- attached to the private lifecycle effect after the Record CAS succeeds.
  for attachment_field in
    select declared.value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as declared(value)
    where declared.value ->> 'type' = 'attachment'
    order by pg_catalog.lower(declared.value ->> 'fieldId') collate "C"
  loop
    attachment_file_ids := array[]::uuid[];
    attachment_value := loaded -> 'fieldValues' -> pg_catalog.lower(
      attachment_field ->> 'fieldId'
    );
    if attachment_value is not null
      and pg_catalog.jsonb_typeof(attachment_value) <> 'null' then
      if pg_catalog.jsonb_typeof(attachment_value) <> 'array' then
        raise exception using errcode = '23514',
          message = 'Attachment ownership is invalid';
      end if;
      for attachment_file_text in
        select item.value
        from pg_catalog.jsonb_array_elements_text(attachment_value) as item(value)
      loop
        begin
          attachment_file_id := attachment_file_text::uuid;
        exception when invalid_text_representation then
          raise exception using errcode = '23514',
            message = 'Attachment ownership is invalid';
        end;
        if not vortex_context.is_non_nil_uuid(attachment_file_id::text)
          or attachment_file_id = any (attachment_file_ids) then
          raise exception using errcode = '23514',
            message = 'Attachment ownership is invalid';
        end if;
        attachment_file_ids := pg_catalog.array_append(
          attachment_file_ids, attachment_file_id
        );
      end loop;
    end if;
    select coalesce(pg_catalog.array_agg(item.file_id order by item.file_id), array[]::uuid[])
    into attachment_file_ids
    from pg_catalog.unnest(attachment_file_ids) as item(file_id);
    if pg_catalog.cardinality(attachment_file_ids) > 0 then
      has_attachments := true;
    end if;
    attachment_fields := attachment_fields || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'fieldId', pg_catalog.lower(attachment_field ->> 'fieldId'),
        'fileIds', pg_catalog.to_jsonb(attachment_file_ids)
      )
    );
  end loop;

  if has_attachments then
    read_meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
    update_meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'update');
    if read_meta ->> 'outcome' = 'refused'
      or update_meta ->> 'outcome' = 'refused'
      or read_meta ? 'previewInstallationId'
      or update_meta ? 'previewInstallationId'
      or (read_meta ->> 'storageContractId') is distinct from
        (meta ->> 'storageContractId')
      or (update_meta ->> 'storageContractId') is distinct from
        (meta ->> 'storageContractId')
      or (read_meta ->> 'moduleRootId') is distinct from (meta ->> 'moduleRootId')
      or (update_meta ->> 'moduleRootId') is distinct from (meta ->> 'moduleRootId')
      or (read_meta ->> 'moduleReleaseRevision') is distinct from
        (meta ->> 'moduleReleaseRevision')
      or (update_meta ->> 'moduleReleaseRevision') is distinct from
        (meta ->> 'moduleReleaseRevision')
      or (read_meta -> 'context' ->> 'organizationId') is distinct from
        (context_value ->> 'organizationId')
      or (update_meta -> 'context' ->> 'organizationId') is distinct from
        (context_value ->> 'organizationId')
      or (read_meta -> 'context' ->> 'applicationRootId') is distinct from
        (context_value ->> 'applicationRootId')
      or (update_meta -> 'context' ->> 'applicationRootId') is distinct from
        (context_value ->> 'applicationRootId') then
      raise exception using errcode = '42501',
        message = 'File attachment authority is unavailable';
    end if;
    read_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'read', p_record_id, p_expected_concurrency_number
    );
    update_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
    );
    if read_loaded ->> 'outcome' <> 'loaded'
      or update_loaded ->> 'outcome' <> 'loaded'
      or (read_loaded ->> 'concurrencyNumber')::bigint is distinct from
        p_expected_concurrency_number
      or (update_loaded ->> 'concurrencyNumber')::bigint is distinct from
        p_expected_concurrency_number
      or pg_catalog.jsonb_typeof(read_meta -> 'declaration') <> 'object'
      or pg_catalog.jsonb_typeof(update_meta -> 'declaration') <> 'object' then
      raise exception using errcode = '42501',
        message = 'File attachment authority is unavailable';
    end if;
    read_decision := vortex_access.evaluate_organization_record_access_internal(
      read_meta -> 'declaration', p_record_id,
      (read_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', read_meta -> 'declaration' -> 'recordBinding'
      )
    );
    update_decision := vortex_access.evaluate_organization_record_access_internal(
      update_meta -> 'declaration', p_record_id,
      (update_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', update_meta -> 'declaration' -> 'recordBinding'
      )
    );
    if read_decision ->> 'outcome' <> 'allowed'
      or update_decision ->> 'outcome' <> 'allowed'
      or nullif(read_decision ->> 'validUntil', '')::timestamptz is null
      or nullif(update_decision ->> 'validUntil', '')::timestamptz is null
      or nullif(read_decision ->> 'validUntil', '')::timestamptz
        <= pg_catalog.statement_timestamp()
      or nullif(update_decision ->> 'validUntil', '')::timestamptz
        <= pg_catalog.statement_timestamp() then
      raise exception using errcode = '42501',
        message = 'File attachment authority is unavailable';
    end if;
    read_bounds := vortex_access.resolve_record_field_bounds_internal(read_decision);
    update_bounds := vortex_access.resolve_record_field_bounds_internal(update_decision);
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(attachment_fields) as field_item(value)
      where pg_catalog.jsonb_array_length(field_item.value -> 'fileIds') > 0
        and (
          not exists (
            select 1
            from pg_catalog.jsonb_array_elements_text(read_bounds -> 'readableFieldIds') as allowed(value)
            where pg_catalog.lower(allowed.value) = field_item.value ->> 'fieldId'
          )
          or not exists (
            select 1
            from pg_catalog.jsonb_array_elements_text(update_bounds -> 'changeableFieldIds') as allowed(value)
            where pg_catalog.lower(allowed.value) = field_item.value ->> 'fieldId'
          )
        )
    ) then
      raise exception using errcode = '42501',
        message = 'File attachment authority is unavailable';
    end if;
    attachment_policy := vortex_record.lock_record_recovery_policy_internal(
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid,
      case when meta ->> 'storageScope' = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end
    );
    if attachment_policy ->> 'action' is distinct from 'delete'
      or pg_catalog.jsonb_typeof(attachment_policy -> 'recoveryWindowDays') <> 'number'
      or (attachment_policy ->> 'recoveryWindowDays') !~ '^[1-9][0-9]{0,8}$'
      or (attachment_policy ->> 'recoveryWindowDays')::bigint > 104249991 then
      raise exception using errcode = '23514',
        message = 'File recovery policy is unavailable';
    end if;
  end if;

  -- Incoming edges are canonicalised before any child lock.  Every affected
  -- child is then reloaded and locked by #401's fixed loader.
  for incoming in
    select edge.*, mapping.on_parent_delete, mapping.relationship_id,
      mapping.source_field_id
    from vortex_record.relationship_edges as edge
    join vortex_record.relationship_storage_mappings as mapping
      on mapping.relationship_id = edge.relationship_id
    where edge.to_organisation_id = (context_value ->> 'organizationId')::uuid
      and edge.to_storage_contract_id = (meta ->> 'storageContractId')::uuid
      and edge.to_record_id = p_record_id
    order by edge.from_storage_contract_id, edge.from_record_id, edge.relationship_id
  loop
    select catalogue.* into source_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = incoming.from_storage_contract_id;
    source_identity := pg_catalog.lower(incoming.from_storage_contract_id::text) || ':'
      || pg_catalog.lower(incoming.from_record_id::text);
    if source_identity = any (p_visited) then
      raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
    end if;

    -- A child retained by another Application cannot be silently modified
    -- under this Application's request context.  It is therefore a safe
    -- blocking relationship, not an authority bypass.
    source_action_kind := case
      when incoming.on_parent_delete = 'empty_optional' then 'update'
      when incoming.on_parent_delete = 'soft_delete_dependent' then 'delete'
      else 'read'
    end;
    begin
      source_meta := vortex_record.resolve_record_action_context_internal(
        source_catalogue.record_type_id, source_action_kind
      );
    exception when others then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end;

    select field_mapping.physical_column_token into strict source_link_column
    from vortex_record.field_storage_mappings as field_mapping
    where field_mapping.storage_contract_id = incoming.from_storage_contract_id
      and field_mapping.field_id = incoming.source_field_id
      and field_mapping.state = 'active'
      and field_mapping.introduced_at_release_revision <=
        (source_meta ->> 'moduleReleaseRevision')::bigint;

    execute pg_catalog.format(
      'select concurrency_number, %I from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active'' for update',
      source_link_column, source_meta ->> 'table'
    ) into source_concurrency, source_link_value using
      (context_value ->> 'organizationId')::uuid, incoming.from_record_id;
    if not found then
      continue;
    end if;
    -- The incoming-edge cursor may have been opened before a concurrent link
    -- change committed. The source row lock returns the current tuple, so
    -- re-check its exact field before applying parent-delete behaviour. This
    -- prevents a stale edge snapshot from clearing or revising the source a
    -- second time after that link was already removed or redirected.
    if pg_catalog.jsonb_typeof(source_link_value) <> 'object'
      or source_link_value ->> 'recordId' is distinct from p_record_id::text then
      continue;
    end if;
    source_loaded := vortex_record.load_record_access_facts_internal(
      source_catalogue.record_type_id, source_action_kind, incoming.from_record_id,
      source_concurrency
    );
    if source_loaded ->> 'outcome' <> 'loaded' then
      continue;
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(source_loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = incoming.from_record_id;
    if record_fact ->> 'lifecycleState' <> 'active' then
      continue;
    end if;
    if incoming.on_parent_delete = 'refuse' then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end if;
    if pg_catalog.jsonb_typeof(source_meta -> 'declaration') <> 'object' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;
    source_decision := vortex_access.evaluate_organization_record_access_internal(
      source_meta -> 'declaration', incoming.from_record_id,
      (source_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', source_meta -> 'declaration' -> 'recordBinding'
      )
    );
    if source_decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;

    if incoming.on_parent_delete = 'empty_optional' then
      perform vortex_record.write_relationship_value_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        incoming.relationship_id, 'null'::jsonb, true
      );
      perform vortex_record.append_record_lifecycle_effect_internal(
        'optional_cleared', incoming.from_storage_contract_id,
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, incoming.relationship_id
      );
    elsif incoming.on_parent_delete = 'soft_delete_dependent' then
      source_record_type := source_meta -> 'recordType';
      if source_record_type ->> 'ownershipMode' <> 'inherited'
        or not source_record_type ? 'ownershipRelationshipId'
        or (source_record_type ->> 'ownershipRelationshipId')::uuid <>
          incoming.relationship_id then
        raise exception using errcode = '23514', message = 'Dependent deletion is not declared';
      end if;
      perform vortex_record.soft_delete_record_recursive_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, p_visited
      );
    else
      raise exception using errcode = '23514', message = 'Parent deletion behavior is invalid';
    end if;
  end loop;

  execute pg_catalog.format(
    'update record_data.%I as stored
     set lifecycle_state = ''soft_deleted'',
       concurrency_number = concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       deleted_at = pg_catalog.statement_timestamp(), deleted_by = $3,
       removal_due_at = null, definition_revision = $4
     where organisation_id = $1 and record_id = $2
       and lifecycle_state = ''active'' and concurrency_number = $5
     returning stored.record_id, stored.concurrency_number',
    meta ->> 'table'
  ) into saved_record_id, saved_concurrency_number using
    (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (meta ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Record delete revision changed';
  end if;
  if saved_record_id is distinct from p_record_id
    or saved_concurrency_number is null
    or saved_concurrency_number not between 1 and 9007199254740991 then
    raise exception using errcode = '55000', message = 'Record delete saved identity is unavailable';
  end if;
  perform vortex_record.append_record_lifecycle_effect_internal(
    'soft_deleted', (meta ->> 'storageContractId')::uuid,
    p_record_type_id, p_record_id, p_expected_concurrency_number, null
  );
  proof_value := pg_catalog.jsonb_build_object(
    'version', 1,
    'commandId', pg_catalog.current_setting('vortex_record.lifecycle_command_id')::uuid,
    'organizationId', (context_value ->> 'organizationId')::uuid,
    'applicationRootId', (context_value ->> 'applicationRootId')::uuid,
    'actorOrganizationAccountId', (context_value ->> 'organizationAccountId')::uuid,
    'storageContractId', (meta ->> 'storageContractId')::uuid,
    'moduleRootId', (meta ->> 'moduleRootId')::uuid,
    'moduleReleaseRevision', (meta ->> 'moduleReleaseRevision')::bigint,
    'recordTypeId', p_record_type_id,
    'recordId', p_record_id,
    'preConcurrencyNumber', p_expected_concurrency_number,
    'postConcurrencyNumber', saved_concurrency_number,
    'attachmentFields', attachment_fields
  );
  proof_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(proof_value::text, 'UTF8')),
    'hex'
  );
  select effect.effect_sequence into strict effect_sequence
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = (context_value ->> 'organizationId')::uuid
    and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and effect.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and effect.command_id =
      pg_catalog.current_setting('vortex_record.lifecycle_command_id')::uuid
    and effect.effect_kind = 'soft_deleted'
    and effect.storage_contract_id = (meta ->> 'storageContractId')::uuid
    and effect.record_type_id = p_record_type_id
    and effect.record_id = p_record_id
    and effect.pre_concurrency_number = p_expected_concurrency_number
    and effect.post_concurrency_number = saved_concurrency_number;
  update vortex_record.record_lifecycle_command_effects as effect
  set file_cascade_proof_digest = proof_digest,
    file_cascade_settled = false
  where effect.organization_id = (context_value ->> 'organizationId')::uuid
    and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and effect.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and effect.command_id =
      pg_catalog.current_setting('vortex_record.lifecycle_command_id')::uuid
    and effect.effect_sequence = effect_sequence
    and effect.effect_kind = 'soft_deleted'
    and effect.file_cascade_proof_digest is null
    and not effect.file_cascade_settled;
  get diagnostics changed_effects = row_count;
  if changed_effects <> 1 then
    raise exception using errcode = '55000',
      message = 'Record File cascade proof could not be recorded';
  end if;
  application_scope := case when meta ->> 'storageScope' = 'application_contained'
    then (context_value ->> 'applicationRootId')::uuid else null end;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is null
    and meta ->> 'storageScope' = 'application_contained' then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_invalidation.publish_change_notice(
        (context_value ->> 'organizationId')::uuid,
        application_scope, p_record_type_id,
        saved_record_id, saved_concurrency_number, 'deleted',
        notice_sequence, notice_sequence,
        (context_value ->> 'correlationId')::uuid
      );
    exception when others then
      -- Invalidation is advisory; the protected delete remains transactional.
      null;
    end;
  else
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid, application_scope
    );
  end if;
end
$function$;

alter function vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[]) owner to vortex_record_adapter;

revoke all on function vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[]) is null;
create or replace function vortex_record.soft_delete_record_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  begin
    perform vortex_record.soft_delete_record_recursive_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number, array[]::text[]
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', p_record_id,
      'concurrencyNumber', p_expected_concurrency_number + 1
    );
  exception
    when serialization_failure or deadlock_detected then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    when no_data_found or too_many_rows or insufficient_privilege or check_violation
      or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end;
end
$function$;

alter function vortex_record.soft_delete_record_internal(uuid,uuid,bigint)
  owner to vortex_record_adapter;

revoke all on function vortex_record.soft_delete_record_internal(uuid,uuid,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
comment on function vortex_record.soft_delete_record_internal(uuid,uuid,bigint) is
  'Private revision-checked recoverable delete primitive with current Access and declared incoming relationship handling; it sets no recovery policy.';

create or replace function vortex_record.prepare_protected_record_delete(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_activity_id uuid,
  p_occurrence_id uuid
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
  correlation_value jsonb;
  fingerprint_value text;
  receipt_claim jsonb;
  root_snapshot jsonb;
  deletion_result jsonb;
  current_revision bigint;
begin
  if p_command_id is null or p_command_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_activity_id is null or p_activity_id = nil_uuid
    or p_occurrence_id is null or p_occurrence_id = nil_uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record delete requires an Application context';
  end if;
  correlation_value := context_value -> 'correlationId';
  fingerprint_value := vortex_record.record_lifecycle_command_fingerprint_internal(
    p_command_id, 'delete', p_record_type_id, p_record_id, p_expected_concurrency_number
  );

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_lifecycle', p_command_id, 'delete', fingerprint_value,
    p_record_type_id, p_record_id, '{}'::jsonb,
    pg_catalog.jsonb_build_object(
      'expectedConcurrencyNumber', p_expected_concurrency_number,
      'recoveryPolicyRevision', null,
      'activityId', p_activity_id,
      'occurrenceId', p_occurrence_id
    ), false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_value
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'deleted',
      'recordId', receipt_claim -> 'recordId',
      'concurrencyNumber', receipt_claim -> 'concurrencyNumber',
      'correlationId', correlation_value,
      'replayed', true
    );
  end if;

  -- The evaluator needs the root's last active values. They are captured
  -- before the traversal and only used if that traversal deletes exactly the
  -- revision they were read at.
  root_snapshot := vortex_record.relationship_total_record_snapshot_internal(
    vortex_record.relationship_total_catalogue_internal(),
    p_record_type_id, p_record_id, false
  );

  perform pg_catalog.set_config(
    'vortex_record.lifecycle_command_id', p_command_id::text, true
  );
  deletion_result := vortex_record.soft_delete_record_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  perform pg_catalog.set_config('vortex_record.lifecycle_command_id', '', true);

  if deletion_result ->> 'outcome' = 'conflict' then
    current_revision := vortex_record.record_lifecycle_current_revision_internal(
      p_record_type_id, p_record_id
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', correlation_value
    ) || case when current_revision is null then '{}'::jsonb
      else pg_catalog.jsonb_build_object('concurrencyNumber', current_revision) end;
  end if;
  if deletion_result ->> 'outcome' is distinct from 'completed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', coalesce(deletion_result ->> 'reasonCode', 'record_unavailable'),
      'correlationId', correlation_value
    );
  end if;
  if root_snapshot is null then
    raise exception using errcode = '55000',
      message = 'Protected record delete root is not installed';
  end if;
  if (root_snapshot ->> 'concurrencyNumber')::bigint
      is distinct from p_expected_concurrency_number then
    raise exception using errcode = '40001',
      message = 'Protected record delete root changed before deletion';
  end if;

  return vortex_record.prepare_record_lifecycle_totals_internal(
    'delete', p_record_type_id, p_record_id, p_command_id, root_snapshot
  );
end
$function$;

alter function vortex_record.prepare_protected_record_delete(uuid,uuid,uuid,bigint,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_protected_record_delete(
  uuid, uuid, uuid, bigint, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_protected_record_delete(
  uuid, uuid, uuid, bigint, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_protected_record_delete(
  uuid, uuid, uuid, bigint, uuid, uuid
) is
  'Protected delete preflight: receipt, recursive soft delete with private File-cascade proofs and the locked dependency-total closure of every affected parent.';

create or replace function vortex_record.read_record_owned_file_lifecycle_authority_internal(
  p_command_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.record_lifecycle_command_receipts%rowtype;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  deleted_identities text[];
  delete_meta jsonb;
  read_meta jsonb;
  update_meta jsonb;
  delete_loaded jsonb;
  read_loaded jsonb;
  update_loaded jsonb;
  facts jsonb;
  records_value jsonb;
  decision jsonb;
  read_decision jsonb;
  update_decision jsonb;
  read_bounds jsonb;
  update_bounds jsonb;
  record_fact jsonb;
  attachment_field jsonb;
  attachment_value jsonb;
  attachment_fields jsonb;
  attachment_file_ids uuid[];
  attachment_file_id uuid;
  attachment_file_text text;
  has_attachments boolean;
  attachment_policy jsonb;
  proof_value jsonb;
  proof_digest text;
  deleted_at_value timestamptz;
  effect_values jsonb := '[]'::jsonb;
  effect_count integer := 0;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record File cascade command is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record File cascade requires an Application context';
  end if;
  select stored.* into receipt
  from vortex_record.record_lifecycle_command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = p_command_id
  for update;
  if not found
    or receipt.state is distinct from 'pending'
    or receipt.operation is distinct from 'delete' then
    raise exception using errcode = '42501',
      message = 'Record File cascade receipt is unavailable';
  end if;

  select coalesce(pg_catalog.array_agg(
    pg_catalog.lower(effect.storage_contract_id::text) || ':' ||
      pg_catalog.lower(effect.record_id::text)
    order by effect.storage_contract_id, effect.record_id
  ), array[]::text[])
  into deleted_identities
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = receipt.organization_id
    and effect.application_root_id = receipt.application_root_id
    and effect.actor_organization_account_id = receipt.actor_organization_account_id
    and effect.command_id = receipt.command_id
    and effect.effect_kind = 'soft_deleted';

  for effect_row in
    select effect.*
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
      and effect.effect_kind = 'soft_deleted'
    order by effect.effect_sequence
    for update
  loop
    effect_count := effect_count + 1;
    if effect_row.file_cascade_settled
      or effect_row.file_cascade_proof_digest is null
      or effect_row.file_cascade_proof_digest !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '55000',
        message = 'Record File cascade proof is unavailable';
    end if;

    delete_meta := vortex_record.resolve_record_action_context_internal(
      effect_row.record_type_id, 'delete'
    );
    if delete_meta ? 'previewInstallationId'
      or pg_catalog.jsonb_typeof(delete_meta -> 'declaration') is distinct from 'object'
      or (delete_meta ->> 'storageContractId') is distinct from
        effect_row.storage_contract_id::text then
      raise exception using errcode = '42501',
        message = 'Record File cascade source is unavailable';
    end if;
    delete_loaded := vortex_record.load_record_access_facts_internal(
      effect_row.record_type_id, 'delete', effect_row.record_id,
      effect_row.post_concurrency_number
    );
    if delete_loaded ->> 'outcome' is distinct from 'loaded'
      or (delete_loaded ->> 'concurrencyNumber')::bigint is distinct from
        effect_row.post_concurrency_number
      or (delete_loaded ->> 'definitionRevision')::bigint is distinct from
        (delete_meta ->> 'moduleReleaseRevision')::bigint then
      raise exception using errcode = '40001',
        message = 'Record File cascade revision is stale';
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(delete_loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'storageContractId')::uuid =
        effect_row.storage_contract_id
      and (item.value -> 'recordScope' ->> 'recordId')::uuid = effect_row.record_id;
    if record_fact ->> 'lifecycleState' is distinct from 'soft_deleted' then
      raise exception using errcode = '40001',
        message = 'Record File cascade owner is stale';
    end if;

    -- Rebuild the pre-delete lifecycle state from this command's identity-only
    -- effect journal. All other loaded values remain the current locked tuple.
    facts := delete_loaded -> 'facts';
    select coalesce(pg_catalog.jsonb_agg(
      case when (
        pg_catalog.lower(item.value -> 'recordScope' ->> 'storageContractId') || ':' ||
        pg_catalog.lower(item.value -> 'recordScope' ->> 'recordId')
      ) = any (deleted_identities)
        then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active')
        else item.value end
      order by item.ordinality
    ), '[]'::jsonb)
    into records_value
    from pg_catalog.jsonb_array_elements(facts -> 'records')
      with ordinality as item(value, ordinality);
    facts := facts || pg_catalog.jsonb_build_object('records', records_value);
    decision := vortex_access.evaluate_organization_record_access_internal(
      delete_meta -> 'declaration', effect_row.record_id,
      facts || pg_catalog.jsonb_build_object(
        'binding', delete_meta -> 'declaration' -> 'recordBinding'
      )
    );
    if decision ->> 'outcome' is distinct from 'allowed'
      or nullif(decision ->> 'validUntil', '')::timestamptz is null
      or nullif(decision ->> 'validUntil', '')::timestamptz
        <= pg_catalog.statement_timestamp() then
      raise exception using errcode = '42501',
        message = 'Record File cascade authority is unavailable';
    end if;

    attachment_fields := '[]'::jsonb;
    has_attachments := false;
    for attachment_field in
      select declared.value
      from pg_catalog.jsonb_array_elements(delete_meta -> 'recordType' -> 'fields') as declared(value)
      where declared.value ->> 'type' = 'attachment'
      order by pg_catalog.lower(declared.value ->> 'fieldId') collate "C"
    loop
      attachment_file_ids := array[]::uuid[];
      attachment_value := delete_loaded -> 'fieldValues' -> pg_catalog.lower(
        attachment_field ->> 'fieldId'
      );
      if attachment_value is not null
        and pg_catalog.jsonb_typeof(attachment_value) <> 'null' then
        if pg_catalog.jsonb_typeof(attachment_value) <> 'array' then
          raise exception using errcode = '23514',
            message = 'Attachment ownership is invalid';
        end if;
        for attachment_file_text in
          select item.value
          from pg_catalog.jsonb_array_elements_text(attachment_value) as item(value)
        loop
          begin
            attachment_file_id := attachment_file_text::uuid;
          exception when invalid_text_representation then
            raise exception using errcode = '23514',
              message = 'Attachment ownership is invalid';
          end;
          if not vortex_context.is_non_nil_uuid(attachment_file_id::text)
            or attachment_file_id = any (attachment_file_ids) then
            raise exception using errcode = '23514',
              message = 'Attachment ownership is invalid';
          end if;
          attachment_file_ids := pg_catalog.array_append(
            attachment_file_ids, attachment_file_id
          );
        end loop;
      end if;
      select coalesce(pg_catalog.array_agg(item.file_id order by item.file_id), array[]::uuid[])
      into attachment_file_ids
      from pg_catalog.unnest(attachment_file_ids) as item(file_id);
      if pg_catalog.cardinality(attachment_file_ids) > 0 then
        has_attachments := true;
      end if;
      attachment_fields := attachment_fields || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'fieldId', pg_catalog.lower(attachment_field ->> 'fieldId'),
          'fileIds', pg_catalog.to_jsonb(attachment_file_ids)
        )
      );
    end loop;

    if has_attachments then
      read_meta := vortex_record.resolve_record_action_context_internal(
        effect_row.record_type_id, 'read'
      );
      update_meta := vortex_record.resolve_record_action_context_internal(
        effect_row.record_type_id, 'update'
      );
      if read_meta ? 'previewInstallationId'
        or update_meta ? 'previewInstallationId'
        or pg_catalog.jsonb_typeof(read_meta -> 'declaration') is distinct from 'object'
        or pg_catalog.jsonb_typeof(update_meta -> 'declaration') is distinct from 'object'
        or (read_meta ->> 'storageContractId') is distinct from
          (delete_meta ->> 'storageContractId')
        or (update_meta ->> 'storageContractId') is distinct from
          (delete_meta ->> 'storageContractId')
        or (read_meta ->> 'moduleRootId') is distinct from
          (delete_meta ->> 'moduleRootId')
        or (update_meta ->> 'moduleRootId') is distinct from
          (delete_meta ->> 'moduleRootId')
        or (read_meta ->> 'moduleReleaseRevision') is distinct from
          (delete_meta ->> 'moduleReleaseRevision')
        or (update_meta ->> 'moduleReleaseRevision') is distinct from
          (delete_meta ->> 'moduleReleaseRevision') then
        raise exception using errcode = '42501',
          message = 'File attachment source is unavailable';
      end if;
      read_loaded := vortex_record.load_record_access_facts_internal(
        effect_row.record_type_id, 'read', effect_row.record_id,
        effect_row.post_concurrency_number
      );
      update_loaded := vortex_record.load_record_access_facts_internal(
        effect_row.record_type_id, 'update', effect_row.record_id,
        effect_row.post_concurrency_number
      );
      if read_loaded ->> 'outcome' is distinct from 'loaded'
        or update_loaded ->> 'outcome' is distinct from 'loaded'
        or (read_loaded ->> 'concurrencyNumber')::bigint is distinct from
          effect_row.post_concurrency_number
        or (update_loaded ->> 'concurrencyNumber')::bigint is distinct from
          effect_row.post_concurrency_number then
        raise exception using errcode = '40001',
          message = 'File attachment revision is stale';
      end if;
      select coalesce(pg_catalog.jsonb_agg(
        case when (
          pg_catalog.lower(item.value -> 'recordScope' ->> 'storageContractId') || ':' ||
          pg_catalog.lower(item.value -> 'recordScope' ->> 'recordId')
        ) = any (deleted_identities)
          then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active')
          else item.value end
        order by item.ordinality
      ), '[]'::jsonb)
      into records_value
      from pg_catalog.jsonb_array_elements(read_loaded -> 'facts' -> 'records')
        with ordinality as item(value, ordinality);
      facts := (read_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'records', records_value
      );
      read_decision := vortex_access.evaluate_organization_record_access_internal(
        read_meta -> 'declaration', effect_row.record_id,
        facts || pg_catalog.jsonb_build_object(
          'binding', read_meta -> 'declaration' -> 'recordBinding'
        )
      );
      select coalesce(pg_catalog.jsonb_agg(
        case when (
          pg_catalog.lower(item.value -> 'recordScope' ->> 'storageContractId') || ':' ||
          pg_catalog.lower(item.value -> 'recordScope' ->> 'recordId')
        ) = any (deleted_identities)
          then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active')
          else item.value end
        order by item.ordinality
      ), '[]'::jsonb)
      into records_value
      from pg_catalog.jsonb_array_elements(update_loaded -> 'facts' -> 'records')
        with ordinality as item(value, ordinality);
      facts := (update_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'records', records_value
      );
      update_decision := vortex_access.evaluate_organization_record_access_internal(
        update_meta -> 'declaration', effect_row.record_id,
        facts || pg_catalog.jsonb_build_object(
          'binding', update_meta -> 'declaration' -> 'recordBinding'
        )
      );
      if read_decision ->> 'outcome' is distinct from 'allowed'
        or update_decision ->> 'outcome' is distinct from 'allowed'
        or nullif(read_decision ->> 'validUntil', '')::timestamptz is null
        or nullif(update_decision ->> 'validUntil', '')::timestamptz is null
        or nullif(read_decision ->> 'validUntil', '')::timestamptz
          <= pg_catalog.statement_timestamp()
        or nullif(update_decision ->> 'validUntil', '')::timestamptz
          <= pg_catalog.statement_timestamp() then
        raise exception using errcode = '42501',
          message = 'File attachment authority is unavailable';
      end if;
      read_bounds := vortex_access.resolve_record_field_bounds_internal(read_decision);
      update_bounds := vortex_access.resolve_record_field_bounds_internal(update_decision);
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(attachment_fields) as field_item(value)
        where pg_catalog.jsonb_array_length(field_item.value -> 'fileIds') > 0
          and (
            not exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(read_bounds -> 'readableFieldIds') as allowed(value)
              where pg_catalog.lower(allowed.value) = field_item.value ->> 'fieldId'
            )
            or not exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(update_bounds -> 'changeableFieldIds') as allowed(value)
              where pg_catalog.lower(allowed.value) = field_item.value ->> 'fieldId'
            )
          )
      ) then
        raise exception using errcode = '42501',
          message = 'File attachment authority is unavailable';
      end if;
      attachment_policy := vortex_record.lock_record_recovery_policy_internal(
        receipt.organization_id, effect_row.storage_contract_id,
        case when delete_meta ->> 'storageScope' = 'application_contained'
          then receipt.application_root_id else null end
      );
      if attachment_policy ->> 'action' is distinct from 'delete'
        or pg_catalog.jsonb_typeof(attachment_policy -> 'recoveryWindowDays') <> 'number'
        or (attachment_policy ->> 'recoveryWindowDays') !~ '^[1-9][0-9]{0,8}$'
        or (attachment_policy ->> 'recoveryWindowDays')::bigint > 104249991 then
        raise exception using errcode = '23514',
          message = 'File recovery policy is unavailable';
      end if;
    else
      attachment_policy := null;
    end if;

    proof_value := pg_catalog.jsonb_build_object(
      'version', 1,
      'commandId', receipt.command_id,
      'organizationId', receipt.organization_id,
      'applicationRootId', receipt.application_root_id,
      'actorOrganizationAccountId', receipt.actor_organization_account_id,
      'storageContractId', effect_row.storage_contract_id,
      'moduleRootId', (delete_meta ->> 'moduleRootId')::uuid,
      'moduleReleaseRevision', (delete_meta ->> 'moduleReleaseRevision')::bigint,
      'recordTypeId', effect_row.record_type_id,
      'recordId', effect_row.record_id,
      'preConcurrencyNumber', effect_row.pre_concurrency_number,
      'postConcurrencyNumber', effect_row.post_concurrency_number,
      'attachmentFields', attachment_fields
    );
    proof_digest := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(proof_value::text, 'UTF8')),
      'hex'
    );
    if proof_digest is distinct from effect_row.file_cascade_proof_digest then
      raise exception using errcode = '40001',
        message = 'Record File cascade proof is stale';
    end if;

    execute pg_catalog.format(
      'select stored.deleted_at
       from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''soft_deleted''
         and stored.concurrency_number = $3
         and stored.definition_revision = $4',
      delete_meta ->> 'table'
    ) into deleted_at_value using receipt.organization_id, effect_row.record_id,
      effect_row.post_concurrency_number,
      (delete_meta ->> 'moduleReleaseRevision')::bigint;
    if deleted_at_value is null then
      raise exception using errcode = '40001',
        message = 'Record File cascade owner is stale';
    end if;
    effect_values := effect_values || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'effectSequence', effect_row.effect_sequence,
        'organizationId', receipt.organization_id,
        'applicationRootId', receipt.application_root_id,
        'storageContractId', effect_row.storage_contract_id,
        'moduleRootId', (delete_meta ->> 'moduleRootId')::uuid,
        'moduleReleaseRevision', (delete_meta ->> 'moduleReleaseRevision')::bigint,
        'storageScope', delete_meta ->> 'storageScope',
        'recordTypeId', effect_row.record_type_id,
        'recordId', effect_row.record_id,
        'preConcurrencyNumber', effect_row.pre_concurrency_number,
        'postConcurrencyNumber', effect_row.post_concurrency_number,
        'recordProofDigest', effect_row.file_cascade_proof_digest,
        'recordDeletedAt', vortex_context.format_timestamp_utc(deleted_at_value),
        'attachmentFields', attachment_fields
      ) || case when attachment_policy is not null
        then pg_catalog.jsonb_build_object(
          'recoveryPolicyRevision', attachment_policy -> 'policyRevision',
          'recoveryWindowDays', attachment_policy -> 'recoveryWindowDays'
        )
        else '{}'::jsonb end
    );
  end loop;

  if effect_count = 0
    or not exists (
      select 1
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = receipt.organization_id
        and effect.application_root_id = receipt.application_root_id
        and effect.actor_organization_account_id = receipt.actor_organization_account_id
        and effect.command_id = receipt.command_id
        and effect.effect_kind = 'soft_deleted'
        and effect.record_type_id = receipt.record_type_id
        and effect.record_id = receipt.record_id
        and effect.pre_concurrency_number = receipt.expected_concurrency_number
    ) then
    raise exception using errcode = '55000',
      message = 'Record File cascade effects are incomplete';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'effects', effect_values
  );
end
$function$;

alter function vortex_record.read_record_owned_file_lifecycle_authority_internal(uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_owned_file_lifecycle_authority_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record_owned_file_lifecycle_authority_internal(uuid)
  to vortex_file_owner, vortex_record_inventory, vortex_record_owner;
comment on function vortex_record.read_record_owned_file_lifecycle_authority_internal(uuid) is
  'Private current HUMAN Record-delete proof reader for the File cascade. Returns only the verified same-command attachment identities to the File owner and organization-complete inventory role.';
create or replace function vortex_record.settle_record_owned_file_delete_cascade_internal(
  p_command_id uuid,
  p_settlements jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.record_lifecycle_command_receipts%rowtype;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  settlement jsonb;
  settlement_count integer;
  effect_count integer;
  changed_rows integer;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_settlements) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Record File cascade settlement is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record File cascade settlement requires an Application context';
  end if;
  select stored.* into receipt
  from vortex_record.record_lifecycle_command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = p_command_id
  for update;
  if not found
    or receipt.state is distinct from 'pending'
    or receipt.operation is distinct from 'delete' then
    raise exception using errcode = '42501',
      message = 'Record File cascade settlement receipt is unavailable';
  end if;

  select pg_catalog.count(*) into effect_count
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = receipt.organization_id
    and effect.application_root_id = receipt.application_root_id
    and effect.actor_organization_account_id = receipt.actor_organization_account_id
    and effect.command_id = receipt.command_id
    and effect.effect_kind = 'soft_deleted';
  select pg_catalog.count(*) into settlement_count
  from pg_catalog.jsonb_array_elements(p_settlements) as item(value);
  if effect_count < 1 or settlement_count <> effect_count
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_settlements) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or item.value - array['effectSequence', 'proofDigest'] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(item.value -> 'effectSequence') is distinct from 'number'
        or (item.value ->> 'effectSequence') !~ '^[1-9][0-9]*$'
        or pg_catalog.jsonb_typeof(item.value -> 'proofDigest') is distinct from 'string'
        or (item.value ->> 'proofDigest') !~ '^[0-9a-f]{64}$'
    )
    or (
      select pg_catalog.count(distinct (item.value ->> 'effectSequence')::integer)
      from pg_catalog.jsonb_array_elements(p_settlements) as item(value)
    ) <> effect_count then
    raise exception using errcode = '55000',
      message = 'Record File cascade settlement is incomplete';
  end if;

  for effect_row in
    select effect.*
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
      and effect.effect_kind = 'soft_deleted'
    order by effect.effect_sequence
    for update
  loop
    select item.value into strict settlement
    from pg_catalog.jsonb_array_elements(p_settlements) as item(value)
    where (item.value ->> 'effectSequence')::integer = effect_row.effect_sequence;
    if effect_row.file_cascade_settled
      or effect_row.file_cascade_proof_digest is null
      or effect_row.file_cascade_proof_digest !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '55000',
        message = 'Record File cascade proof is unavailable';
    end if;
    update vortex_record.record_lifecycle_command_effects as effect
    set file_cascade_proof_digest = settlement ->> 'proofDigest',
      file_cascade_settled = true
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
      and effect.effect_sequence = effect_row.effect_sequence
      and effect.effect_kind = 'soft_deleted'
      and effect.file_cascade_settled = false
      and effect.file_cascade_proof_digest = effect_row.file_cascade_proof_digest;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001',
        message = 'Record File cascade settlement is stale';
    end if;
  end loop;
  if exists (
    select 1
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
      and effect.effect_kind = 'soft_deleted'
      and (not effect.file_cascade_settled
        or effect.file_cascade_proof_digest !~ '^[0-9a-f]{64}$')
  ) then
    raise exception using errcode = '55000',
      message = 'Record File cascade settlement is incomplete';
  end if;
end
$function$;

alter function vortex_record.settle_record_owned_file_delete_cascade_internal(uuid,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.settle_record_owned_file_delete_cascade_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.settle_record_owned_file_delete_cascade_internal(uuid,jsonb)
  to vortex_file_owner, vortex_record_owner;
comment on function vortex_record.settle_record_owned_file_delete_cascade_internal(uuid,jsonb) is
  'Privately settles every exact pending soft_deleted lifecycle effect after the File owner completes the same-transaction CAS, storing only a SHA-256 proof and settled marker.';

create or replace function vortex_record.apply_lifecycle_record_changes_internal(
  p_operation text,
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
  preparation jsonb;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  event_kind text;
  event_result jsonb;
  subject_ids uuid[];
  revisions jsonb;
  restored_revision bigint;
  target_kind text;
  target_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  command_fingerprint_value text;
  receipt_claim jsonb;
  installation jsonb;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  ownership_mode text;
  previous_owner_id uuid;
  updated_record_id uuid;
  updated_concurrency_number bigint;
  changed_rows integer;
  notice_sequence bigint;
  context_after jsonb;
  shared_consumers_initial jsonb;
  shared_consumers_final jsonb;
  target_item jsonb;
  module_item jsonb;
  target_application_root_id uuid;
  previous_target_application_root_id uuid;
  target_module_root_id uuid;
  previous_target_module_root_id uuid;
  target_module_binding_count integer;
  origin_application_is_consumer boolean;
begin
  -- The terminal delete, restore and ownership-transfer writes now run inside the
  -- one protected apply_record_changes operation. Each branch is the exact body
  -- its own writer used to carry, so its receipt, fingerprint, Activity and
  -- Events are unchanged; only the entry point moved. The delete and restore
  -- branches complete the record_lifecycle receipt the protected preflight
  -- already claimed and, for a delete, already soft-deleted behind; the transfer
  -- branch owns and claims its own record_save receipt as before.
  if p_operation = 'delete' then
    context_value := vortex_access.validated_human_request_context();
    receipt := vortex_record.lock_command_receipt_internal('record_lifecycle', p_command_id);
    if receipt.command_id is null
      or receipt.state is distinct from 'pending'
      or receipt.operation is distinct from 'delete'
      or receipt.record_type_id is distinct from p_record_type_id
      or receipt.record_id is distinct from p_record_id
      or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
      raise exception using errcode = '55000',
        message = 'Protected record delete is not prepared';
    end if;

    if not exists (
      select 1
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = receipt.organization_id
        and effect.application_root_id = receipt.application_root_id
        and effect.actor_organization_account_id = receipt.actor_organization_account_id
        and effect.command_id = receipt.command_id
        and effect.effect_kind = 'soft_deleted'
        and effect.record_type_id = receipt.record_type_id
        and effect.record_id = receipt.record_id
        and effect.pre_concurrency_number = receipt.expected_concurrency_number
    ) or exists (
      select 1
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = receipt.organization_id
        and effect.application_root_id = receipt.application_root_id
        and effect.actor_organization_account_id = receipt.actor_organization_account_id
        and effect.command_id = receipt.command_id
        and effect.effect_kind = 'soft_deleted'
        and (not effect.file_cascade_settled
          or effect.file_cascade_proof_digest is null
          or effect.file_cascade_proof_digest !~ '^[0-9a-f]{64}$')
    ) then
      raise exception using errcode = '55000',
        message = 'Protected record delete File cascade is not settled';
    end if;

    -- Closure identity and revisions are re-derived under the held locks rather
    -- than taken from the caller.
    preparation := vortex_record.prepare_record_lifecycle_totals_internal(
      'delete', p_record_type_id, p_record_id, p_command_id, null
    );
    if preparation ->> 'outcome' is distinct from 'prepared' then
      raise exception using errcode = '40001',
        message = 'Protected record delete closure changed';
    end if;
    perform vortex_record.apply_record_lifecycle_generated_values_internal(
      preparation, false, p_mutations
    );

    for effect_row in
      select effect.*
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = receipt.organization_id
        and effect.application_root_id = receipt.application_root_id
        and effect.actor_organization_account_id = receipt.actor_organization_account_id
        and effect.command_id = receipt.command_id
      order by effect.effect_sequence
    loop
      if effect_row.effect_kind = 'soft_deleted' then
        event_kind := 'deleted';
      else
        event_kind := 'unlinked';
      end if;
      event_result := vortex_event.append_record_occurrences(
        effect_row.storage_contract_id, effect_row.record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', case
            when event_kind = 'deleted' and effect_row.record_id = p_record_id
              and effect_row.record_type_id = p_record_type_id
              then receipt.occurrence_id
            else pg_catalog.gen_random_uuid() end,
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard', 'eventKind', event_kind,
            'recordTypeId', effect_row.record_type_id
          ),
          'payload', pg_catalog.jsonb_build_object('kind', event_kind)
        ))
      );
      if pg_catalog.jsonb_array_length(event_result) <> 1 then
        raise exception using errcode = '55000',
          message = 'Protected record delete Event append failed';
      end if;
    end loop;

    select pg_catalog.array_agg(distinct effect.record_id order by effect.record_id)
      into subject_ids
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id;
    if subject_ids is null or not (p_record_id = any (subject_ids)) then
      raise exception using errcode = '55000',
        message = 'Protected record delete effects are unavailable';
    end if;
    perform vortex_record.append_record_lifecycle_activity_internal(
      receipt.activity_id, 'delete', subject_ids
    );

    perform vortex_record.complete_command_receipt_internal(
      'record_lifecycle', p_command_id, null, p_expected_concurrency_number + 1,
      'Protected record delete receipt is stale'
    );

    return pg_catalog.jsonb_build_object(
      'outcome', 'deleted',
      'recordId', p_record_id,
      'concurrencyNumber', p_expected_concurrency_number + 1,
      'correlationId', context_value -> 'correlationId',
      'replayed', false
    );
  elsif p_operation = 'restore' then
    context_value := vortex_access.validated_human_request_context();
    receipt := vortex_record.lock_command_receipt_internal('record_lifecycle', p_command_id);
    if receipt.command_id is null
      or receipt.state is distinct from 'pending'
      or receipt.operation is distinct from 'restore'
      or receipt.record_type_id is distinct from p_record_type_id
      or receipt.record_id is distinct from p_record_id
      or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
      raise exception using errcode = '55000',
        message = 'Protected record restore is not prepared';
    end if;

    preparation := vortex_record.prepare_record_lifecycle_totals_internal(
      'restore', p_record_type_id, p_record_id, p_command_id, null
    );
    if preparation ->> 'outcome' is distinct from 'prepared'
      or (
        select (item.value ->> 'concurrencyNumber')::bigint
        from pg_catalog.jsonb_array_elements(preparation -> 'records') as item(value)
        where item.value ->> 'recordKey' = 'root'
      ) is distinct from p_expected_concurrency_number + 1 then
      raise exception using errcode = '40001',
        message = 'Protected record restore closure changed';
    end if;
    revisions := vortex_record.apply_record_lifecycle_generated_values_internal(
      preparation, true, p_mutations
    );
    select (item.value ->> 'concurrencyNumber')::bigint into strict restored_revision
    from pg_catalog.jsonb_array_elements(revisions) as item(value)
    where item.value ->> 'recordKey' = 'root';

    perform vortex_record.append_record_lifecycle_activity_internal(
      receipt.activity_id, 'restore', array[p_record_id]::uuid[]
    );

    perform vortex_record.complete_command_receipt_internal(
      'record_lifecycle', p_command_id, null, restored_revision,
      'Protected record restore receipt is stale'
    );

    return pg_catalog.jsonb_build_object(
      'outcome', 'restored',
      'recordId', p_record_id,
      'concurrencyNumber', restored_revision,
      'correlationId', context_value -> 'correlationId',
      'replayed', false
    );
  elsif p_operation = 'transfer_ownership' then
    -- The transfer's target is the command's ordered mutation list; it carries
    -- one transfer_ownership mutation with the exact installed target kind and
    -- identifier, never an authority.
    if pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_mutations) <> 1
      or pg_catalog.jsonb_typeof(p_mutations -> 0) is distinct from 'object'
      or not ((p_mutations -> 0) ?& array['kind', 'targetKind', 'targetId'])
      or (p_mutations -> 0) - array['kind', 'targetKind', 'targetId']::text[] <> '{}'::jsonb
      or (p_mutations -> 0 ->> 'kind') is distinct from 'transfer_ownership'
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetKind') is distinct from 'string'
      or (p_mutations -> 0 ->> 'targetKind') not in ('organization_account', 'group')
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_mutations -> 0 ->> 'targetId', 'uuid') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    target_kind := p_mutations -> 0 ->> 'targetKind';
    target_id := (p_mutations -> 0 ->> 'targetId')::uuid;
    if p_command_id is null or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_type_id is null or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_id is null or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or target_kind is null
      or target_kind not in ('organization_account', 'group')
      or target_id is null or target_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    context_value := vortex_access.lock_human_request_access_version_internal();
    if not context_value ? 'applicationRootId' then
      raise exception using errcode = '42501', message = 'Record ownership transfer requires an Application context';
    end if;
    organization_id_value := (context_value ->> 'organizationId')::uuid;
    application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
    actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
    command_fingerprint_value := vortex_record.ownership_transfer_command_fingerprint_internal(
      p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
      target_kind, target_id, 'public', null
    );

    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', p_command_id, 'transfer_ownership', command_fingerprint_value,
      p_record_type_id, null, '{}'::jsonb, '{}'::jsonb, false
    );
    if receipt_claim ->> 'status' is distinct from 'claimed' then
      if receipt_claim ->> 'status' = 'identity_conflict' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      if receipt_claim ->> 'status' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
        );
      end if;
      -- A replay reprojects from current access and intentionally never returns
      -- owner metadata (including the prior target).
      loaded := vortex_record.read_record(
        p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if loaded ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'transferred', 'recordId', loaded -> 'recordId',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', context_value -> 'correlationId', 'replayed', true
      );
    end if;
    -- The closed transfer authority is its own exact record permission decision;
    -- it is evaluated under the record lock, while owner columns remain
    -- unavailable to the ordinary update writer.
    -- Public transfer is active-installation-only.  It deliberately never calls
    -- the retained/detached reader, so a detached record cannot leak its current
    -- revision through the ordinary conflict response.
    begin
      installation := vortex_module.read_current_active_installation();
    exception
      when no_data_found then
        perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
    end;
    loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number, installation
    );
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
    select item.value into record_type_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
    if record_fact is null or record_type_fact is null
      or record_fact ->> 'lifecycleState' <> 'active' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    ownership_mode := record_type_fact ->> 'ownershipMode';
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' = 'refused' then
      perform vortex_record.append_ownership_transfer_activity_internal(
        p_activity_id, organization_id_value, 'refused'
      );
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    elsif decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Record ownership transfer authority is unavailable';
    end if;
    if ownership_mode = 'organization_account' then
      previous_owner_id := (record_fact ->> 'ownerOrganizationAccountId')::uuid;
    elsif ownership_mode = 'group' then
      previous_owner_id := (record_fact ->> 'ownerGroupId')::uuid;
    else
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'ownership_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if (ownership_mode = 'organization_account' and target_kind <> 'organization_account')
      or (ownership_mode = 'group' and target_kind <> 'group')
      or previous_owner_id is null or previous_owner_id = target_id
      or not vortex_access.lock_active_record_ownership_target_internal(target_kind, target_id) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'owner_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    execute pg_catalog.format(
      'update record_data.%I as stored set owner_organisation_account_id = $3,
         owner_group_id = $4, concurrency_number = concurrency_number + 1,
         updated_at = pg_catalog.statement_timestamp(), updated_by = $5
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.concurrency_number = $6 returning stored.record_id, stored.concurrency_number',
      loaded ->> 'table'
    ) into updated_record_id, updated_concurrency_number using organization_id_value, p_record_id,
      case when target_kind = 'organization_account' then target_id else null end,
      case when target_kind = 'group' then target_id else null end,
      actor_id_value, p_expected_concurrency_number;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Record ownership transfer revision changed';
    end if;
    if updated_record_id is distinct from p_record_id
      or updated_concurrency_number is null
      or updated_concurrency_number not between 1 and 9007199254740991 then
      raise exception using errcode = '55000', message = 'Record ownership transfer saved identity is unavailable';
    end if;
    perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id, p_record_id, 'completed');
    event_result := vortex_event.append_record_occurrences(
      (record_type_fact ->> 'storageContractId')::uuid,
      p_record_id, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', 'reassigned', 'recordTypeId', p_record_type_id
        ), 'payload', pg_catalog.jsonb_build_object('kind', 'reassigned')
      ))
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    perform vortex_record.complete_command_receipt_internal(
      'record_save', p_command_id, p_record_id, updated_concurrency_number,
      'Record ownership transfer receipt is stale'
    );
    if record_fact #>> '{recordScope,storageScope}' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        perform vortex_invalidation.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          updated_record_id, updated_concurrency_number, 'changed',
          notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
        );
      exception when others then
        -- Invalidation is advisory after the protected transfer is complete.
        null;
      end;
    elsif record_fact #>> '{recordScope,storageScope}' = 'organization_shared' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
          raise exception using errcode = '22003',
            message = 'Shared ownership transfer notice sequence is unavailable';
        end if;

        if record_fact -> 'recordScope' ->> 'moduleRootId'
            is distinct from record_type_fact ->> 'moduleRootId'
          or record_fact -> 'recordScope' ->> 'storageContractId'
            is distinct from record_type_fact ->> 'storageContractId'
          or not vortex_context.is_non_nil_uuid(record_fact -> 'recordScope' ->> 'moduleRootId')
          or not vortex_context.is_non_nil_uuid(record_type_fact ->> 'storageContractId') then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer record lineage is unavailable';
        end if;

        shared_consumers_initial := vortex_module.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if pg_catalog.jsonb_typeof(shared_consumers_initial) is distinct from 'object'
          or not (shared_consumers_initial ?& array['organizationId', 'accessVersion', 'targets'])
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(shared_consumers_initial)) <> 3
          or shared_consumers_initial ->> 'organizationId' is distinct from organization_id_value::text
          or not pg_catalog.pg_input_is_valid(shared_consumers_initial ->> 'accessVersion', 'bigint')
          or (shared_consumers_initial ->> 'accessVersion')::bigint
            is distinct from (context_value ->> 'accessVersion')::bigint
          or pg_catalog.jsonb_typeof(shared_consumers_initial -> 'targets') is distinct from 'array'
          or pg_catalog.jsonb_array_length(shared_consumers_initial -> 'targets') = 0 then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer consumer selection is malformed';
        end if;

        previous_target_application_root_id := null;
        origin_application_is_consumer := false;
        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          if pg_catalog.jsonb_typeof(target_item) is distinct from 'object'
            or not (target_item ?& array[
              'applicationRootId', 'applicationReleaseRevision', 'moduleRootId',
              'moduleReleaseRevision', 'bindingRevision', 'recordTypeId',
              'storageContractId', 'registrationRevision', 'definitionKey',
              'releaseVersion', 'validationContractVersion', 'contentFingerprint',
              'resolutionFingerprint', 'catalogueFingerprint', 'moduleBindings'
            ])
            or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(target_item)) <> 15
            or not vortex_context.is_non_nil_uuid(target_item ->> 'applicationRootId')
            or not vortex_context.is_non_nil_uuid(target_item ->> 'moduleRootId')
            or not vortex_context.is_non_nil_uuid(target_item ->> 'storageContractId')
            or not pg_catalog.pg_input_is_valid(target_item ->> 'applicationReleaseRevision', 'bigint')
            or (target_item ->> 'applicationReleaseRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'moduleRootId' is distinct from record_fact -> 'recordScope' ->> 'moduleRootId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'moduleReleaseRevision', 'bigint')
            or (target_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
            or not pg_catalog.pg_input_is_valid(target_item ->> 'bindingRevision', 'bigint')
            or (target_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'recordTypeId' is distinct from p_record_type_id::text
            or target_item ->> 'storageContractId'
              is distinct from record_type_fact ->> 'storageContractId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'registrationRevision', 'bigint')
            or (target_item ->> 'registrationRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'definitionKey' is null or target_item ->> 'definitionKey' = ''
            or target_item ->> 'releaseVersion' is null or target_item ->> 'releaseVersion' = ''
            or target_item ->> 'validationContractVersion' is null
            or target_item ->> 'validationContractVersion' = ''
            or target_item ->> 'contentFingerprint' is null
            or target_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'resolutionFingerprint' is null
            or target_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'catalogueFingerprint' is null
            or target_item ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or pg_catalog.jsonb_typeof(target_item -> 'moduleBindings') is distinct from 'array'
            or pg_catalog.jsonb_array_length(target_item -> 'moduleBindings') = 0 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer evidence is malformed';
          end if;

          target_application_root_id := (target_item ->> 'applicationRootId')::uuid;
          if previous_target_application_root_id is not null
            and target_application_root_id <= previous_target_application_root_id then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer set is not unique and ordered';
          end if;
          previous_target_application_root_id := target_application_root_id;
          if target_application_root_id = application_root_id_value then
            origin_application_is_consumer := true;
          end if;

          previous_target_module_root_id := null;
          target_module_binding_count := 0;
          for module_item in
            select binding.value
            from pg_catalog.jsonb_array_elements(target_item -> 'moduleBindings') as binding(value)
            order by (binding.value ->> 'moduleRootId')::uuid
          loop
            if pg_catalog.jsonb_typeof(module_item) is distinct from 'object'
              or not (module_item ?& array[
                'moduleRootId', 'bindingRevision', 'applicationReleaseRevision',
                'moduleReleaseRevision', 'state', 'contentFingerprint',
                'resolutionFingerprint', 'generatorContractVersion', 'storageContractIds'
              ])
              or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(module_item)) <> 9
              or not vortex_context.is_non_nil_uuid(module_item ->> 'moduleRootId')
              or not pg_catalog.pg_input_is_valid(module_item ->> 'bindingRevision', 'bigint')
              or (module_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
              or not pg_catalog.pg_input_is_valid(module_item ->> 'applicationReleaseRevision', 'bigint')
              or (module_item ->> 'applicationReleaseRevision')::bigint
                is distinct from (target_item ->> 'applicationReleaseRevision')::bigint
              or not pg_catalog.pg_input_is_valid(module_item ->> 'moduleReleaseRevision', 'bigint')
              or (module_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
              or module_item ->> 'state' is distinct from 'active'
              or module_item ->> 'contentFingerprint' is null
              or module_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'resolutionFingerprint' is null
              or module_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'generatorContractVersion' is distinct from '1.0.0'
              or pg_catalog.jsonb_typeof(module_item -> 'storageContractIds') is distinct from 'array'
              or pg_catalog.jsonb_array_length(module_item -> 'storageContractIds') = 0
              or exists (
                select 1
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                where pg_catalog.jsonb_typeof(contract.value) is distinct from 'string'
                  or not vortex_context.is_non_nil_uuid(contract.value #>> '{}')
              )
              or exists (
                select contract.value
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                group by contract.value having pg_catalog.count(*) <> 1
              )
              or module_item -> 'storageContractIds' is distinct from (
                select pg_catalog.jsonb_agg(contract.value order by (contract.value #>> '{}')::uuid)
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
              ) then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module binding evidence is malformed';
            end if;

            target_module_root_id := (module_item ->> 'moduleRootId')::uuid;
            if previous_target_module_root_id is not null
              and target_module_root_id <= previous_target_module_root_id then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module bindings are not unique and ordered';
            end if;
            previous_target_module_root_id := target_module_root_id;
            if target_module_root_id = (target_item ->> 'moduleRootId')::uuid then
              target_module_binding_count := target_module_binding_count + 1;
              if (module_item ->> 'moduleReleaseRevision')::bigint
                  is distinct from (target_item ->> 'moduleReleaseRevision')::bigint
                or (module_item ->> 'bindingRevision')::bigint
                  is distinct from (target_item ->> 'bindingRevision')::bigint
                or not exists (
                  select 1
                  from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                  where contract.value #>> '{}' = target_item ->> 'storageContractId'
                ) then
                raise exception using errcode = '55000',
                  message = 'Shared ownership transfer target binding does not match its complete Module lineage';
              end if;
            end if;
          end loop;
          if target_module_binding_count <> 1 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer target Module binding is ambiguous';
          end if;
        end loop;

        if not origin_application_is_consumer then
          raise exception using errcode = '42501',
            message = 'Origin Application is not a proved shared record consumer';
        end if;

        shared_consumers_final := vortex_module.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if shared_consumers_final is distinct from shared_consumers_initial then
          raise exception using errcode = '40001',
            message = 'Shared ownership transfer consumer snapshot changed before publication';
        end if;
        context_after := vortex_access.validated_human_request_context();
        if context_after is distinct from context_value then
          raise exception using errcode = '40001',
            message = 'Human ownership transfer context changed before publication';
        end if;

        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          perform vortex_invalidation.publish_change_notice(
            organization_id_value, (target_item ->> 'applicationRootId')::uuid,
            p_record_type_id, updated_record_id, updated_concurrency_number, 'changed',
            notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
          );
        end loop;
      exception when others then
        -- The completed transfer is structural. All App-scoped notices are one
        -- advisory subtransaction, so a failure rolls back every send together.
        null;
      end;
    else
      raise exception using errcode = '55000',
        message = 'Ownership transfer storage scope is unavailable';
    end if;
    -- This is deliberately an undisclosed result: an authorised transfer may
    -- remove the operator's read path.  A post-write projection would turn that
    -- valid committed mutation into a rollback.  Exact replay still applies
    -- current disclosure separately above.
    return pg_catalog.jsonb_build_object(
      'outcome', 'transferred', 'recordId', updated_record_id,
      'concurrencyNumber', updated_concurrency_number,
      'correlationId', context_value -> 'correlationId', 'replayed', false
    );
  end if;

  return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
end
$function$;

alter function vortex_record.apply_lifecycle_record_changes_internal(text,uuid,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_record_adapter;
comment on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'The terminal delete, restore and ownership-transfer record-change writes, applied inside the one protected operation: each keeps its own receipt kind, fingerprint, Activity and Event, and completes the preflight its protected preflight (delete and restore) or itself (ownership transfer) claimed.';

reset role;

set local role vortex_record_owner;
create or replace function vortex_record.lock_record_file_lifecycle_inventory_internal(
  p_command_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority jsonb;
  relation_row record;
  storage_row vortex_record.storage_catalogue%rowtype;
  relation_oid oid;
  owner_role_oid oid := 'vortex_record_owner'::regrole::oid;
  contract_id_value uuid;
  token_value text;
  relation_count integer := 0;
  attachment_mappings jsonb := '[]'::jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record File inventory command is invalid';
  end if;
  authority := vortex_record.read_record_owned_file_lifecycle_authority_internal(
    p_command_id
  );
  if authority ->> 'outcome' is distinct from 'prepared'
    or pg_catalog.jsonb_array_length(authority -> 'effects') = 0 then
    raise exception using errcode = '42501',
      message = 'Record File inventory authority is unavailable';
  end if;

  -- Freeze catalogue membership before enumerating tables, then take SHARE
  -- locks in one bytewise order so no concurrent Record writer can add or
  -- redirect an attachment reference during the organization-wide scan.
  lock table vortex_record.storage_catalogue,
    vortex_record.field_storage_mappings in share mode;

  if exists (
    select 1
    from vortex_record.storage_catalogue as catalogue
    where catalogue.state = 'active'
      and (catalogue.physical_schema_token is null
        or catalogue.physical_schema_token not in ('record_data', 'system_projection'))
  ) then
    raise exception using errcode = '55000',
      message = 'Record File inventory has an unsupported storage scope';
  end if;

  for storage_row in
    select stored.*
    from vortex_record.storage_catalogue as stored
    where stored.physical_schema_token in ('record_data', 'system_projection')
    order by stored.physical_table_token collate "C", stored.storage_contract_id
  loop
    if storage_row.physical_table_token !~ '^rt_[0-9a-f]{32}$'
      or storage_row.physical_table_token <> 'rt_' ||
        pg_catalog.replace(pg_catalog.lower(storage_row.storage_contract_id::text), '-', '') then
      raise exception using errcode = '55000',
        message = 'Record File inventory catalogue is incomplete';
    end if;
    relation_oid := pg_catalog.to_regclass(pg_catalog.format(
      '%I.%I', 'record_data', storage_row.physical_table_token
    ))::oid;
    if relation_oid is null
      or not exists (
        select 1 from pg_catalog.pg_class as relation
        where relation.oid = relation_oid
          and relation.relkind = 'r'
          and relation.relpersistence = 'p'
          and not relation.relispartition
          and relation.relowner = owner_role_oid
          and relation.relrowsecurity
          and relation.relforcerowsecurity
      ) then
      raise exception using errcode = '55000',
        message = 'Record File inventory storage is unavailable';
    end if;
  end loop;

  -- Every physical rt_/cp_ relation must have one exact contract lineage.
  -- Missing or unexpected inventory fails closed instead of becoming an empty
  -- owner set. All rows are scanned only by the current-organisation role.
  for relation_row in
    select relation.oid, relation.relname
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'record_data'
      and relation.relkind = 'r'
      and relation.relpersistence = 'p'
      and not relation.relispartition
      and (relation.relname ~ '^rt_[0-9a-f]{32}$'
        or relation.relname ~ '^cp_[0-9a-f]{32}$')
    order by relation.relname collate "C", relation.oid
  loop
    if not exists (
      select 1 from pg_catalog.pg_class as relation
      where relation.oid = relation_row.oid
        and relation.relowner = owner_role_oid
        and relation.relrowsecurity
        and relation.relforcerowsecurity
    ) then
      raise exception using errcode = '55000',
        message = 'Record File inventory relation is incompatible';
    end if;
    token_value := pg_catalog.substr(relation_row.relname, 4);
    contract_id_value := (
      pg_catalog.substr(token_value, 1, 8) || '-' ||
      pg_catalog.substr(token_value, 9, 4) || '-' ||
      pg_catalog.substr(token_value, 13, 4) || '-' ||
      pg_catalog.substr(token_value, 17, 4) || '-' ||
      pg_catalog.substr(token_value, 21, 12)
    )::uuid;
    if pg_catalog.starts_with(relation_row.relname, 'rt_') then
      if not exists (
        select 1 from vortex_record.storage_catalogue as catalogue
        where catalogue.storage_contract_id = contract_id_value
          and catalogue.physical_table_token = relation_row.relname
          and catalogue.physical_schema_token in ('record_data', 'system_projection')
      ) then
        raise exception using errcode = '55000',
          message = 'Record File inventory Record lineage is unavailable';
      end if;
    else
      if not exists (
        select 1
        from vortex_record.storage_catalogue as catalogue
        join vortex_record.field_storage_mappings as mapping
          on mapping.storage_contract_id = catalogue.storage_contract_id
        where catalogue.storage_contract_id = contract_id_value
          and catalogue.physical_table_token = 'rt_' || token_value
          and mapping.introduced_by_module_root_id <> catalogue.module_root_id
          and mapping.state in ('active', 'retired')
      ) then
        raise exception using errcode = '55000',
          message = 'Record File inventory companion lineage is unavailable';
      end if;
    end if;
    execute pg_catalog.format(
      'lock table record_data.%I in share mode', relation_row.relname
    );
    relation_count := relation_count + 1;
  end loop;

  if relation_count = 0 then
    raise exception using errcode = '55000',
      message = 'Record File inventory is unavailable';
  end if;
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'storage_contract_id', catalogue.storage_contract_id,
      'module_root_id', catalogue.module_root_id,
      'record_type_id', catalogue.record_type_id,
      'storage_scope', catalogue.storage_scope,
      'base_table_token', catalogue.physical_table_token,
      'table_token', case
        when mapping.introduced_by_module_root_id = catalogue.module_root_id
          then catalogue.physical_table_token
        else 'cp_' || pg_catalog.replace(
          pg_catalog.lower(catalogue.storage_contract_id::text), '-', ''
        ) end,
      'field_id', mapping.field_id,
      'column_token', mapping.physical_column_token,
      'database_value_type', mapping.database_value_type,
      'introduced_by_module_root_id', mapping.introduced_by_module_root_id
    ) order by catalogue.storage_contract_id, mapping.field_id
  ), '[]'::jsonb)
  into attachment_mappings
  from vortex_record.storage_catalogue as catalogue
  join vortex_record.field_storage_mappings as mapping
    on mapping.storage_contract_id = catalogue.storage_contract_id
  where mapping.state in ('active', 'retired')
    and mapping.field_definition ->> 'type' = 'attachment'
    and catalogue.physical_schema_token in ('record_data', 'system_projection');

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(attachment_mappings) as item(value)
    where not exists (
      select 1
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = relation.oid
      where namespace.nspname = 'record_data'
        and relation.relname = item.value ->> 'table_token'
        and relation.relowner = owner_role_oid
        and relation.relkind = 'r'
        and relation.relpersistence = 'p'
        and relation.relrowsecurity
        and relation.relforcerowsecurity
        and attribute.attname = item.value ->> 'column_token'
        and attribute.attnum > 0
        and not attribute.attisdropped
        and attribute.atttypid = 'jsonb'::regtype
    )
  ) then
    raise exception using errcode = '55000',
      message = 'Record File attachment catalogue is incomplete';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'locked', 'relationCount', relation_count,
    'attachmentMappings', attachment_mappings
  );
end
$function$;

alter function vortex_record.lock_record_file_lifecycle_inventory_internal(uuid)
  owner to vortex_record_owner;

revoke all on function vortex_record.lock_record_file_lifecycle_inventory_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_file_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.lock_record_file_lifecycle_inventory_internal(uuid)
  to vortex_record_inventory, vortex_record_owner;
comment on function vortex_record.lock_record_file_lifecycle_inventory_internal(uuid) is
  'Privately locks the complete mapped Record and companion-table inventory for the current pending HUMAN lifecycle deletion before cross-Application attachment membership is derived.';
create or replace function vortex_record.create_system_projection_companion_storage_internal(
  p_storage_contract_id uuid,
  p_target_module_root_id uuid,
  p_record_type_id uuid,
  p_contributor_module_root_id uuid,
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
  field_id_value uuid;
  database_type text;
  sql_type text;
  table_token text;
  column_token text;
  protected_view_key text;
  reader_schema_value text;
  reader_function_value text;
  view_oid oid;
  reader_function_oid oid;
  relation_oid oid;
  owner_role_oid oid := 'vortex_record_owner'::regrole::oid;
  adapter_role_oid oid := 'vortex_record_adapter'::regrole::oid;
  inventory_role_oid oid := 'vortex_record_inventory'::regrole::oid;
  has_mapping boolean;
  expected_columns text[];
  existing_columns text[];
  acl_adapter_count integer;
  acl_adapter_invalid_count integer;
  acl_inventory_count integer;
  acl_inventory_invalid_count integer;
  acl_other_count integer;
  policy_expression text;
  inventory_policy_expression text;
begin
  if not vortex_context.is_non_nil_uuid(p_storage_contract_id::text)
    or not vortex_context.is_non_nil_uuid(p_target_module_root_id::text)
    or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_context.is_non_nil_uuid(p_contributor_module_root_id::text)
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
  if not vortex_context.is_non_nil_uuid(field_id_value::text)
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
      message = 'Protected projection view is unavailable';
  end if;
  view_oid := pg_catalog.to_regclass(pg_catalog.format(
    '%I.%I', 'record_data', catalogue_row.physical_table_token
  ))::oid;
  reader_function_oid := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.%I(uuid,integer)', reader_schema_value, reader_function_value
  ))::oid;
  if view_oid is null
    or reader_function_oid is null
    or not exists (
      select 1
      from pg_catalog.pg_class as relation
      where relation.oid = view_oid
        and relation.relkind = 'v'
        and relation.relowner = owner_role_oid
    )
    or exists (
      select 1 from pg_catalog.pg_trigger as trigger
      where trigger.tgrelid = view_oid and not trigger.tgisinternal
    )
    or exists (
      select 1 from pg_catalog.pg_rewrite as rule
      where rule.ev_class = view_oid and rule.rulename <> '_RETURN'
    )
    or (
      select pg_catalog.count(*)
      from pg_catalog.pg_rewrite as rule
      join pg_catalog.pg_depend as dependency
        on dependency.classid = 'pg_rewrite'::regclass
        and dependency.objid = rule.oid
        and dependency.refclassid = 'pg_proc'::regclass
      where rule.ev_class = view_oid and rule.rulename = '_RETURN'
    ) <> 1
    or exists (
      select 1
      from pg_catalog.pg_rewrite as rule
      join pg_catalog.pg_depend as dependency
        on dependency.classid = 'pg_rewrite'::regclass
        and dependency.objid = rule.oid
        and dependency.refclassid = 'pg_class'::regclass
      where rule.ev_class = view_oid and rule.rulename = '_RETURN'
        and dependency.refobjid <> view_oid
    )
    or not exists (
      select 1 from pg_catalog.pg_proc as reader
      where reader.oid = reader_function_oid and reader.prosecdef
    )
    or not exists (
      select 1
      from pg_catalog.pg_rewrite as rule
      join pg_catalog.pg_depend as dependency
        on dependency.classid = 'pg_rewrite'::regclass
        and dependency.objid = rule.oid
        and dependency.refclassid = 'pg_proc'::regclass
        and dependency.refobjid = reader_function_oid
      where rule.ev_class = view_oid and rule.rulename = '_RETURN'
    ) then
    raise exception using errcode = '55000',
      message = 'Protected projection view lineage is incompatible';
  end if;

  select mapping.* into mapping_row
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_storage_contract_id
    and mapping.field_id = field_id_value
  for update;
  has_mapping := found;
  if has_mapping then
    if mapping_row.introduced_by_module_root_id <> p_contributor_module_root_id
      or mapping_row.physical_column_token <> column_token
      or mapping_row.database_value_type <> database_type
      or mapping_row.state not in ('active', 'retired')
      or vortex_record.field_storage_meaning(mapping_row.field_definition)
        is distinct from vortex_record.field_storage_meaning(p_field_definition) then
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
        using (organisation_id = vortex_context.organization_id())
        with check (organisation_id = vortex_context.organization_id())', table_token
    );
    execute pg_catalog.format(
      'create policy record_account_deletion_inventory on record_data.%I
        for select to vortex_record_inventory
        using (organisation_id = vortex_context.organization_id())', table_token
    );
    execute pg_catalog.format(
      'revoke all on record_data.%I from public, anon, authenticated, service_role,
        vortex_runtime, vortex_request, vortex_module_owner', table_token
    );
    execute pg_catalog.format(
      'grant select, insert, update on record_data.%I to vortex_record_adapter', table_token
    );
    execute pg_catalog.format(
      'grant select on record_data.%I to vortex_record_inventory', table_token
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
        where privilege.grantee = inventory_role_oid
          and privilege.privilege_type = 'SELECT'
          and not privilege.is_grantable
      ),
      pg_catalog.count(*) filter (
        where privilege.grantee = inventory_role_oid
          and (privilege.privilege_type <> 'SELECT' or privilege.is_grantable)
      ),
      pg_catalog.count(*) filter (
        where privilege.grantee not in (owner_role_oid, adapter_role_oid, inventory_role_oid)
      )
    into acl_adapter_count, acl_adapter_invalid_count,
      acl_inventory_count, acl_inventory_invalid_count, acl_other_count
    from pg_catalog.pg_class as relation
    cross join lateral pg_catalog.aclexplode(coalesce(
      relation.relacl, pg_catalog.acldefault('r', relation.relowner)
    )) as privilege
    where relation.oid = relation_oid;
    if acl_adapter_count <> 3
      or acl_adapter_invalid_count <> 0
      or acl_inventory_count <> 1
      or acl_inventory_invalid_count <> 0
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
    select pg_catalog.regexp_replace(pg_catalog.lower(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
      ), '\s+', '', 'g')
    into inventory_policy_expression
    from pg_catalog.pg_policy as policy
    where policy.polrelid = relation_oid
      and policy.polname = 'record_account_deletion_inventory';
    if policy_expression is distinct from '(organisation_id=vortex_context.organization_id())'
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
            = '(organisation_id=vortex_context.organization_id())'
      )
      or inventory_policy_expression is distinct from
        '(organisation_id=vortex_context.organization_id())'
      or not exists (
        select 1 from pg_catalog.pg_policy as policy
        where policy.polrelid = relation_oid
          and policy.polname = 'record_account_deletion_inventory'
          and policy.polpermissive
          and policy.polcmd = 'r'
          and policy.polroles = array[inventory_role_oid]::oid[]
          and pg_catalog.regexp_replace(pg_catalog.lower(
            pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
          ), '\s+', '', 'g') is null
      )
      or (
        select pg_catalog.count(*) from pg_catalog.pg_policy as policy
        where policy.polrelid = relation_oid
      ) <> 2 then
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

alter function vortex_record.create_system_projection_companion_storage_internal(uuid,uuid,uuid,uuid,jsonb,boolean)
  owner to vortex_record_owner;

revoke all on function vortex_record.create_system_projection_companion_storage_internal(uuid, uuid, uuid, uuid, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.create_system_projection_companion_storage_internal(uuid, uuid, uuid, uuid, jsonb, boolean)
  to vortex_record_owner;
comment on function vortex_record.create_system_projection_companion_storage_internal(uuid, uuid, uuid, uuid, jsonb, boolean) is
  'Privately preflights or provisions one optional unindexed companion field for an exact system-projection storage contract. Companion rows are organisation-scoped and are never written by a separate Record command.';

reset role;

set local role vortex_record_inventory;
create or replace function vortex_record.read_record_file_lifecycle_membership_internal(
  p_command_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  lock_result jsonb;
  authority jsonb;
  effect_item jsonb;
  field_item jsonb;
  mapping_row record;
  match_row record;
  organization_id_value uuid;
  candidate_file_ids uuid[] := array[]::uuid[];
  candidate_file_text text[] := array[]::text[];
  candidate_file_text_value text;
  matching_count integer;
  invalid_values boolean;
  base_table_token text;
  physical_table_token text;
  relation_oid oid;
  membership_values jsonb := '[]'::jsonb;
  expected boolean;
begin
  lock_result := vortex_record.lock_record_file_lifecycle_inventory_internal(
    p_command_id
  );
  if lock_result ->> 'outcome' is distinct from 'locked' then
    raise exception using errcode = '55000',
      message = 'Record File inventory could not be locked';
  end if;
  authority := vortex_record.read_record_owned_file_lifecycle_authority_internal(
    p_command_id
  );
  if authority ->> 'outcome' is distinct from 'prepared' then
    raise exception using errcode = '42501',
      message = 'Record File membership authority is unavailable';
  end if;
  select (item.value ->> 'organizationId')::uuid into strict organization_id_value
  from pg_catalog.jsonb_array_elements(authority -> 'effects') as item(value)
  order by (item.value ->> 'effectSequence')::integer
  limit 1;

  for effect_item in
    select item.value
    from pg_catalog.jsonb_array_elements(authority -> 'effects') as item(value)
    order by (item.value ->> 'effectSequence')::integer
  loop
    for field_item in
      select item.value
      from pg_catalog.jsonb_array_elements(effect_item -> 'attachmentFields') as item(value)
      order by item.value ->> 'fieldId' collate "C"
    loop
      for candidate_file_text_value in
        select item.value
        from pg_catalog.jsonb_array_elements_text(field_item -> 'fileIds') as item(value)
        order by item.value collate "C"
      loop
        candidate_file_ids := pg_catalog.array_append(
          candidate_file_ids, candidate_file_text_value::uuid
        );
        candidate_file_text := pg_catalog.array_append(
          candidate_file_text, candidate_file_text_value
        );
      end loop;
    end loop;
  end loop;
  if pg_catalog.cardinality(candidate_file_ids) > (
    select pg_catalog.count(distinct item.value)
    from pg_catalog.unnest(candidate_file_text) as item(value)
  ) then
    raise exception using errcode = '23514',
      message = 'File attachment has multiple Record owners';
  end if;

  if pg_catalog.cardinality(candidate_file_ids) > 0 then
    for mapping_row in
      select mapping.storage_contract_id, mapping.module_root_id,
        mapping.record_type_id, mapping.storage_scope,
        mapping.base_table_token, mapping.table_token,
        mapping.field_id, mapping.column_token,
        mapping.introduced_by_module_root_id, mapping.database_value_type
      from pg_catalog.jsonb_to_recordset(lock_result -> 'attachmentMappings') as mapping(
        storage_contract_id uuid,
        module_root_id uuid,
        record_type_id uuid,
        storage_scope text,
        base_table_token text,
        table_token text,
        field_id uuid,
        column_token text,
        database_value_type text,
        introduced_by_module_root_id uuid
      )
      order by mapping.storage_contract_id, mapping.field_id
    loop
      base_table_token := mapping_row.base_table_token;
      physical_table_token := mapping_row.table_token;
      relation_oid := pg_catalog.to_regclass(pg_catalog.format(
        '%I.%I', 'record_data', physical_table_token
      ))::oid;
      if relation_oid is null
        or mapping_row.database_value_type is distinct from 'json'
        or not exists (
          select 1 from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = relation_oid
            and attribute.attname = mapping_row.column_token
            and attribute.attnum > 0
            and not attribute.attisdropped
            and attribute.atttypid = 'jsonb'::regtype
        ) then
        raise exception using errcode = '55000',
          message = 'Record File attachment mapping is unavailable';
      end if;

      if physical_table_token = base_table_token then
        execute pg_catalog.format(
          'select exists (
             select 1 from record_data.%I as stored
             where stored.organisation_id = $1
               and stored.lifecycle_state not in (''active'', ''soft_deleted'', ''removed'')
               and pg_catalog.to_jsonb(stored.%I) is not null
               and pg_catalog.jsonb_typeof(pg_catalog.to_jsonb(stored.%I))
                 not in (''array'', ''null'')
           )',
          physical_table_token, mapping_row.column_token,
          mapping_row.column_token
        ) into invalid_values using organization_id_value;
      else
        execute pg_catalog.format(
          'select exists (
             select 1
             from record_data.%I as companion
             join record_data.%I as stored
               on stored.organisation_id = companion.organisation_id
               and stored.record_id = companion.record_id
             where companion.organisation_id = $1
               and stored.lifecycle_state not in (''active'', ''soft_deleted'', ''removed'')
               and pg_catalog.to_jsonb(companion.%I) is not null
               and pg_catalog.jsonb_typeof(pg_catalog.to_jsonb(companion.%I))
                 not in (''array'', ''null'')
           )',
          physical_table_token, base_table_token,
          mapping_row.column_token, mapping_row.column_token
        ) into invalid_values using organization_id_value;
      end if;
      if invalid_values then
        raise exception using errcode = '23514',
          message = 'Record File attachment value is invalid';
      end if;

      if physical_table_token = base_table_token then
        for match_row in execute pg_catalog.format(
          'select stored.record_id, stored.application_root_id, item.value as file_id
           from record_data.%I as stored
           cross join lateral pg_catalog.jsonb_array_elements_text(
             pg_catalog.to_jsonb(stored.%I)
           ) as item(value)
           where stored.organisation_id = $1
             and stored.lifecycle_state in (''active'', ''soft_deleted'')
             and item.value = any ($2::text[])',
          physical_table_token, mapping_row.column_token
        ) using organization_id_value, candidate_file_text
        loop
          expected := exists (
            select 1
            from pg_catalog.jsonb_array_elements(authority -> 'effects') as effect(value)
            cross join lateral pg_catalog.jsonb_array_elements(
              effect.value -> 'attachmentFields'
            ) as field(value)
            where (effect.value ->> 'storageContractId')::uuid =
                mapping_row.storage_contract_id
              and (effect.value ->> 'recordId')::uuid = match_row.record_id
              and (effect.value ->> 'recordTypeId')::uuid = mapping_row.record_type_id
              and (field.value ->> 'fieldId')::uuid = mapping_row.field_id
              and field.value -> 'fileIds' ? match_row.file_id
          );
          if not expected then
            raise exception using errcode = '23514',
              message = 'File attachment has another Record owner';
          end if;
          membership_values := membership_values || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'fileId', match_row.file_id::uuid,
              'storageContractId', mapping_row.storage_contract_id,
              'recordTypeId', mapping_row.record_type_id,
              'recordId', match_row.record_id,
              'fieldId', mapping_row.field_id,
              'applicationRootId', match_row.application_root_id
            )
          );
        end loop;
      else
        for match_row in execute pg_catalog.format(
          'select stored.record_id, stored.application_root_id, item.value as file_id
           from record_data.%I as companion
           join record_data.%I as stored
             on stored.organisation_id = companion.organisation_id
             and stored.record_id = companion.record_id
           cross join lateral pg_catalog.jsonb_array_elements_text(
             pg_catalog.to_jsonb(companion.%I)
           ) as item(value)
           where companion.organisation_id = $1
             and stored.lifecycle_state in (''active'', ''soft_deleted'')
             and item.value = any ($2::text[])',
          physical_table_token, base_table_token, mapping_row.column_token
        ) using organization_id_value, candidate_file_text
        loop
          expected := exists (
            select 1
            from pg_catalog.jsonb_array_elements(authority -> 'effects') as effect(value)
            cross join lateral pg_catalog.jsonb_array_elements(
              effect.value -> 'attachmentFields'
            ) as field(value)
            where (effect.value ->> 'storageContractId')::uuid =
                mapping_row.storage_contract_id
              and (effect.value ->> 'recordId')::uuid = match_row.record_id
              and (effect.value ->> 'recordTypeId')::uuid = mapping_row.record_type_id
              and (field.value ->> 'fieldId')::uuid = mapping_row.field_id
              and field.value -> 'fileIds' ? match_row.file_id
          );
          if not expected then
            raise exception using errcode = '23514',
              message = 'File attachment has another Record owner';
          end if;
          membership_values := membership_values || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'fileId', match_row.file_id::uuid,
              'storageContractId', mapping_row.storage_contract_id,
              'recordTypeId', mapping_row.record_type_id,
              'recordId', match_row.record_id,
              'fieldId', mapping_row.field_id,
              'applicationRootId', match_row.application_root_id
            )
          );
        end loop;
      end if;
    end loop;
  end if;

  for candidate_file_text_value in
    select distinct item.value from pg_catalog.unnest(candidate_file_text) as item(value)
  loop
    select pg_catalog.count(*) into matching_count
    from pg_catalog.jsonb_array_elements(membership_values) as membership(value)
    where membership.value ->> 'fileId' = candidate_file_text_value;
    if matching_count <> 1 then
      raise exception using errcode = '23514',
        message = 'File attachment ownership is incomplete';
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'complete',
    'effects', authority -> 'effects',
    'memberships', membership_values
  );
end
$function$;

alter function vortex_record.read_record_file_lifecycle_membership_internal(uuid)
  owner to vortex_record_inventory;

revoke all on function vortex_record.read_record_file_lifecycle_membership_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_file_owner, vortex_record_adapter, vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record_file_lifecycle_membership_internal(uuid)
  to vortex_file_owner, vortex_record_inventory;
comment on function vortex_record.read_record_file_lifecycle_membership_internal(uuid) is
  'Organization-complete content-free attachment membership reader over forced-RLS Record and companion storage, callable only by the File owner and inventory owner.';

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter, vortex_record_inventory;
reset role;

set local role vortex_file_owner;
create or replace function vortex_file.apply_record_owned_file_delete_cascade_internal(
  p_command_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  membership_result jsonb;
  effect_item jsonb;
  membership_item jsonb;
  candidate_file_ids uuid[] := array[]::uuid[];
  candidate_file_text text[] := array[]::text[];
  candidate_file_text_value text;
  file_row vortex_file.file_records%rowtype;
  owner_effect jsonb;
  proof_files jsonb;
  settlement_items jsonb := '[]'::jsonb;
  proof_value jsonb;
  proof_digest text;
  record_deleted_at timestamptz;
  due_at timestamptz;
  recovery_window_days integer;
  new_metadata_revision bigint;
  file_count integer := 0;
  expected_count integer := 0;
  effect_sequence integer;
  effect_cas jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'File cascade command is invalid';
  end if;
  membership_result := vortex_record.read_record_file_lifecycle_membership_internal(
    p_command_id
  );
  if membership_result ->> 'outcome' is distinct from 'complete'
    or pg_catalog.jsonb_typeof(membership_result -> 'effects') is distinct from 'array'
    or pg_catalog.jsonb_typeof(membership_result -> 'memberships') is distinct from 'array' then
    raise exception using errcode = '55000',
      message = 'File cascade membership is unavailable';
  end if;

  for effect_item in
    select item.value
    from pg_catalog.jsonb_array_elements(membership_result -> 'effects') as item(value)
    order by (item.value ->> 'effectSequence')::integer
  loop
    for membership_item in
      select field.value
      from pg_catalog.jsonb_array_elements(effect_item -> 'attachmentFields') as field(value)
    loop
      for candidate_file_text_value in
        select file.value
        from pg_catalog.jsonb_array_elements_text(membership_item -> 'fileIds') as file(value)
      loop
        candidate_file_text := pg_catalog.array_append(
          candidate_file_text, candidate_file_text_value
        );
        candidate_file_ids := pg_catalog.array_append(
          candidate_file_ids, candidate_file_text_value::uuid
        );
      end loop;
    end loop;
  end loop;

  select coalesce(pg_catalog.array_agg(item.file_id order by item.file_id), array[]::uuid[])
  into candidate_file_ids
  from (select distinct file_id from pg_catalog.unnest(candidate_file_ids) as source(file_id)) as item;
  select coalesce(pg_catalog.array_agg(item.file_id::text order by item.file_id), array[]::text[])
  into candidate_file_text
  from pg_catalog.unnest(candidate_file_ids) as item(file_id);
  expected_count := pg_catalog.cardinality(candidate_file_ids);

  for file_row in
    select stored.*
    from vortex_file.file_records as stored
    where stored.organization_id =
      ((membership_result -> 'effects' -> 0) ->> 'organizationId')::uuid
      and stored.file_id = any (candidate_file_ids)
    order by stored.file_id
    for update
  loop
    file_count := file_count + 1;
    select membership.value into strict membership_item
    from pg_catalog.jsonb_array_elements(membership_result -> 'memberships') as membership(value)
    where (membership.value ->> 'fileId')::uuid = file_row.file_id;
    select effect.value into strict owner_effect
    from pg_catalog.jsonb_array_elements(membership_result -> 'effects') as effect(value)
    where (effect.value ->> 'storageContractId')::uuid =
        (membership_item ->> 'storageContractId')::uuid
      and (effect.value ->> 'recordTypeId')::uuid =
        (membership_item ->> 'recordTypeId')::uuid
      and (effect.value ->> 'recordId')::uuid =
        (membership_item ->> 'recordId')::uuid;

    if file_row.file_id is null
      or file_row.lifecycle_state is distinct from 'active'
      or file_row.deleted_at is not null
      or file_row.removal_due_at is not null
      or file_row.metadata_revision not between 1 and 9007199254740990
      or file_row.application_root_id is distinct from
        (owner_effect ->> 'applicationRootId')::uuid
      or file_row.owner_record_type_id is distinct from
        (membership_item ->> 'recordTypeId')::uuid
      or file_row.owner_record_id is distinct from
        (membership_item ->> 'recordId')::uuid
      or file_row.owner_field_id is distinct from
        (membership_item ->> 'fieldId')::uuid
      or (owner_effect ->> 'storageScope') = 'application_contained'
        and (membership_item ->> 'applicationRootId') is distinct from
          (owner_effect ->> 'applicationRootId')
      or (owner_effect ->> 'storageScope') = 'organization_shared'
        and (membership_item ->> 'applicationRootId') is not null then
      raise exception using errcode = '40001',
        message = 'File attachment ownership or revision is stale';
    end if;
    if pg_catalog.jsonb_typeof(owner_effect -> 'recoveryWindowDays') is distinct from 'number'
      or (owner_effect ->> 'recoveryWindowDays') !~ '^[1-9][0-9]{0,8}$'
      or (owner_effect ->> 'recoveryWindowDays')::bigint > 104249991 then
      raise exception using errcode = '23514',
        message = 'File recovery policy is unavailable';
    end if;
    record_deleted_at := (owner_effect ->> 'recordDeletedAt')::timestamptz;
    recovery_window_days := (owner_effect ->> 'recoveryWindowDays')::integer;
    due_at := record_deleted_at + pg_catalog.make_interval(
      secs => recovery_window_days::double precision * 86400.0
    );
    if record_deleted_at is null or due_at <= record_deleted_at then
      raise exception using errcode = '23514',
        message = 'File recovery deadline is invalid';
    end if;

    update vortex_file.file_records as stored
    set lifecycle_state = 'soft_deleted',
      deleted_at = record_deleted_at,
      removal_due_at = due_at
    where stored.file_id = file_row.file_id
      and stored.organization_id = file_row.organization_id
      and stored.application_root_id = file_row.application_root_id
      and stored.owner_record_type_id = file_row.owner_record_type_id
      and stored.owner_record_id = file_row.owner_record_id
      and stored.owner_field_id = file_row.owner_field_id
      and stored.lifecycle_state = 'active'
      and stored.deleted_at is null
      and stored.metadata_revision = file_row.metadata_revision
    returning stored.metadata_revision into new_metadata_revision;
    if not found or new_metadata_revision <> file_row.metadata_revision + 1 then
      raise exception using errcode = '40001',
        message = 'File attachment metadata revision is stale';
    end if;

    effect_sequence := (owner_effect ->> 'effectSequence')::integer;
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'fileId', file_row.file_id,
        'fieldId', file_row.owner_field_id,
        'preMetadataRevision', file_row.metadata_revision,
        'postMetadataRevision', new_metadata_revision,
        'deletedAt', vortex_context.format_timestamp_utc(record_deleted_at),
        'removalDueAt', vortex_context.format_timestamp_utc(due_at)
      ) order by file_row.file_id
    ), '[]'::jsonb)
    into effect_cas
    from pg_catalog.jsonb_array_elements(membership_result -> 'memberships') as member(value)
    where (member.value ->> 'storageContractId')::uuid =
        (owner_effect ->> 'storageContractId')::uuid
      and (member.value ->> 'recordTypeId')::uuid =
        (owner_effect ->> 'recordTypeId')::uuid
      and (member.value ->> 'recordId')::uuid =
        (owner_effect ->> 'recordId')::uuid
      and (member.value ->> 'fileId')::uuid = file_row.file_id;
    -- Accumulate this file's exact metadata CAS under its owning lifecycle effect.
    owner_effect := owner_effect || pg_catalog.jsonb_build_object(
      'fileCascadeProof', coalesce(owner_effect -> 'fileCascadeProof', '[]'::jsonb)
        || effect_cas
    );
    membership_result := membership_result || pg_catalog.jsonb_build_object(
      'effects', (
        select pg_catalog.jsonb_agg(
          case when (item.value ->> 'effectSequence')::integer = effect_sequence
            then owner_effect else item.value end
          order by item.ordinality
        )
        from pg_catalog.jsonb_array_elements(membership_result -> 'effects')
          with ordinality as item(value, ordinality)
      )
    );
  end loop;
  if file_count <> expected_count then
    raise exception using errcode = '40001',
      message = 'File attachment membership changed';
  end if;

  for effect_item in
    select item.value
    from pg_catalog.jsonb_array_elements(membership_result -> 'effects') as item(value)
    order by (item.value ->> 'effectSequence')::integer
  loop
    proof_files := coalesce(effect_item -> 'fileCascadeProof', '[]'::jsonb);
    proof_value := pg_catalog.jsonb_build_object(
      'version', 1,
      'commandId', p_command_id,
      'effectSequence', (effect_item ->> 'effectSequence')::integer,
      'recordProofDigest', effect_item ->> 'recordProofDigest',
      'fileMetadataCas', proof_files
    );
    proof_digest := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(proof_value::text, 'UTF8')),
      'hex'
    );
    settlement_items := settlement_items || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'effectSequence', (effect_item ->> 'effectSequence')::integer,
        'proofDigest', proof_digest
      )
    );
  end loop;

  perform vortex_record.settle_record_owned_file_delete_cascade_internal(
    p_command_id, settlement_items
  );
  return pg_catalog.jsonb_build_object('outcome', 'settled');
end
$function$;

alter function vortex_file.apply_record_owned_file_delete_cascade_internal(uuid)
  owner to vortex_file_owner;

revoke all on function vortex_file.apply_record_owned_file_delete_cascade_internal(uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.apply_record_owned_file_delete_cascade_internal(uuid)
  to vortex_runtime;
comment on function vortex_file.apply_record_owned_file_delete_cascade_internal(uuid) is
  'Applies the exact current HUMAN Record-owned File soft-delete CAS and private lifecycle-effect settlement in the same request transaction, preserving File content, metadata, references and legal holds.';

reset role;

commit;
