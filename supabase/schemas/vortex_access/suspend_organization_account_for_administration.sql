create or replace function vortex_access.suspend_organization_account_for_administration(
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
  stored record; claimed jsonb;
  target record; changed record; command_fingerprint text;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account suspension command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'suspend_organization_account',
      scope.organization_id::text, p_organization_account_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'suspend_organization_account', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(stored."subjectIds") <> 2
      or not scope.organization_id = any(stored."subjectIds")
      or not p_organization_account_id = any(stored."subjectIds") then
      raise exception using errcode = '42501', message = 'Account suspension receipt is unavailable';
    end if;
    return query select 'replayed'::text, 'suspend_organization_account'::text,
      scope.organization_id, p_organization_account_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", p_organization_account_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
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
  if not found or target.state <> 'active' or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account suspension is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'suspended'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'suspended' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account suspension result is unavailable';
  end if;
  if scope.organization_id < p_organization_account_id then
    subject_ids := array[scope.organization_id, p_organization_account_id];
    subject_revisions := array[changed.access_version, changed.revision];
  else
    subject_ids := array[p_organization_account_id, scope.organization_id];
    subject_revisions := array[changed.revision, changed.access_version];
  end if;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', changed.state_change_correlation_id,
      'acceptedAt', changed.changed_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions),
      'fingerprint', command_fingerprint, 'clusterId', null));
  return query select 'accepted'::text, 'suspend_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

comment on function vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected active-to-suspended account command using the existing guarded owner and accepted receipt.';

revoke execute on function
  vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) to vortex_request;

alter function vortex_access.suspend_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_access.suspend_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) to postgres;
