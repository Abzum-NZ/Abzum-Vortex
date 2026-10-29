create or replace function vortex_identity.create_tenant_organization(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_parent_organization_id uuid,
  p_organization_short_name text,
  p_organization_display_name text,
  p_organization_steward_identity_id uuid,
  p_account_display_name text,
  p_account_language text,
  p_account_time_zone text,
  p_runtime_language text,
  p_runtime_time_zone text,
  p_runtime_currency text,
  p_runtime_date_format text,
  p_runtime_number_format text
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  organization_revision bigint,
  organization_account_id uuid,
  organization_account_revision bigint,
  access_version bigint,
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
  stored record;
  claimed jsonb;
  new_organization_id uuid := pg_catalog.gen_random_uuid();
  new_account_id uuid := pg_catalog.gen_random_uuid();
  new_role_id uuid := pg_catalog.gen_random_uuid();
  new_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_delegation_id uuid := pg_catalog.gen_random_uuid();
  new_group_id uuid := pg_catalog.gen_random_uuid();
  new_membership_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_access_version bigint;
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  replay_organization_id uuid;
  replay_account_id uuid;
  required_projection_count bigint;
  active_projection_count bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or (p_parent_organization_id is not null
      and not vortex_platform.is_non_nil_uuid(p_parent_organization_id::text))
    or p_organization_steward_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_steward_identity_id::text)
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_organization_short_name is null
    or pg_catalog.char_length(p_organization_short_name) not between 1 and 40
    or p_organization_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_organization_display_name is null
    or p_organization_display_name is distinct from pg_catalog.btrim(p_organization_display_name)
    or pg_catalog.char_length(p_organization_display_name) not between 1 and 120
    or p_account_display_name is null
    or p_account_display_name is distinct from pg_catalog.btrim(p_account_display_name)
    or pg_catalog.char_length(p_account_display_name) not between 1 and 120 then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation creation command is invalid';
  end if;

  perform vortex_identity.assert_organization_runtime_settings_values(
    p_runtime_language, p_runtime_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );
  perform vortex_identity.assert_organization_runtime_settings_values(
    p_account_language, p_account_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  -- Tenant serialization converges duplicate and short-name races and keeps a
  -- parent lifecycle change from crossing this creation decision.
  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  -- Identity lifecycle writers use the same projection rows. Lock caller and
  -- nominee in stable order, but defer eligibility checks until after replay.
  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = any(array[
    actor_identity_id, p_organization_steward_identity_id
  ])
  order by projection.identity_id
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
    'platform.tenant.organizations.create',
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
    'create_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
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
    select organization.organization_id
    into replay_organization_id
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored."subjectIds");
    select account.organization_account_id
    into replay_account_id
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = any(stored."subjectIds");
    if replay_organization_id is null or replay_account_id is null then
      raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
    end if;
    return query
    select 'replayed'::text,
      'create_tenant_organization'::text,
      replay_organization_id,
      1::bigint,
      replay_account_id,
      stored."subjectRevisions"[
        pg_catalog.array_position(stored."subjectIds", replay_account_id)
      ],
      stored."subjectRevisions"[
        pg_catalog.array_position(stored."subjectIds", replay_organization_id)
      ],
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  select pg_catalog.count(distinct nominated.identity_id)
  into required_projection_count
  from (values
    (actor_identity_id),
    (p_organization_steward_identity_id)
  ) as nominated(identity_id);
  select pg_catalog.count(distinct projection.identity_id)
  into active_projection_count
  from vortex_identity.identity_projections as projection
  where projection.identity_id = any(array[
    actor_identity_id, p_organization_steward_identity_id
  ])
    and projection.state = 'active';
  if active_projection_count <> required_projection_count then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  if p_parent_organization_id is not null
    and not exists (
      select 1
      from vortex_identity.organizations as parent
      where parent.tenant_id = p_tenant_id
        and parent.organization_id = p_parent_organization_id
        and parent.state in ('active', 'suspended')
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  -- Re-evaluate after all locks on existing facts. No creator membership or
  -- projection fallback is inferred from the tenant assignment.
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.create',
    evaluated_at
  );

  begin
    insert into vortex_identity.organizations (
      organization_id, tenant_id, parent_organization_id, short_name,
      display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      new_organization_id, p_tenant_id, p_parent_organization_id,
      p_organization_short_name, p_organization_display_name, 'active',
      evaluated_at, actor_identity_id, evaluated_at, 1
    );
  exception when unique_violation then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end;

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, language, time_zone, activated_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision
  ) values (
    new_account_id, new_organization_id, p_organization_steward_identity_id,
    p_account_display_name, 'active', p_account_language, p_account_time_zone,
    evaluated_at, evaluated_at, evaluated_at, actor_identity_id,
    new_correlation_id, 1
  );

  perform 1 from vortex_identity.initialize_organization_runtime_settings(
    new_organization_id, p_runtime_language, p_runtime_time_zone,
    p_runtime_currency, p_runtime_date_format, p_runtime_number_format
  );
  perform 1 from vortex_access.initialize_organization_access_version(
    new_organization_id, actor_identity_id, new_correlation_id
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    new_organization_id, actor_identity_id, new_correlation_id
  );

  select adopted.access_version
  into resulting_access_version
  from vortex_access.coordinate_organization_stewardship_adoption(
    new_organization_id, new_account_id, new_role_id, 'organization_steward',
    'Organisation steward', 'Permanent minimum organisation administration.',
    new_role_assignment_id, new_delegation_id, actor_identity_id,
    new_correlation_id
  ) as adopted;

  -- The initial steward has one current Group for Group-owned records.
  perform 1 from vortex_access.coordinate_organization_group_change(
    'create_group', new_organization_id, new_group_id, null,
    'organisation_owners', 'Organisation owners', new_account_id,
    new_correlation_id
  );
  select changed.access_version into resulting_access_version
  from vortex_access.coordinate_organization_group_membership_change(
    'add_membership', new_organization_id, new_membership_id, null,
    new_group_id, new_account_id, evaluated_at, null, null,
    new_account_id, new_correlation_id
  ) as changed;

  set constraints
    vortex_access.organization_role_revisions_checked
    immediate;
  set constraints
    vortex_access.organization_role_revisions_checked
    deferred;

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values
    (new_organization_id, resulting_access_version),
    (new_account_id, 1::bigint)
  ) as result(subject_id, subject_revision);

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
  );

  return query
  select 'accepted'::text,
    'create_tenant_organization'::text,
    new_organization_id,
    1::bigint,
    new_account_id,
    1::bigint,
    resulting_access_version,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text)
  to vortex_runtime;

comment on function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text) is
  'Creates one tenant organisation for the bound request context person with an explicit existing steward, runtime settings, delivered Access composition and an initial current owner Group membership for that steward.';

alter function vortex_identity.create_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_parent_organization_id uuid, p_organization_short_name text, p_organization_display_name text, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text) owner to vortex_owner;

grant execute on function vortex_identity.create_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_parent_organization_id uuid, p_organization_short_name text, p_organization_display_name text, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text) to postgres;
