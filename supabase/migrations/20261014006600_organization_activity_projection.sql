set local role vortex_owner;

create or replace function vortex_access.list_organization_activity_entries_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  actor_account_id uuid;
  decision_outcome text;
  decision_organization_id uuid;
  decision_account_id uuid;
  audit_projection boolean;
  activity_projection_window constant interval := interval '90 days';
begin
  begin
    checked_context := vortex_access.validated_human_request_context();
    visible_organization_id := (checked_context ->> 'organizationId')::uuid;
    actor_identity_id := (checked_context ->> 'identityId')::uuid;
    actor_account_id := (checked_context ->> 'organizationAccountId')::uuid;
    perform 1 from vortex_access.resolve_human_organization_scope(
      actor_identity_id, visible_organization_id
    );
  exception
    when insufficient_privilege or no_data_found then
      return;
  end;

  select evaluated.outcome, evaluated.organization_id, evaluated.organization_account_id
  into decision_outcome, decision_organization_id, decision_account_id
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.permissions.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(
        'platform.organization.permissions.read'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  audit_projection := coalesce(
    decision_outcome = 'eligible'
      and decision_organization_id = visible_organization_id
      and decision_account_id = actor_account_id,
    false
  );

  return query
  select
    entry.organization_id,
    entry.activity_id,
    1::bigint,
    pg_catalog.jsonb_build_object(
      'organization_id', entry.organization_id::text,
      'revision', 1,
      'occurred_at', entry.occurred_at,
      'actor_kind', case entry.actor_kind
        when 'organization_account' then 'Person'
        when 'identity' then 'Platform operator'
        when 'system' then 'System'
        when 'public_session' then 'Public visitor'
        else 'Other' end,
      'actor', case when entry.actor_kind = 'organization_account'
        then pg_catalog.jsonb_build_object('organizationAccountId', entry.actor_id::text)
        else null end,
      'action', entry.action,
      'subject_count', pg_catalog.cardinality(entry.subject_ids),
      'changed_field_count', case when audit_projection
        then pg_catalog.cardinality(entry.changed_field_ids) else null end
    )
  from vortex_record.organization_activity_entries as entry
  where entry.organization_id = visible_organization_id
    and entry.occurred_at >= pg_catalog.statement_timestamp() - activity_projection_window
    and (p_record_id is null or p_record_id = entry.activity_id)
    and (
      audit_projection
      or (entry.actor_kind = 'organization_account' and entry.actor_id = actor_account_id)
      or (entry.actor_kind = 'identity' and entry.actor_id = actor_identity_id)
    )
  order by entry.occurred_at desc, entry.activity_id desc;
end
$function$;

revoke all on function vortex_access.list_organization_activity_entries_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_activity_entries_projection(uuid, integer)
  to vortex_owner, vortex_record_adapter;
comment on function vortex_access.list_organization_activity_entries_projection(uuid, integer) is
  'Recent organisation activity projection; own rows or the existing permissions-read audit view, with counts and no payload or identifier lists.';
alter function vortex_access.list_organization_activity_entries_projection(uuid, integer)
  owner to vortex_owner;
grant execute on function vortex_access.list_organization_activity_entries_projection(uuid, integer)
  to postgres;


alter table vortex_record.protected_read_model_views
  drop constraint protected_read_model_views_protected_read_model_key_check;
alter table vortex_record.protected_read_model_views
  add constraint protected_read_model_views_protected_read_model_key_check
  check (protected_read_model_key = any (array[
    'people', 'organization_accounts', 'roles', 'groups', 'effective_assignments',
    'tenant_structure', 'organization_invitations', 'organization_runtime_settings',
    'permissions', 'role_activations', 'delegations', 'tenants',
    'tenant_administrators', 'installed_applications', 'application_role_templates',
    'activity_entry'
  ]));

alter table vortex_record.storage_catalogue
  drop constraint storage_catalogue_protected_read_model_key_check;
alter table vortex_record.storage_catalogue
  add constraint storage_catalogue_protected_read_model_key_check
  check (
    (physical_schema_token = 'system_projection') = (protected_read_model_key is not null)
    and (protected_read_model_key is null or protected_read_model_key = any (array[
      'people', 'organization_accounts', 'roles', 'groups', 'effective_assignments',
    'tenant_structure', 'organization_invitations', 'organization_runtime_settings',
    'permissions', 'role_activations', 'delegations', 'tenants',
    'tenant_administrators', 'installed_applications', 'application_role_templates',
    'activity_entry'
    ]))
  );

insert into vortex_record.protected_read_model_views (
  protected_read_model_key, reader_schema, reader_function, changed_at
) values (
  'activity_entry', 'vortex_access',
  'list_organization_activity_entries_projection', pg_catalog.statement_timestamp()
);

reset role;
