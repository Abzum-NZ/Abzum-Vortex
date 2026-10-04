create or replace function vortex_module.claim_organization_setup_source_manifest(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_identity_id uuid,
  p_operation text,
  p_receipt_id uuid,
  p_command_fingerprint text,
  p_expected_setup_revision integer,
  p_manifest_canonical_text text,
  p_manifest_fingerprint text
)
returns table (result_kind text, checkpoint jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  attested record;
  stored vortex_module.organization_setup_source_manifests%rowtype;
  expected_receipt jsonb;
  candidate_payload jsonb;
  candidate_entry jsonb;
  candidate_key text;
  candidate_version text;
  candidate_identity text;
  previous_identity text;
  has_default_application boolean := false;
  key_count bigint;
  unknown_key_count bigint;
  namespace_pattern constant text :=
    '^[a-z][a-z0-9]*(_[a-z0-9]+)*([.][a-z][a-z0-9]*(_[a-z0-9]+)*)+$';
  version_pattern constant text :=
    '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)([.](0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?([+]([0-9A-Za-z-]+([.][0-9A-Za-z-]+)*))?$';
begin
  if p_expected_setup_revision is distinct from 0
    or pg_catalog.array_position(array[
      p_tenant_id, p_organization_id, p_organization_account_id, p_identity_id, p_receipt_id
    ], null::uuid) is not null
    or '00000000-0000-0000-0000-000000000000'::uuid = any(array[
      p_tenant_id, p_organization_id, p_organization_account_id, p_identity_id, p_receipt_id
    ])
    or p_operation is null
    or p_operation not in ('provision_tenant', 'create_tenant_organization')
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or (p_manifest_canonical_text is null) <> (p_manifest_fingerprint is null) then
    raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
  end if;

  -- Reject oversized or inconsistent candidates before taking a lock, even for a stored replay.
  if p_manifest_canonical_text is not null then
    if pg_catalog.octet_length(pg_catalog.convert_to(p_manifest_canonical_text, 'UTF8'))
        not between 1 and 16777216
      or p_manifest_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
      raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
    end if;
    if p_manifest_fingerprint is distinct from (
      'sha256:' || pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to(p_manifest_canonical_text, 'UTF8')
      ), 'hex')
    ) then
      raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
    end if;
  end if;

  -- Original facts are re-attested here; neither runtime input nor the checkpoint is authority.
  select evidence.* into strict attested
  from vortex_identity.read_organization_setup_receipt(
    p_receipt_id, p_operation, p_organization_id
  ) as evidence;
  if attested.tenant_id is distinct from p_tenant_id
    or attested.organization_id is distinct from p_organization_id
    or attested.organization_account_id is distinct from p_organization_account_id
    or attested.identity_id is distinct from p_identity_id
    or attested.operation_key is distinct from p_operation
    or attested.receipt_id is distinct from p_receipt_id
    or attested.command_fingerprint is distinct from p_command_fingerprint then
    raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
  end if;
  expected_receipt := pg_catalog.jsonb_build_object(
    'tenantId', p_tenant_id::text,
    'organizationId', p_organization_id::text,
    'organizationAccountId', p_organization_account_id::text,
    'identityId', p_identity_id::text,
    'operation', p_operation,
    'receiptId', p_receipt_id::text,
    'commandFingerprint', p_command_fingerprint
  );

  -- The original organisation row serialises the first claim, including the read-before-select call.
  perform 1 from vortex_identity.organizations as organization
  where organization.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
  end if;

  select saved.* into stored
  from vortex_module.organization_setup_source_manifests as saved
  where saved.organization_id = p_organization_id;
  if found then
    if stored.tenant_id is distinct from p_tenant_id
      or stored.organization_account_id is distinct from p_organization_account_id
      or stored.identity_id is distinct from p_identity_id
      or stored.operation_key is distinct from p_operation
      or stored.receipt_id is distinct from p_receipt_id
      or stored.command_fingerprint is distinct from p_command_fingerprint
      or stored.setup_revision is distinct from 1
      or stored.phase is distinct from 'source_manifest_frozen'
      or stored.source_manifest_payload -> 'receipt' is distinct from expected_receipt
      or (p_manifest_canonical_text is not null and (
        stored.source_manifest_canonical_text is distinct from p_manifest_canonical_text
        or stored.manifest_fingerprint is distinct from p_manifest_fingerprint
      )) then
      raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
    end if;
    return query select 'pending'::text,
      stored.source_manifest_payload || pg_catalog.jsonb_build_object(
        'checkpointId', stored.checkpoint_id::text,
        'manifestFingerprint', stored.manifest_fingerprint,
        'setupRevision', stored.setup_revision,
        'phase', stored.phase
      );
    return;
  end if;

  if p_manifest_canonical_text is null then
    return query select 'missing'::text, null::jsonb;
    return;
  end if;
  candidate_payload := p_manifest_canonical_text::jsonb;
  if pg_catalog.jsonb_typeof(candidate_payload) is distinct from 'object' then
    raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
  end if;
  select pg_catalog.count(*), pg_catalog.count(*) filter (where key not in (
    'receipt', 'sourceManifestIdentity', 'sourceManifestVersion',
    'sources', 'intendedDefaultDefinitionKey'
  )) into key_count, unknown_key_count
  from pg_catalog.jsonb_object_keys(candidate_payload) as keys(key);
  if key_count <> 5 or unknown_key_count <> 0
    or candidate_payload -> 'receipt' is distinct from expected_receipt
    or pg_catalog.jsonb_typeof(candidate_payload -> 'sourceManifestIdentity')
      is distinct from 'string'
    or pg_catalog.jsonb_typeof(candidate_payload -> 'sourceManifestVersion')
      is distinct from 'string'
    or pg_catalog.jsonb_typeof(candidate_payload -> 'intendedDefaultDefinitionKey')
      is distinct from 'string'
    or pg_catalog.jsonb_typeof(candidate_payload -> 'sources') is distinct from 'array' then
    raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
  end if;
  foreach candidate_key in array array[
    candidate_payload ->> 'sourceManifestIdentity',
    candidate_payload ->> 'intendedDefaultDefinitionKey'
  ] loop
    if pg_catalog.char_length(candidate_key) not between 3 and 120
      or candidate_key !~ namespace_pattern
      or exists (select 1 from pg_catalog.unnest(pg_catalog.string_to_array(candidate_key, '.'))
        as segments(segment) where pg_catalog.char_length(segment) > 40) then
      raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
    end if;
  end loop;
  candidate_version := candidate_payload ->> 'sourceManifestVersion';
  if pg_catalog.char_length(candidate_version) not between 1 and 120
    or candidate_version !~ version_pattern
    or pg_catalog.jsonb_array_length(candidate_payload -> 'sources') not between 1 and 64 then
    raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
  end if;

  -- This bounded data envelope does not duplicate the current Module/Application compiler.
  for candidate_entry in
    select value from pg_catalog.jsonb_array_elements(candidate_payload -> 'sources') as sources(value)
  loop
    if pg_catalog.jsonb_typeof(candidate_entry) is distinct from 'object' then
      raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
    end if;
    select pg_catalog.count(*), pg_catalog.count(*) filter (where key not in (
      'kind', 'key', 'sourceContractVersion', 'source', 'sourceFingerprint'
    )) into key_count, unknown_key_count
    from pg_catalog.jsonb_object_keys(candidate_entry) as keys(key);
    if key_count <> 5 or unknown_key_count <> 0
      or pg_catalog.jsonb_typeof(candidate_entry -> 'kind') is distinct from 'string'
      or candidate_entry ->> 'kind' not in ('module', 'application')
      or pg_catalog.jsonb_typeof(candidate_entry -> 'key') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate_entry -> 'sourceContractVersion') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate_entry -> 'sourceFingerprint') is distinct from 'string'
      or candidate_entry ->> 'sourceFingerprint' !~ '^sha256:[a-f0-9]{64}$'
      or pg_catalog.jsonb_typeof(candidate_entry -> 'source') is distinct from 'object'
      or candidate_entry ->> 'kind' is distinct from candidate_entry -> 'source' ->> 'kind'
      or candidate_entry ->> 'key' is distinct from candidate_entry -> 'source' ->> 'key'
      or candidate_entry ->> 'sourceContractVersion'
        is distinct from candidate_entry -> 'source' ->> 'source_contract_version'
      or pg_catalog.jsonb_typeof(candidate_entry -> 'source' -> 'body') is distinct from 'object' then
      raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
    end if;
    candidate_key := candidate_entry ->> 'key';
    candidate_version := candidate_entry ->> 'sourceContractVersion';
    if pg_catalog.char_length(candidate_key) not between 3 and 120
      or candidate_key !~ namespace_pattern
      or exists (select 1 from pg_catalog.unnest(pg_catalog.string_to_array(candidate_key, '.'))
        as segments(segment) where pg_catalog.char_length(segment) > 40)
      or pg_catalog.char_length(candidate_version) not between 1 and 120
      or candidate_version !~ version_pattern then
      raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
    end if;
    candidate_identity := (candidate_entry ->> 'kind') || ':' || candidate_key;
    if previous_identity is not null
      and candidate_identity collate pg_catalog."C" <= previous_identity collate pg_catalog."C" then
      raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
    end if;
    previous_identity := candidate_identity;
    if candidate_entry ->> 'kind' = 'application'
      and candidate_key = candidate_payload ->> 'intendedDefaultDefinitionKey' then
      has_default_application := true;
    end if;
  end loop;
  if not has_default_application then
    raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
  end if;

  insert into vortex_module.organization_setup_source_manifests (
    tenant_id, organization_id, organization_account_id, identity_id, operation_key,
    receipt_id, command_fingerprint, source_manifest_canonical_text,
    source_manifest_payload, manifest_fingerprint
  ) values (
    p_tenant_id, p_organization_id, p_organization_account_id, p_identity_id, p_operation,
    p_receipt_id, p_command_fingerprint, p_manifest_canonical_text,
    candidate_payload, p_manifest_fingerprint
  ) returning * into stored;
  return query select 'pending'::text,
    stored.source_manifest_payload || pg_catalog.jsonb_build_object(
      'checkpointId', stored.checkpoint_id::text,
      'manifestFingerprint', stored.manifest_fingerprint,
      'setupRevision', stored.setup_revision,
      'phase', stored.phase
    );
exception
  when others then
    raise exception using errcode = 'V3101', message = 'Organisation setup is unavailable';
end
$function$;

revoke execute on function vortex_module.claim_organization_setup_source_manifest(
  uuid, uuid, uuid, uuid, text, uuid, text, integer, text, text
) from public, anon, authenticated, service_role, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_module.claim_organization_setup_source_manifest(
  uuid, uuid, uuid, uuid, text, uuid, text, integer, text, text
) to vortex_runtime;

comment on function vortex_module.claim_organization_setup_source_manifest(
  uuid, uuid, uuid, uuid, text, uuid, text, integer, text, text
) is 'Claims or reads one immutable original-receipt-bound pending source checkpoint; grants no setup, publication, installation, rights, default or completion authority.';

alter function vortex_module.claim_organization_setup_source_manifest(
  uuid, uuid, uuid, uuid, text, uuid, text, integer, text, text
) owner to postgres;
