CREATE FUNCTION vortex_access.check_record_share_grant_terms_internal(p_terms jsonb, p_context jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  context_organization_id uuid := (p_context ->> 'organizationId')::uuid;
  context_application_root_id uuid := (p_context ->> 'applicationRootId')::uuid;
  scope_kind_value text;
  module_id uuid;
  type_id uuid;
  record_value uuid;
  recipient_org uuid;
  recipient_cluster uuid;
  source_cluster uuid;
  recipient_app uuid;
  readable uuid[];
  changeable uuid[];
  recipient_roles uuid[];
  source_roles uuid[];
  recipient_accept_roles uuid[];
  action_keys text[];
  starts_value timestamptz;
  expires_value timestamptz;
  cross_organization boolean;
  authority jsonb;
  readable_ceiling uuid[];
  changeable_ceiling uuid[];
begin
  if p_terms is null or pg_catalog.jsonb_typeof(p_terms) <> 'object'
    or context_organization_id is null or context_application_root_id is null
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_terms) as supplied(key)
      where supplied.key <> all (array[
        'scopeKind', 'sourceClusterId', 'recipientClusterId', 'recipientOrganizationId',
        'recipientApplicationRootId', 'moduleRootId', 'recordTypeId', 'recordId',
        'savedConditionId', 'savedConditionRevision', 'savedConditionFingerprint',
        'parameters', 'readableFieldIds', 'changeableFieldIds', 'recipientRoleIds',
        'allowedActionKeys', 'exportAllowed', 'approvedRecipientRegion', 'startsAt',
        'expiresAt', 'contractVersion', 'contractFingerprint', 'recipientBindingId',
        'definitionMappingFingerprint', 'sourceAuthorizingRoleIds',
        'recipientAcceptingRoleIds'
      ])
    ) then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;

  scope_kind_value := p_terms ->> 'scopeKind';
  module_id := (p_terms ->> 'moduleRootId')::uuid;
  type_id := (p_terms ->> 'recordTypeId')::uuid;
  record_value := (p_terms ->> 'recordId')::uuid;
  recipient_org := (p_terms ->> 'recipientOrganizationId')::uuid;
  recipient_cluster := (p_terms ->> 'recipientClusterId')::uuid;
  source_cluster := (p_terms ->> 'sourceClusterId')::uuid;
  recipient_app := (p_terms ->> 'recipientApplicationRootId')::uuid;
  starts_value := (p_terms ->> 'startsAt')::timestamptz;
  expires_value := (p_terms ->> 'expiresAt')::timestamptz;
  readable := vortex_access.record_share_grant_uuid_array_internal(
    p_terms -> 'readableFieldIds', 1, 500);
  changeable := vortex_access.record_share_grant_uuid_array_internal(
    p_terms -> 'changeableFieldIds', 0, 500);
  recipient_roles := vortex_access.record_share_grant_uuid_array_internal(
    p_terms -> 'recipientRoleIds', 1, 100);
  cross_organization := recipient_org <> context_organization_id;

  select coalesce(pg_catalog.array_agg(item.value order by item.ordinality), array[]::text[])
  into action_keys
  from pg_catalog.jsonb_array_elements_text(
    case when pg_catalog.jsonb_typeof(p_terms -> 'allowedActionKeys') = 'array'
      then p_terms -> 'allowedActionKeys' else '[]'::jsonb end
  ) with ordinality as item(value, ordinality);

  if scope_kind_value is null
    or scope_kind_value not in ('module', 'record_type', 'saved_condition', 'record')
    or module_id is null or recipient_org is null or recipient_cluster is null
    or source_cluster is null or recipient_app is null or starts_value is null
    or pg_catalog.jsonb_typeof(p_terms -> 'exportAllowed') <> 'boolean'
    or pg_catalog.jsonb_typeof(p_terms -> 'allowedActionKeys') <> 'array'
    or pg_catalog.cardinality(action_keys) > 100
    or (select pg_catalog.count(distinct action_key) from pg_catalog.unnest(action_keys) as action_key)
      <> pg_catalog.cardinality(action_keys)
    or p_terms ->> 'approvedRecipientRegion' is null
    or pg_catalog.char_length(p_terms ->> 'approvedRecipientRegion') not between 2 and 100
    or p_terms ->> 'contractVersion' is null
    or p_terms ->> 'contractFingerprint' !~ '^sha256:[a-f0-9]{64}$'
    or p_terms ->> 'definitionMappingFingerprint' !~ '^sha256:[a-f0-9]{64}$'
    or (p_terms ->> 'recipientBindingId')::uuid is null
    or starts_value in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (expires_value is not null and (
      expires_value <= starts_value
      or expires_value in ('-infinity'::timestamptz, 'infinity'::timestamptz)))
    or not (changeable <@ readable)
    or (scope_kind_value = 'module' and (type_id is not null or record_value is not null))
    or (scope_kind_value <> 'module' and type_id is null)
    or (scope_kind_value = 'record' and record_value is null)
    or (scope_kind_value <> 'record' and record_value is not null)
    or (scope_kind_value = 'saved_condition' and (
      (p_terms ->> 'savedConditionId')::uuid is null
      or (p_terms ->> 'savedConditionRevision')::bigint is null
      or (p_terms ->> 'savedConditionFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or pg_catalog.jsonb_typeof(p_terms -> 'parameters') <> 'object'))
    or (scope_kind_value <> 'saved_condition' and (
      p_terms ? 'savedConditionId' or p_terms ? 'savedConditionRevision'
      or p_terms ? 'savedConditionFingerprint' or p_terms ? 'parameters'))
    or (cross_organization and expires_value is null)
    -- One organisation lives on one cluster: a same-organisation proposal and
    -- a recipient organisation this database holds are both on this cluster.
    or (not cross_organization and recipient_cluster <> source_cluster)
    or (recipient_cluster <> source_cluster and exists (
      select 1 from vortex_identity.organizations as organization
      where organization.organization_id = recipient_org
    )) then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;

  -- A grant never carries delete, restore, permission-change, ownership
  -- transfer or re-sharing authority, whatever the recipient roles hold.
  if exists (
    select 1
    from pg_catalog.unnest(action_keys) as action_key
    where action_key !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
      or exists (
        select 1
        from pg_catalog.regexp_split_to_table(action_key, '[._]') as part
        where part in (
          'delete', 'restore', 'share', 'reshare', 'permission', 'permissions',
          'ownership', 'transfer', 'grant', 'revoke', 'role', 'roles', 'administer'
        )
      )
  ) then
    raise exception using errcode = '22023',
      message = 'A record-share grant cannot authorise that action';
  end if;

  if cross_organization then
    source_roles := vortex_access.record_share_grant_uuid_array_internal(
      p_terms -> 'sourceAuthorizingRoleIds', 1, 100);
    recipient_accept_roles := vortex_access.record_share_grant_uuid_array_internal(
      p_terms -> 'recipientAcceptingRoleIds', 1, 100);
    if exists (
      select 1 from pg_catalog.unnest(source_roles) as wanted(role_value)
      where not exists (
        select 1
        from vortex_access.organization_roles as org_role
        join vortex_access.organization_role_revisions as revision
          on revision.organization_id = org_role.organization_id
          and revision.role_id = org_role.role_id
          and revision.revision = org_role.live_revision
        where org_role.organization_id = context_organization_id
          and org_role.role_id = wanted.role_value
          and (org_role.application_root_id is null
            or org_role.application_root_id = context_application_root_id)
          and revision.lifecycle in ('active', 'acceptance_required')
      )
    ) then
      raise exception using errcode = '22023',
        message = 'Record-share grant source authorising roles are unavailable';
    end if;
  elsif p_terms ? 'sourceAuthorizingRoleIds' or p_terms ? 'recipientAcceptingRoleIds' then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;

  -- Same-cluster recipients are verified here: the recipient organisation must
  -- be active, the recipient application actively registered there (the same
  -- evidence an application selection requires) and every recipient role a
  -- current role of that organisation. A recipient on another cluster cannot be
  -- read from this database; its identities are recorded as proposed and are
  -- confirmed by that organisation's own acceptance under protected consent
  -- (the recipient organisation accepts it). Nothing here activates, so an unverified proposal confers nothing.
  if recipient_cluster = source_cluster then
    if not exists (
      select 1
      from vortex_identity.organizations as organization
      join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
      where organization.organization_id = recipient_org
        and organization.state = 'active'
        and tenant.state = 'active'
    ) then
      raise exception using errcode = '42501',
        message = 'Record-share grant recipient is unavailable';
    end if;
    if not exists (
      select 1
      from vortex_access.permission_registrations as registration
      where registration.organization_id = recipient_org
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = recipient_app
        and registration.state = 'active'
    ) then
      raise exception using errcode = '42501',
        message = 'Record-share grant recipient application is unavailable';
    end if;
    if exists (
      select 1 from pg_catalog.unnest(recipient_roles) as wanted(role_value)
      where not exists (
        select 1
        from vortex_access.organization_roles as org_role
        join vortex_access.organization_role_revisions as revision
          on revision.organization_id = org_role.organization_id
          and revision.role_id = org_role.role_id
          and revision.revision = org_role.live_revision
        where org_role.organization_id = recipient_org
          and org_role.role_id = wanted.role_value
          and (org_role.application_root_id is null
            or org_role.application_root_id = recipient_app)
          and revision.lifecycle in ('active', 'acceptance_required')
      )
    ) then
      raise exception using errcode = '42501',
        message = 'Record-share grant recipient roles are unavailable';
    end if;
  end if;

  -- Source authority, the same rule for every scope kind: a current
  -- row-independent share permission on the record type (or, for a module, on
  -- at least one of its record types), and the proposed fields inside the
  -- proposer's own current read and update field policies on what it may share.
  authority := vortex_access.record_share_grant_source_authority_internal(
    p_context, module_id, type_id
  );
  if pg_catalog.jsonb_array_length(authority -> 'recordTypeIds') = 0 then
    raise exception using errcode = '42501',
      message = 'Record-share grant requires a current share permission';
  end if;
  select coalesce(pg_catalog.array_agg(field.value::uuid), array[]::uuid[])
  into readable_ceiling
  from pg_catalog.jsonb_array_elements_text(authority -> 'readableFieldIds') as field(value);
  select coalesce(pg_catalog.array_agg(field.value::uuid), array[]::uuid[])
  into changeable_ceiling
  from pg_catalog.jsonb_array_elements_text(authority -> 'changeableFieldIds') as field(value);
  if not (readable <@ readable_ceiling) then
    raise exception using errcode = '42501',
      message = 'Record-share grant exceeds current read authority';
  end if;
  if not (changeable <@ changeable_ceiling) then
    raise exception using errcode = '42501',
      message = 'Record-share grant exceeds current update authority';
  end if;
end
$_$;

alter function vortex_access.check_record_share_grant_terms_internal(p_terms jsonb, p_context jsonb) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.check_record_share_grant_terms_internal(p_terms jsonb, p_context jsonb) FROM PUBLIC;

grant execute on function vortex_access.check_record_share_grant_terms_internal(p_terms jsonb, p_context jsonb) to postgres;
