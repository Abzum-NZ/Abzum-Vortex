create or replace function vortex_identity.rename_tenant_organization(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint,
  p_display_name text
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_revision bigint;
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_display_name is null
    or p_display_name <> pg_catalog.btrim(p_display_name)
    or pg_catalog.char_length(p_display_name) not between 1 and 120 then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation rename command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.rename',
    evaluated_at
  );
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'rename_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'rename_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  select organization.revision
  into current_revision
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if current_revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations
  set display_name = p_display_name,
    revision = resulting_revision
  where organizations.tenant_id = p_tenant_id
    and organizations.organization_id = p_organization_id;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
  );

  return query
  select 'accepted'::text,
    'rename_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text)
  to vortex_runtime;

comment on function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text) is
  'Protected same-tenant display-name-only organisation rename under the bound request context person''s current structural authority, exact revision and accepted replay.';

alter function vortex_identity.rename_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_display_name text) owner to vortex_owner;

grant execute on function vortex_identity.rename_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_display_name text) to postgres;
