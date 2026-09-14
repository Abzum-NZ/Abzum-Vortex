-- Fixed organisation-local administration changes. The two scope helpers own
-- immutable #34 declarations; each request entry fixes one mutation and
-- composes only an existing owner writer with a #30 accepted receipt.
create function vortex_access.organization_accounts_administration_change_scope()
returns table (
  tenant_id uuid, organization_id uuid, organization_account_id uuid,
  access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare decision record; resolved_tenant_id uuid;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.accounts.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '630a980c-0ff5-40b1-a329-7326a2122395'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.accounts.manage'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null then
    raise exception using errcode = '42501',
      message = 'Organization account administration change is unavailable';
  end if;
  select organization.tenant_id into strict resolved_tenant_id
  from vortex_identity.organizations as organization
  where organization.organization_id = decision.organization_id;
  return query select resolved_tenant_id, decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

create function vortex_access.create_organization_invitation_for_administration(
  p_duplicate_key uuid, p_invited_email text, p_token_fingerprint text,
  p_expires_at timestamptz
)
returns table (
  outcome text, operation text, organization_id uuid, invitation_id uuid,
  revision bigint, correlation_id uuid, accepted_at timestamptz,
  access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  created record; command_fingerprint text; target_invitation_id uuid;
  subject_ids uuid[]; subject_revisions bigint[];
  operation_at timestamptz;
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_invited_email is null
    or p_invited_email <> pg_catalog.lower(pg_catalog.btrim(p_invited_email))
    or pg_catalog.char_length(p_invited_email) not between 3 and 320
    or p_invited_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    or p_token_fingerprint is null
    or p_token_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_expires_at is null
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz) then
    raise exception using errcode = '22023', message = 'Invitation creation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'create_organization_invitation',
      scope.organization_id::text, p_invited_email, p_expires_at::text), 'UTF8'),
      'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = scope.organization_account_id
    and stored.tenant_id = scope.tenant_id
    and stored.operation_key = 'create_organization_invitation'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(receipt.subject_ids) <> 2
      or not scope.organization_id = any(receipt.subject_ids) then
      raise exception using errcode = '42501', message = 'Invitation creation receipt is unavailable';
    end if;
    target_invitation_id := case when receipt.subject_ids[1] = scope.organization_id
      then receipt.subject_ids[2] else receipt.subject_ids[1] end;
    return query select 'replayed'::text, 'create_organization_invitation'::text,
      scope.organization_id, target_invitation_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, target_invitation_id)],
      receipt.receipt_id, receipt.accepted_at,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, scope.organization_id)];
    return;
  end if;
  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at <= operation_at then
    raise exception using errcode = '40001', message = 'Invitation creation is stale or unavailable';
  end if;
  select result.* into strict created
  from vortex_identity.create_organization_invitation(
    p_invited_email, p_token_fingerprint, p_expires_at
  ) as result;
  if created.organization_id <> scope.organization_id or created.revision <> 1
    or created.invited_email <> p_invited_email or created.expires_at <> p_expires_at
    or created.invited_by <> scope.organization_account_id then
    raise exception using errcode = '42501', message = 'Invitation creation result is unavailable';
  end if;
  if scope.organization_id < created.invitation_id then
    subject_ids := array[scope.organization_id, created.invitation_id];
    subject_revisions := array[scope.access_version, created.revision];
  else
    subject_ids := array[created.invitation_id, scope.organization_id];
    subject_revisions := array[created.revision, scope.access_version];
  end if;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid,
    scope.organization_account_id, scope.tenant_id,
    'create_organization_invitation', p_duplicate_key, command_fingerprint,
    subject_ids, subject_revisions, created.created_at
  ) returning * into receipt;
  return query select 'accepted'::text, 'create_organization_invitation'::text,
    scope.organization_id, created.invitation_id, created.revision,
    receipt.receipt_id, receipt.accepted_at, scope.access_version;
end
$function$;

create function vortex_access.revoke_organization_invitation_for_administration(
  p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint
)
returns table (
  outcome text, operation text, organization_id uuid, invitation_id uuid,
  revision bigint, correlation_id uuid, accepted_at timestamptz,
  access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  revoked record; command_fingerprint text;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_invitation_id is null or not vortex_context.is_non_nil_uuid(p_invitation_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Invitation revocation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'revoke_organization_invitation',
      scope.organization_id::text, p_invitation_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = scope.organization_account_id
    and stored.tenant_id = scope.tenant_id
    and stored.operation_key = 'revoke_organization_invitation'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(receipt.subject_ids) <> 2
      or not scope.organization_id = any(receipt.subject_ids)
      or not p_invitation_id = any(receipt.subject_ids) then
      raise exception using errcode = '42501', message = 'Invitation revocation receipt is unavailable';
    end if;
    return query select 'replayed'::text, 'revoke_organization_invitation'::text,
      scope.organization_id, p_invitation_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, p_invitation_id)],
      receipt.receipt_id, receipt.accepted_at,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, scope.organization_id)];
    return;
  end if;
  if p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Invitation revocation is stale or unavailable';
  end if;
  select result.* into strict revoked
  from vortex_identity.revoke_organization_invitation(
    p_invitation_id, p_expected_revision
  ) as result;
  if revoked.organization_id <> scope.organization_id
    or revoked.invitation_id <> p_invitation_id
    or revoked.revision <> p_expected_revision + 1
    or revoked.accepted_at is not null or revoked.revoked_at is null
    or revoked.revoked_by <> scope.organization_account_id then
    raise exception using errcode = '42501', message = 'Invitation revocation result is unavailable';
  end if;
  if scope.organization_id < p_invitation_id then
    subject_ids := array[scope.organization_id, p_invitation_id];
    subject_revisions := array[scope.access_version, revoked.revision];
  else
    subject_ids := array[p_invitation_id, scope.organization_id];
    subject_revisions := array[revoked.revision, scope.access_version];
  end if;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid,
    scope.organization_account_id, scope.tenant_id,
    'revoke_organization_invitation', p_duplicate_key, command_fingerprint,
    subject_ids, subject_revisions, revoked.changed_at
  ) returning * into receipt;
  return query select 'accepted'::text, 'revoke_organization_invitation'::text,
    scope.organization_id, p_invitation_id, revoked.revision,
    receipt.receipt_id, receipt.accepted_at, scope.access_version;
end
$function$;

create function vortex_access.reactivate_organization_account_for_administration(
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
    raise exception using errcode = '22023', message = 'Account reactivation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'reactivate_organization_account',
      scope.organization_id::text, p_organization_account_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = scope.organization_account_id
    and stored.tenant_id = scope.tenant_id
    and stored.operation_key = 'reactivate_organization_account'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(receipt.subject_ids) <> 2
      or not scope.organization_id = any(receipt.subject_ids)
      or not p_organization_account_id = any(receipt.subject_ids) then
      raise exception using errcode = '42501', message = 'Account reactivation receipt is unavailable';
    end if;
    return query select 'replayed'::text, 'reactivate_organization_account'::text,
      scope.organization_id, p_organization_account_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, p_organization_account_id)],
      receipt.receipt_id, receipt.accepted_at,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, scope.organization_id)];
    return;
  end if;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found or target.state not in ('suspended', 'closed')
    or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account reactivation is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'active'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'active' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account reactivation result is unavailable';
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
    scope.tenant_id, 'reactivate_organization_account', p_duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, changed.changed_at
  );
  return query select 'accepted'::text, 'reactivate_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

create function vortex_access.close_organization_account_for_administration(
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

create function vortex_access.organization_invitations_administration_change_scope()
returns table (
  tenant_id uuid, organization_id uuid, organization_account_id uuid,
  access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare decision record; resolved_tenant_id uuid;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.invitations.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', 'c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.invitations.manage'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null then
    raise exception using errcode = '42501',
      message = 'Organization invitation administration change is unavailable';
  end if;
  select organization.tenant_id into strict resolved_tenant_id
  from vortex_identity.organizations as organization
  where organization.organization_id = decision.organization_id;
  return query select resolved_tenant_id, decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

create function vortex_access.suspend_organization_account_for_administration(
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
    raise exception using errcode = '22023', message = 'Account suspension command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'suspend_organization_account',
      scope.organization_id::text, p_organization_account_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = scope.organization_account_id
    and stored.tenant_id = scope.tenant_id
    and stored.operation_key = 'suspend_organization_account'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(receipt.subject_ids) <> 2
      or not scope.organization_id = any(receipt.subject_ids)
      or not p_organization_account_id = any(receipt.subject_ids) then
      raise exception using errcode = '42501', message = 'Account suspension receipt is unavailable';
    end if;
    return query select 'replayed'::text, 'suspend_organization_account'::text,
      scope.organization_id, p_organization_account_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, p_organization_account_id)],
      receipt.receipt_id, receipt.accepted_at,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, scope.organization_id)];
    return;
  end if;
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
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    changed.state_change_correlation_id, scope.organization_account_id,
    scope.tenant_id, 'suspend_organization_account', p_duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, changed.changed_at
  );
  return query select 'accepted'::text, 'suspend_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

revoke execute on function
  vortex_access.organization_accounts_administration_change_scope(),
  vortex_access.organization_invitations_administration_change_scope()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

revoke execute on function
  vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint),
  vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint),
  vortex_access.close_organization_account_for_administration(uuid, uuid, bigint),
  vortex_access.create_organization_invitation_for_administration(
    uuid, text, text, timestamptz
  ),
  vortex_access.revoke_organization_invitation_for_administration(uuid, uuid, bigint)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function
  vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint),
  vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint),
  vortex_access.close_organization_account_for_administration(uuid, uuid, bigint),
  vortex_access.create_organization_invitation_for_administration(
    uuid, text, text, timestamptz
  ),
  vortex_access.revoke_organization_invitation_for_administration(uuid, uuid, bigint)
to vortex_request;

comment on function vortex_access.organization_accounts_administration_change_scope() is
  'Private fixed accounts.manage decision for organisation-local account lifecycle.';
comment on function vortex_access.organization_invitations_administration_change_scope() is
  'Private fixed invitations.manage decision for no-intent invitation changes.';
comment on function vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected active-to-suspended account command using the existing guarded owner and accepted receipt.';
comment on function vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected suspended-or-closed-to-active account command using the existing guarded owner and accepted receipt.';
comment on function vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected active-or-suspended-to-closed account command; closure is not deletion.';
comment on function vortex_access.create_organization_invitation_for_administration(uuid, text, text, timestamptz) is
  'Protected no-intent invitation creation; replay returns receipt evidence and never secret material.';
comment on function vortex_access.revoke_organization_invitation_for_administration(uuid, uuid, bigint) is
  'Protected pending invitation revocation, including expired invitations, using the existing Identity owner.';
comment on table vortex_identity.accepted_administration_receipts is
  'Private accepted-result receipts for protected administration; it contains no raw command input, secret, profile or permission snapshot.';
