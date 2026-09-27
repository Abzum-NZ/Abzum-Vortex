create or replace function vortex_access.close_organization_account_for_administration(
  p_duplicate_key uuid, p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, operation text, organization_id uuid,
  organization_account_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz, access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  target record; changed record; command_fingerprint text;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account closure command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'close_organization_account',
      scope.organization_id::text, p_organization_account_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = scope.organization_account_id
    and stored.tenant_id = scope.tenant_id
    and stored.operation_key = 'close_organization_account'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(receipt.subject_ids) <> 2
      or not scope.organization_id = any(receipt.subject_ids)
      or not p_organization_account_id = any(receipt.subject_ids) then
      raise exception using errcode = '42501', message = 'Account closure receipt is unavailable';
    end if;
    return query select 'replayed'::text, 'close_organization_account'::text,
      scope.organization_id, p_organization_account_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, p_organization_account_id)],
      receipt.receipt_id, receipt.accepted_at,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, scope.organization_id)];
    return;
  end if;
  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found or target.state not in ('active', 'suspended')
    or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account closure is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'closed'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'closed' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account closure result is unavailable';
  end if;
  if scope.organization_id < p_organization_account_id then
    subject_ids := array[scope.organization_id, p_organization_account_id];
    subject_revisions := array[changed.access_version, changed.revision];
  else
    subject_ids := array[p_organization_account_id, scope.organization_id];
    subject_revisions := array[changed.revision, changed.access_version];
  end if;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    changed.state_change_correlation_id, scope.organization_account_id,
    scope.tenant_id, 'close_organization_account', p_duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, changed.changed_at
  );
  return query select 'accepted'::text, 'close_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

comment on function vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected active-or-suspended-to-closed account command; closure is not deletion.';

revoke execute on function
  vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function
  vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) to vortex_request;
