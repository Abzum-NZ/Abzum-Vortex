-- Preview links use the one protected writer and isolated storage; projections require live grants.
set local role vortex_owner;

-- A copied record keeps its record id; the source storage is part of its edge identity too.
alter table vortex_record.relationship_edges drop constraint relationship_edges_pkey;
alter table vortex_record.relationship_edges add constraint relationship_edges_pkey primary key (
  relationship_id, from_organisation_id, from_storage_contract_id, from_record_id,
  to_storage_contract_id, to_record_id
);
-- The edge-scope trigger proves the relationship against its source storage's declaration.
-- A preview-only relationship has no installed relationship mapping to reference.
alter table vortex_record.relationship_edges
  drop constraint relationship_edges_relationship_id_fkey;

set local role vortex_owner;

create or replace function vortex_access.evaluate_permission_role_path_internal(
  p_context jsonb,
  p_checked_at timestamptz,
  p_permission jsonb,
  p_action jsonb,
  p_record_type_id uuid
)
returns table (
  permission_entry vortex_access.permission_catalogue_entries,
  path_valid_until timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  context_organization_value uuid := (p_context ->> 'organizationId')::uuid;
  context_account_value uuid := (p_context ->> 'organizationAccountId')::uuid;
  context_expires_value timestamptz := (p_context ->> 'expiresAt')::timestamptz;
  decision_checked_at timestamptz := p_checked_at;
  permission_application_value uuid := (p_permission ->> 'applicationRootId')::uuid;
  permission_owner_kind_value text := p_permission ->> 'ownerKind';
  permission_owner_value uuid := (p_permission ->> 'ownerId')::uuid;
  permission_value uuid := (p_permission ->> 'permissionId')::uuid;
  action_kind_value text := p_action ->> 'actionKind';
  named_action_value text := p_action ->> 'namedAction';
  preview_registration record;
  preview_projection boolean := false;
  projection_live_registration boolean := false;
begin
  -- A preview request decides the permissions of the previewed Application and its own Modules
  -- from the preview's registration alone: the builder who opened the preview holds the draft's
  -- roles there. Every other permission, a used Module's included, and every permission on a
  -- system projection, the platform's live read model, is decided by the builder's own live
  -- access below; the preview's roles never apply to it.
  if permission_owner_kind_value in ('application', 'module')
    and nullif(
      pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
    ) is not null then
    select registration.* into preview_registration
    from vortex_access.request_application_registration_internal(
      context_organization_value,
      (p_context ->> 'applicationRootId')::uuid,
      context_account_value
    ) as registration;
    if preview_registration.registration_kind is distinct from 'preview' then
      return;
    end if;
    preview_projection := coalesce(
      p_record_type_id = any(preview_registration.system_projection_record_type_ids), false
    );
    if permission_owner_value = any(preview_registration.owned_owner_ids)
      and not coalesce(
        p_record_type_id = any(preview_registration.system_projection_record_type_ids), false
      ) then
      return query
      select preview_entry.entry,
        case when preview_entry.held
          then least(context_expires_value, preview_registration.valid_until)
        end
      from vortex_access.preview_permission_entries as preview_entry
      where preview_entry.preview_installation_id = preview_registration.preview_installation_id
        and (preview_entry.entry).application_root_id is not distinct from
          permission_application_value
        and (preview_entry.entry).owner_kind = permission_owner_kind_value
        and (preview_entry.entry).owner_id = permission_owner_value
        and (preview_entry.entry).permission_id = permission_value
        and (preview_entry.entry).record_type_id is not distinct from p_record_type_id
        and (preview_entry.entry).action_kind = action_kind_value
        and (preview_entry.entry).named_action is not distinct from named_action_value;
      return;
    end if;
  end if;

  -- A projection has no preview copy or draft grant. A Module's permission is registered by every
  -- installed Application that links that Module, each under its own Application root, and none of
  -- those is the address of the previewed Application: a projection of a used Module selects its
  -- permission from the caller's live registrations rather than from the address it was asked
  -- about. The common live role-path decision below still proves a current grant, and ordinary
  -- borrowed record types keep their existing refusal.
  if preview_projection and permission_owner_kind_value = 'module' then
    projection_live_registration := true;
  end if;

  return query
  with current_permission as materialized (
    select catalogue.application_root_id, catalogue.owner_kind,
      catalogue.owner_id, catalogue.permission_id,
      catalogue.registration_kind, catalogue.registration_owner_id,
      catalogue.registration_revision, continuity.continuity_revision,
      catalogue as permission_entry,
      catalogue.record_type_id is not distinct from p_record_type_id
        and catalogue.action_kind = action_kind_value
        and catalogue.named_action is not distinct from named_action_value
        as matches_request
    from vortex_access.permission_registrations as registration
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = registration.organization_id
      and catalogue.registration_kind = registration.registration_kind
      and catalogue.registration_owner_id = registration.registration_owner_id
      and catalogue.registration_revision = registration.revision
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = catalogue.organization_id
      and continuity.application_scope_id = coalesce(catalogue.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and continuity.owner_kind = catalogue.owner_kind
      and continuity.owner_id = catalogue.owner_id
      and continuity.permission_id = catalogue.permission_id
      and continuity.registration_kind = catalogue.registration_kind
      and continuity.registration_owner_id = catalogue.registration_owner_id
      and continuity.last_processed_registration_revision = registration.revision
      and continuity.state = 'available'
      and continuity.meaning_fingerprint = catalogue.meaning_fingerprint
    where registration.organization_id = context_organization_value
      and registration.state = 'active'
      and (
        projection_live_registration
        or catalogue.application_root_id is not distinct from
          permission_application_value
      )
      and catalogue.owner_kind = permission_owner_kind_value
      and catalogue.owner_id = permission_owner_value
      and catalogue.permission_id = permission_value
  ), current_role_permission as materialized (
    -- A role keeps exactly the meaning it was accepted under: the catalogue entry of the
    -- registration revision named by its permission entry, whatever a later registration changed
    -- in it (fields, scope, action or record type); only accepting the role revision moves it. The
    -- permission must still be registered in the same continuity lineage it was accepted in: a
    -- permission that was withdrawn and registered again starts a new lineage, so no role kind
    -- regains it without acceptance.
    select role.role_id, role.live_revision,
      revision.assignment_policy, revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision,
      accepted as accepted_entry,
      accepted.registration_revision as accepted_registration_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = revision.organization_id
      and permission.role_id = revision.role_id
      and permission.role_revision = revision.revision
    join current_permission as available
      on available.application_root_id is not distinct from
        permission.application_root_id
      and available.owner_kind = permission.owner_kind
      and available.owner_id = permission.owner_id
      and available.permission_id = permission.permission_id
      and available.registration_kind = permission.registration_kind
      and available.registration_owner_id is not distinct from
        permission.registration_owner_id
    cross join lateral vortex_access.accepted_permission_meaning_internal(
      permission.organization_id, permission.application_root_id,
      permission.owner_kind, permission.owner_id, permission.permission_id,
      permission.continuity_revision, permission.accepted_registration_revision,
      permission.meaning_fingerprint
    ) as accepted
    where role.organization_id = context_organization_value
      and revision.lifecycle in ('active', 'acceptance_required')
      and accepted.registration_kind = permission.registration_kind
      and accepted.registration_owner_id is not distinct from permission.registration_owner_id
      and accepted.record_type_id is not distinct from p_record_type_id
      and accepted.action_kind = action_kind_value
      and accepted.named_action is not distinct from named_action_value
  ), route_candidates as (
    select 1 as route_rank, permission.role_id,
      assignment.role_assignment_id, null::uuid as membership_id,
      null::uuid as role_activation_id,
      permission.accepted_entry, permission.accepted_registration_revision,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value)
      ) as path_valid_until
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = context_account_value
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'standing'

    union all

    select 2, permission.role_id, assignment.role_assignment_id,
      membership.membership_id, null::uuid,
      permission.accepted_entry, permission.accepted_registration_revision,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value)
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_value
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'standing'

    union all

    select 3, permission.role_id, assignment.role_assignment_id,
      null::uuid, activation.role_activation_id,
      permission.accepted_entry, permission.accepted_registration_revision,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        activation.expires_at
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = context_account_value
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = context_account_value
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'direct'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= decision_checked_at
      and activation.expires_at > decision_checked_at
      and activation.authority_continuity_revision =
        permission.authority_continuity_revision
      and activation.policy_continuity_revision =
        permission.policy_continuity_revision
      and activation.activation_policy_id = permission.activation_policy_id
      and activation.activation_policy_revision =
        permission.activation_policy_revision
    where permission.assignment_policy = 'activation_required'

    union all

    select 4, permission.role_id, assignment.role_assignment_id,
      membership.membership_id, activation.role_activation_id,
      permission.accepted_entry, permission.accepted_registration_revision,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value),
        activation.expires_at
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = context_account_value
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'group'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= decision_checked_at
      and activation.expires_at > decision_checked_at
      and activation.authority_continuity_revision =
        permission.authority_continuity_revision
      and activation.policy_continuity_revision =
        permission.policy_continuity_revision
      and activation.activation_policy_id = permission.activation_policy_id
      and activation.activation_policy_revision =
        permission.activation_policy_revision
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_value
      and membership.membership_id = activation.membership_id
      and membership.revision = activation.membership_revision
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'activation_required'
  ), granted as materialized (
    -- Every accepted meaning the caller holds through a live path is granted: a caller holding
    -- two roles with different accepted meanings of the permission has both, each with the
    -- earliest deadline of the paths that carry it.
    select distinct on (route.accepted_registration_revision)
      route.accepted_entry as permission_entry, route.path_valid_until
    from route_candidates as route
    order by route.accepted_registration_revision, route.path_valid_until
  ), administered as materialized (
    -- A super administrator is evaluated with the registered meaning.
    select available.permission_entry, context_expires_value as path_valid_until
    from current_permission as available
    where available.matches_request
      and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
        (p_context ->> 'identityId')::uuid, decision_checked_at
      ) is not null
  )
  select granted.permission_entry, granted.path_valid_until from granted
  union all
  select administered.permission_entry, administered.path_valid_until from administered
  union all
  -- Without a live path the registered permission is returned with no deadline, so callers
  -- can tell an unavailable permission from one that is not effective.
  select available.permission_entry, null::timestamptz
  from current_permission as available
  where available.matches_request
    and not exists (select 1 from granted)
    and not exists (select 1 from administered);
end
$function$;

revoke execute on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  ) to vortex_owner;

comment on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  ) is
  'Private current-permission and role-path evidence; null record type selects only non-record permissions. It returns one row per accepted meaning the caller holds through a live role path (never a later registered meaning), the registered meaning for a super administrator, or the registered permission without a deadline when no path is live. A preview request decides the previewed Application''s own permissions from its preview registration, and a permission on a system projection of a used Module from the caller''s live registrations, under whichever Application links that Module. No row authority.';

alter function vortex_access.evaluate_permission_role_path_internal(p_context jsonb, p_checked_at timestamp with time zone, p_permission jsonb, p_action jsonb, p_record_type_id uuid) owner to vortex_owner;

grant execute on function vortex_access.evaluate_permission_role_path_internal(p_context jsonb, p_checked_at timestamp with time zone, p_permission jsonb, p_action jsonb, p_record_type_id uuid) to postgres;

set local role vortex_record_adapter;

create or replace function vortex_record.apply_record_changes(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_action jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  action_mode boolean := p_action is not null;
  receipt_kind text := case when p_action is not null then 'named_action' else 'record_save' end;
  action_owner_kind text;
  action_owner_id uuid;
  action_release_revision bigint;
  action_id_value uuid;
  action_inputs jsonb;
  action_context jsonb;
  original_context_value jsonb;
  action_final_values jsonb := '{}'::jsonb;
  action_creations jsonb := '[]'::jsonb;
  action_creation_occurrence_ids jsonb := '[]'::jsonb;
  action_parents jsonb := '[]'::jsonb;
  action_declared_occurrence_ids jsonb := '[]'::jsonb;
  action_set_field_ids jsonb;
  action_set_fields_seen boolean := false;
  action_events_seen boolean := false;
  subject_write boolean := true;
  subject_written boolean := false;
  result_value jsonb;
  event_loaded jsonb;
  creation_plan jsonb;
  create_targets jsonb;
  creation_count integer := 0;
  preparation_value jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  reduced_final_values jsonb;
  catalogue jsonb;
  closure_value jsonb;
  root_type jsonb;
  root_snapshot jsonb;
  target_type jsonb;
  total_field jsonb;
  dependency_contract jsonb;
  dependency_field_id text;
  relationship_field_id text;
  old_relationship_target jsonb;
  proposed_relationship_target jsonb;
  contributes_to_total boolean := false;
  creation jsonb;
  created_records jsonb := '{}'::jsonb;
  public_created_records jsonb := '{}'::jsonb;
  created_record_tuples jsonb := '[]'::jsonb;
  first_created_record_tuples jsonb := '[]'::jsonb;
  inserted_value jsonb;
  final_created_tuple jsonb;
  saved_tuple jsonb;
  seen_created_ordinals integer[] := array[]::integer[];
  seen_created_ids uuid[] := array[]::uuid[];
  created_ordinal integer;
  created_concurrency_number bigint;
  submitted_field_ids uuid[];
  edge_plan jsonb;
  edge_entry jsonb;
  created_record_id uuid;
  occurrence_id_value uuid;
  copy_plan jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  effective_command_id uuid;
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  receipt_claim jsonb;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  mutation jsonb;
  mutation_value jsonb;
  projection jsonb;
  field_value jsonb;
  relationship_value jsonb;
  person_account_id uuid;
  relationship_changes jsonb := '[]'::jsonb;
  final_values jsonb := '{}'::jsonb;
  value_final_values jsonb := '{}'::jsonb;
  value_submitted_field_ids uuid[] := array[]::uuid[];
  entry_key text;
  entry_value jsonb;
  submitted_field_id uuid;
  relationship_change jsonb;
  increment_for_relationship boolean;
  update_bounds jsonb;
  proposed_field_values jsonb;
  proposed_records jsonb;
  proposed_edges jsonb;
  proposed_facts jsonb;
  target_record_type_id uuid;
  target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  notice_sequence bigint;
  named_relationship_subject_saved boolean := false;
  named_action_receipt_pending boolean := false;
  named_action_receipt_subject_write boolean := false;
  changed_rows integer;
  changed_field_ids uuid[];
  activity_time timestamptz := pg_catalog.statement_timestamp();
  event_kind text;
  event_payload jsonb;
  event_result jsonb;
begin
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  if preview_installation is not null
    and (p_action is not null
      or p_operation in ('delete', 'restore', 'transfer_ownership', 'settings')) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'preview_effect_refused'
    );
  end if;

  -- A lifecycle command is the terminal delete, restore or ownership transfer.
  -- Delete and restore reach here only after their protected preflight has
  -- already run and claimed the record_lifecycle receipt; this operation owns
  -- the one terminal write and completes it. The request role reaches these
  -- branches only through apply_lifecycle_record_changes: a lifecycle command
  -- carries no submitted values, selected group or action, so the named-action
  -- entry can never reach a lifecycle write under an action identity.
  if p_operation in ('delete', 'restore', 'transfer_ownership') then
    if p_action is not null
      or p_selected_group_id is not null
      or p_submitted_values is distinct from '{}'::jsonb then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    return vortex_record.apply_lifecycle_record_changes_internal(
      p_operation, p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_mutations, p_activity_id, p_occurrence_id
    );
  end if;

  -- Settings use the same command entry and one settings mutation. Their
  -- physical row belongs to Identity, so the protected implementation below
  -- performs the specialised write and the common Record effects once.
  if p_operation = 'settings' then
    if p_action is not null
      or p_selected_group_id is not null
      or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_mutations) <> 1
      or pg_catalog.jsonb_typeof(p_mutations -> 0) is distinct from 'object'
      or (p_mutations -> 0 ->> 'kind') is distinct from 'settings'
      or (p_mutations -> 0) - array['kind', 'values']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'values') is distinct from 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    return vortex_record.apply_settings_record_changes_internal(
      p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values,
      p_mutations -> 0 -> 'values', p_activity_id, p_occurrence_id
    );
  end if;

  -- The command is closed: one operation, one subject, one ordered mutation list
  -- of the kinds this operation supports. A create is one create_subject; an
  -- update is one or more set_fields applied in list order.
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_mutations) = 0
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    ))
    or (p_action is not null and p_operation is distinct from 'update') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  if p_action is not null then
    -- A named action names its exact installed action and carries its typed
    -- inputs; the field rules and the facts all follow
    -- from that identity. Nothing about the actor or the organization is read
    -- from it: both come from the verified request context below.
    if pg_catalog.jsonb_typeof(p_action) is distinct from 'object'
      or not (p_action ?& array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs'])
      or p_action - array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs']::text[]
        <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_action -> 'ownerKind') is distinct from 'string'
      or (p_action ->> 'ownerKind') not in ('application', 'module')
      or pg_catalog.jsonb_typeof(p_action -> 'ownerId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'ownerId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'actionId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'actionId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'releaseRevision') is distinct from 'number'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'releaseRevision', 'bigint')
      or pg_catalog.jsonb_typeof(p_action -> 'inputs') is distinct from 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    action_owner_kind := p_action ->> 'ownerKind';
    action_owner_id := (p_action ->> 'ownerId')::uuid;
    action_id_value := (p_action ->> 'actionId')::uuid;
    action_release_revision := (p_action ->> 'releaseRevision')::bigint;
    action_inputs := p_action -> 'inputs';
    if action_release_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  end if;

  if p_action is null then
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or not (mutation ?& array['kind', 'values'])
        or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string'
        or (mutation ->> 'kind') not in ('create_subject', 'set_fields')
        or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;

    if p_operation = 'create' then
      if pg_catalog.jsonb_array_length(p_mutations) <> 1
        or (p_mutations -> 0 ->> 'kind') is distinct from 'create_subject' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    elsif exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
      where item.value ->> 'kind' = 'create_subject'
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  else
    -- A named action's mutation list is closed too: exactly one set_fields on
    -- the subject (possibly empty), the action's creations in authored order,
    -- its relationship copies, the revision-checked derived-total updates of
    -- the other records it moves, and its declared Event identities. Only the
    -- subject-write, creation and parent mutations carry values; a relationship
    -- copy is a statement of intent the database re-derives from the installed
    -- action and its inputs, never an authority it trusts.
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
      if mutation ->> 'kind' = 'set_fields' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or action_set_fields_seen then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_set_fields_seen := true;
        action_final_values := mutation -> 'values';
      elsif mutation ->> 'kind' = 'create_record' then
        if not (mutation ?& array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ])
          or mutation - array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'ordinal') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'ordinal', 'integer')
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'occurrenceId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_creations := action_creations || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'ordinal', mutation -> 'ordinal',
            'recordTypeId', mutation -> 'recordTypeId',
            'values', mutation -> 'values',
            'finalValues', mutation -> 'finalValues'
          )
        );
        action_creation_occurrence_ids := action_creation_occurrence_ids
          || pg_catalog.jsonb_build_array(mutation -> 'occurrenceId');
      elsif mutation ->> 'kind' = 'copy_relationships' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or mutation -> 'values' is distinct from '{}'::jsonb then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
      elsif mutation ->> 'kind' = 'set_derived_fields' then
        if not (mutation ?& array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ])
          or mutation - array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'recordId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'expectedConcurrencyNumber') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'expectedConcurrencyNumber', 'bigint')
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_parents := action_parents || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'recordTypeId', mutation -> 'recordTypeId',
            'recordId', mutation -> 'recordId',
            'expectedConcurrencyNumber', mutation -> 'expectedConcurrencyNumber',
            'finalValues', mutation -> 'finalValues'
          )
        );
      elsif mutation ->> 'kind' = 'announce_events' then
        if not (mutation ?& array['kind', 'occurrenceIds'])
          or mutation - array['kind', 'occurrenceIds']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceIds') is distinct from 'array'
          or action_events_seen
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(mutation -> 'occurrenceIds') as item(value)
            where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
              or not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid')
          ) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_events_seen := true;
        action_declared_occurrence_ids := mutation -> 'occurrenceIds';
      else
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;
    if not action_set_fields_seen then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  original_context_value := pg_catalog.jsonb_build_object(
    'organizationId', organization_id_value,
    'applicationRootId', application_root_id_value,
    'organizationAccountId', actor_id_value,
    'correlationId', correlation_id_value
  );

  creation_count := pg_catalog.jsonb_array_length(action_creations);

  if action_mode then
    -- A replay never re-prepares: an existing receipt short-circuits the
    -- creation plan, the relationship-total preparation and the copy plan, and
    -- the subject step below answers from the stored receipt.
    action_context := vortex_record.resolve_named_action_context_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id
    );
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      creation_plan := vortex_record.named_action_creation_plan_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, action_creations, action_context
      );
      if creation_plan ->> 'outcome' = 'unsupported' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode'
        );
      end if;
      if creation_plan ->> 'outcome' <> 'planned' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused',
          'reasonCode', coalesce(creation_plan ->> 'reasonCode', 'command_invalid')
        );
      end if;
      create_targets := creation_plan -> 'createTargets';

      preparation_value := vortex_record.prepare_named_action_command_totals(
        p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
        p_submitted_values, action_creations, p_activity_id, action_owner_kind,
        action_owner_id, action_release_revision, action_id_value
      );
      if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
        return preparation_value;
      end if;
      if preparation_value ->> 'outcome' = 'defer'
        and vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
        preparation_value := null;
      elsif preparation_value ->> 'outcome' = 'defer' then
        -- With an installed Rule the closure is not computed, so a command that
        -- would move a total must refuse rather than silently skip it. A
        -- create-bearing command already refused inside the preparation, so only
        -- the set/announce shape reaches here.
        catalogue := vortex_record.relationship_total_catalogue_internal();
        if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
          closure_value := vortex_record.discover_relationship_total_closure_internal(
            catalogue, 'update', p_record_type_id, p_record_id, p_submitted_values
          );
          select item.value into root_type
          from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
          where pg_catalog.lower(item.value ->> 'recordTypeId') =
            pg_catalog.lower(p_record_type_id::text);
          select item.value into root_snapshot
          from pg_catalog.jsonb_array_elements(closure_value -> 'records') item(value)
          where item.value ->> 'recordKey' = 'root';
          if root_type is null or root_snapshot is null then
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
            );
          end if;
          for relationship_value, target_type in
            select item.value, target.value
            from pg_catalog.jsonb_array_elements(root_type -> 'relationships') item(value)
            join pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') target(value)
              on vortex_record.relationship_declares_target_internal(
                item.value, (target.value ->> 'recordTypeId')::uuid
              )
            where item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
            order by item.value ->> 'relationshipId', target.value ->> 'recordTypeId'
          loop
            relationship_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
            old_relationship_target := root_snapshot -> 'existingValues' -> relationship_field_id;
            proposed_relationship_target := old_relationship_target;
            if p_submitted_values ? relationship_field_id then
              proposed_relationship_target := p_submitted_values -> relationship_field_id;
            end if;
            if not (
              (pg_catalog.jsonb_typeof(old_relationship_target) = 'object' and
                pg_catalog.lower(old_relationship_target ->> 'recordTypeId') =
                  pg_catalog.lower(target_type ->> 'recordTypeId'))
              or
              (pg_catalog.jsonb_typeof(proposed_relationship_target) = 'object' and
                pg_catalog.lower(proposed_relationship_target ->> 'recordTypeId') =
                  pg_catalog.lower(target_type ->> 'recordTypeId'))
            ) then
              continue;
            end if;
            for total_field in
              select field.value
              from pg_catalog.jsonb_array_elements(target_type -> 'fields') field(value)
              where field.value ->> 'type' = 'total'
                and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
                  pg_catalog.lower(relationship_value ->> 'relationshipId')
            loop
              if p_submitted_values ? relationship_field_id and
                p_submitted_values -> relationship_field_id is distinct from
                  coalesce(root_snapshot -> 'existingValues' -> relationship_field_id, 'null'::jsonb) then
                contributes_to_total := true;
                exit;
              end if;
              dependency_contract := vortex_record.total_dependency_contract_internal(
                catalogue -> 'recordTypes',
                pg_catalog.jsonb_build_array(relationship_value),
                (target_type ->> 'recordTypeId')::uuid, total_field
              );
              for dependency_field_id in
                select item.value
                from pg_catalog.jsonb_array_elements_text(
                  dependency_contract -> 'sourceFieldIds'
                ) item(value)
              loop
                if action_final_values ? dependency_field_id and
                  action_final_values -> dependency_field_id is distinct from
                    coalesce(root_snapshot -> 'existingValues' -> dependency_field_id, 'null'::jsonb) then
                  contributes_to_total := true;
                  exit;
                end if;
              end loop;
              exit when contributes_to_total;
            end loop;
            exit when contributes_to_total;
          end loop;
          if contributes_to_total then
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
            );
          end if;
        end if;
      end if;

      if preparation_value ->> 'outcome' is distinct from 'prepared' then
        if pg_catalog.jsonb_array_length(action_parents) = 0 then
          preparation_value := null;
        else
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      else
        select coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'recordTypeId', item.value -> 'recordTypeId',
            'recordId', item.value -> 'recordId',
            'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
            'finalFieldIds', coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.lower(field.value ->> 'fieldId')
                order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
              )
              from pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
              where field.value ->> 'type' in ('total', 'calculation')
            ), '[]'::jsonb)
          ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
        ), '[]'::jsonb) into expected_parents
        from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
        where item.value ->> 'recordKey' <> 'root'
          and pg_catalog.left(item.value ->> 'recordKey', 7) <> 'create:';
        select coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'recordTypeId', item.value -> 'recordTypeId',
            'recordId', item.value -> 'recordId',
            'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
            'finalFieldIds', coalesce((
              select pg_catalog.jsonb_agg(field_id order by field_id collate "C")
              from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') field(field_id)
            ), '[]'::jsonb)
          ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
        ), '[]'::jsonb) into supplied_parents
        from pg_catalog.jsonb_array_elements(action_parents) item(value)
        where pg_catalog.jsonb_typeof(item.value) = 'object'
          and item.value ?& array[
            'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]
          and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
        if supplied_parents is distinct from expected_parents
          or pg_catalog.jsonb_array_length(supplied_parents) <>
            pg_catalog.jsonb_array_length(action_parents) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      end if;
    end if;

    -- The target row and every linked row of a relationship copy are locked
    -- here, before the counters and data versions below and before any edge
    -- identity, so the lock classes keep their order. A replay copies nothing.
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, action_inputs, action_context
      );
      if copy_plan ->> 'outcome' = 'refused' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode'
        );
      end if;
    end if;
    -- Take every created record's reference-number counter (L4), then the data
    -- version of the subject's and every created record's storage scope, before
    -- the subject step writes the subject's relationship edges (L6), matching
    -- ordinary create's row, counter, data version, edge order.
    if creation_count > 0 and create_targets is not null then
      perform vortex_record.reserve_named_action_creation_locks_internal(
        p_record_type_id, action_creations
      );
    end if;

    if coalesce((action_context ->> 'rulesUnsupported')::boolean, false)
      or pg_catalog.jsonb_typeof(action_context -> 'action' -> 'tasks') is distinct from 'array'
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(
          action_context -> 'action' -> 'tasks'
        ) task(value)
        where task.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'unsupported');
    end if;
    select coalesce(pg_catalog.jsonb_agg(field_id order by field_id collate "C"), '[]'::jsonb)
    into action_set_field_ids
    from (
      select distinct pg_catalog.lower(key.field_key) as field_id
      from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks') task(value)
      cross join lateral pg_catalog.jsonb_object_keys(
        task.value -> 'properties' -> 'values'
      ) key(field_key)
      where task.value ->> 'type' = 'record.set_fields'
    ) fields;
    if action_set_field_ids is distinct from coalesce((
        select pg_catalog.jsonb_agg(key order by key collate "C")
        from pg_catalog.jsonb_object_keys(p_submitted_values) key
      ), '[]'::jsonb)
      or pg_catalog.jsonb_array_length(action_context -> 'eventDescriptors') <>
        pg_catalog.jsonb_array_length(action_declared_occurrence_ids)
      or pg_catalog.jsonb_array_length(action_creation_occurrence_ids) <> creation_count then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    -- A create-only action whose created record moves one of the subject's own
    -- totals still has to write the subject, so the subject is written whenever
    -- a record.set_fields task exists or the final-value map is non-empty.
    subject_write := pg_catalog.jsonb_array_length(action_set_field_ids) > 0
      or action_final_values <> '{}'::jsonb;
  end if;

  <<subject_step>>
  begin
  if action_mode and not subject_write then
    -- The announce-only shape: the action writes nothing to the subject, so its
    -- receipt, Activity and declared Events are the whole subject step.
    loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_named_action_activity_internal(
        p_activity_id, p_record_id, array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
    end if;
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, false
    );
    if receipt_claim ->> 'status' is distinct from 'claimed' then
      if receipt_claim ->> 'status' = 'identity_conflict' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
        );
      end if;
      if receipt_claim ->> 'status' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object('outcome', 'conflict');
      end if;
      return vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end if;
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'completed'
    );
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(action_declared_occurrence_ids)
        with ordinality expected(value, ordinal) using (ordinal)
      where pg_catalog.jsonb_typeof(appended.value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(appended.value -> 'occurrenceId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(
          appended.value ->> 'occurrenceId', 'uuid'
        ), true)
        or (appended.value ->> 'occurrenceId')::uuid is distinct from
          (expected.value #>> '{}')::uuid
    ) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if creation_count = 0 then
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, p_record_id, p_expected_concurrency_number,
        'Named action receipt is stale'
      );
    else
      named_action_receipt_pending := true;
    end if;
    result_value := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id
    );
    if result_value ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    result_value := result_value || pg_catalog.jsonb_build_object('replayed', false);
    exit subject_step;
  end if;

  if action_mode then
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, false
    );
  else
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', effective_command_id, false
    );
  end if;
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if action_mode then
      projection := vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if projection ->> 'outcome' <> 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    else
      projection := vortex_record.read_record(
        p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if projection ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  if action_mode then
    meta := action_context;
  else
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, p_operation
    );
  end if;
  if pg_catalog.jsonb_typeof(meta -> 'recordType') <> 'object' then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  -- Collapse the ordered mutation list into one final value map. A create_subject
  -- starts the map; each set_fields in list order overrides the fields it names.
  -- A named action already carries its single subject set_fields as the map.
  if action_mode then
    final_values := action_final_values;
  else
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      mutation_value := mutation -> 'values';
      if mutation ->> 'kind' = 'create_subject' then
        final_values := mutation_value;
      else
        final_values := final_values || mutation_value;
      end if;
    end loop;
  end if;

  -- Classify every final value against the exact installed Record definition.
  -- Link values remain relationship changes; only ordinary value fields reach
  -- the fixed column writer on update. Each supported link has exactly one
  -- declared fixed to-one relationship owned by this source Record type.
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(final_values) as entry(key, value)
  loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where pg_catalog.lower(item.value ->> 'fieldId') = entry_key;
    if not found then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' = 'link_to_person'
      and pg_catalog.jsonb_typeof(entry_value) <> 'null' then
      if not vortex_record.canonical_record_value_matches(entry_value, 'link_to_person', 'json') then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'person_reference_unavailable', 'fieldId', entry_key
        );
      end if;
      person_account_id := (entry_value ->> 'organizationAccountId')::uuid;
      if coalesce(field_value #>> '{settings,audience}', '') not in (
          'organization_accounts', 'application_accounts',
          'organization_identities_and_external_requesters'
        )
        or not vortex_access.lock_active_record_ownership_target_internal(
          'organization_account', person_account_id
        )
        or ((field_value #>> '{settings,audience}' = 'application_accounts'
            or coalesce((field_value #>> '{settings,applicationRootIdRequired}')::boolean, false))
          and not vortex_access.organization_account_has_current_application_access_internal(
            organization_id_value, person_account_id, application_root_id_value
          )) then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'person_reference_unavailable', 'fieldId', entry_key
        );
      end if;
    end if;
    if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
      where (item.value ->> 'fromRecordTypeId')::uuid = p_record_type_id
        and pg_catalog.lower(item.value ->> 'fromFieldId') = entry_key;
      if not found
        or not (relationship_value ? case field_value ->> 'type'
          when 'link' then 'toRecordType' else 'toRecordTypes' end)
        or relationship_value ->> 'cardinality' not in ('one_to_one', 'many_to_one') then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_shape_unsupported'
        );
      end if;
      relationship_changes := relationship_changes || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'fieldId', entry_key,
          'relationshipId', relationship_value -> 'relationshipId',
          'relationship', relationship_value,
          'value', entry_value
        )
      );
    else
      value_final_values := value_final_values
        || pg_catalog.jsonb_build_object(entry_key, entry_value);
    end if;
  end loop;

  foreach submitted_field_id in array array(
    select key::uuid
    from pg_catalog.jsonb_object_keys(p_submitted_values) as key
    order by key::uuid
  ) loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where (item.value ->> 'fieldId')::uuid = submitted_field_id;
    if not found then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
      value_submitted_field_ids := pg_catalog.array_append(
        value_submitted_field_ids, submitted_field_id
      );
    elsif not exists (
      select 1
      from pg_catalog.jsonb_array_elements(relationship_changes) as change(value)
      where (change.value ->> 'fieldId')::uuid = submitted_field_id
    ) then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_value_unavailable'
      );
    end if;
  end loop;

  if p_operation = 'update' then
    if action_mode then
      loaded := vortex_record.load_named_action_facts_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
      );
    else
      loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
      );
    end if;
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or (preview_installation is null
        and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object') then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        meta -> 'declaration', p_record_id,
        (loaded -> 'facts') || pg_catalog.jsonb_build_object(
          'binding', meta -> 'declaration' -> 'recordBinding'
        )
      );
      if decision ->> 'outcome' = 'refused' then
        if action_mode then
          activity_time := vortex_record.append_named_action_activity_internal(
            p_activity_id, p_record_id, array[]::uuid[], 'refused'
          );
        else
          activity_time := vortex_record.append_base_save_activity_internal(
            p_activity_id, 'update', organization_id_value,
            array[]::uuid[], 'refused'
          );
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable'
        );
      elsif decision ->> 'outcome' <> 'allowed' then
        raise exception using errcode = '42501',
          message = 'Record save authority is unavailable';
      end if;
      update_bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      update_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if update_bounds is null then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          update_bounds -> 'changeableFieldIds'
        ) as allowed(value)
        where pg_catalog.lower(allowed.value) =
          pg_catalog.lower(relationship_change ->> 'fieldId')
      ) then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'field_not_changeable'
        );
      end if;
    end loop;

    -- Build the complete proposed source facts before the first mutation. A
    -- changed fixed relationship replaces its old edge; the exact validated
    -- target's private facts are loaded only inside this operation and are
    -- never returned. The same current update declaration must still allow the
    -- source under the complete proposed values and graph.
    proposed_field_values := (loaded -> 'fieldValues') || final_values;
    proposed_records := loaded -> 'facts' -> 'records';
    proposed_edges := loaded -> 'facts' -> 'edges';

    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'null' then
        if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'object'
          or not ((relationship_change -> 'value') ?& array['recordTypeId', 'recordId'])
          or (relationship_change -> 'value') - array['recordTypeId', 'recordId'] <> '{}'::jsonb
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordTypeId', 'uuid'
          )
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordId', 'uuid'
          )
          or (relationship_change -> 'value' ->> 'recordTypeId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid
          or (relationship_change -> 'value' ->> 'recordId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_record_type_id := (relationship_change -> 'value' ->> 'recordTypeId')::uuid;
        target_record_id := (relationship_change -> 'value' ->> 'recordId')::uuid;
        if not vortex_record.relationship_declares_target_internal(
          relationship_change -> 'relationship', target_record_type_id
        ) then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        target_loaded := vortex_record.load_record_access_facts_internal(
          target_record_type_id, 'read', target_record_id, null, null::jsonb
        );
        if target_loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        -- Only a record of this application's own Module uses preview-owner authority.
        -- Borrowed records and live projections still need the builder's current permission.
        if preview_installation is not null
          and target_loaded ->> 'previewInstallationId' = preview_installation ->> 'previewInstallationId'
          and exists (
            select 1 from vortex_definition.roots as root
            where root.root_id = (target_loaded #>> '{recordTypeMeta,moduleRootId}')::uuid
              and root.owner_application_root_id = application_root_id_value
          ) then
          target_decision := pg_catalog.jsonb_build_object('outcome', 'allowed');
        else
          target_decision := vortex_access.evaluate_organization_record_access_internal(
            pg_catalog.jsonb_set(target_loaded -> 'declaration', '{authority}',
              '{"kind":"permission"}'::jsonb), target_record_id, target_loaded -> 'facts'
          );
        end if;
        if target_decision ->> 'outcome' <> 'allowed' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
        proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');
      end if;
    end loop;

    -- The one canonical lock prelude: every changed link's target row is
    -- share-locked in relationship identity order here, after each target has
    -- passed the same access decision the writer re-checks and before any
    -- source data version or relationship edge identity is taken. Keeping all
    -- target row locks in one place replaces the per-writer #858 corrections.
    perform vortex_record.lock_record_change_targets_internal(
      meta -> 'recordType', organization_id_value, final_values
    );

    -- Target closures may reach the source through a currently permitted
    -- relationship route. Assemble all trusted closures first, then make the
    -- source authoritative exactly once so an old source copy cannot compete
    -- with the proposed values. Other repeated closure records are collapsed by
    -- their permanent Record identity.
    proposed_records := coalesce((
      select pg_catalog.jsonb_agg(
        case when unique_record.record_id = p_record_id
          then unique_record.value || pg_catalog.jsonb_build_object(
            'fieldValues', proposed_field_values
          )
          else unique_record.value end
        order by unique_record.record_id
      )
      from (
        select distinct on (
          (record.value -> 'recordScope' ->> 'recordId')::uuid
        )
          (record.value -> 'recordScope' ->> 'recordId')::uuid as record_id,
          record.value
        from pg_catalog.jsonb_array_elements(proposed_records) as record(value)
        order by (record.value -> 'recordScope' ->> 'recordId')::uuid,
          record.value::text collate "C"
      ) as unique_record
    ), '[]'::jsonb);

    -- Apply every changed fixed relationship after closure assembly. This one
    -- replacement pass removes old source edges even when a target closure
    -- contained them, then adds only the submitted non-null replacements.
    proposed_edges := coalesce((
      with retained_edges as (
        select edge.value
        from pg_catalog.jsonb_array_elements(proposed_edges) as edge(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
          where (changed.value ->> 'relationshipId')::uuid =
              (edge.value ->> 'relationshipId')::uuid
            and (edge.value ->> 'fromRecordId')::uuid = p_record_id
        )
      ), replacement_edges as (
        select pg_catalog.jsonb_build_object(
          'relationshipId', changed.value -> 'relationshipId',
          'fromRecordId', p_record_id,
          'toRecordId', (changed.value -> 'value' ->> 'recordId')::uuid
        ) as value
        from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
        where pg_catalog.jsonb_typeof(changed.value -> 'value') <> 'null'
      ), unique_edges as (
        select distinct candidate.value
        from (
          select retained.value from retained_edges as retained
          union all
          select replacement.value from replacement_edges as replacement
        ) as candidate(value)
      )
      select pg_catalog.jsonb_agg(unique_edge.value order by unique_edge.value)
      from unique_edges as unique_edge
    ), '[]'::jsonb);

    proposed_facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'records', proposed_records,
      'edges', proposed_edges
    );
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, proposed_facts
      );
      if decision ->> 'outcome' <> 'allowed' then
        if action_mode then
          activity_time := vortex_record.append_named_action_activity_internal(
            p_activity_id, p_record_id, array[]::uuid[], 'refused'
          );
        else
          activity_time := vortex_record.append_base_save_activity_internal(
            p_activity_id, 'update', organization_id_value,
            array[]::uuid[], 'refused'
          );
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'proposed_record_refused'
        );
      end if;
    end if;
  end if;

  if p_operation = 'create' then
    mutation := vortex_record.create_record_internal(
      p_record_type_id, final_values,
      array(
        select key::uuid from pg_catalog.jsonb_object_keys(p_submitted_values) as key
        order by key::uuid
      ), p_selected_group_id
    );
  else
    if final_values = '{}'::jsonb then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'empty_base_update'
      );
    end if;
    if value_final_values <> '{}'::jsonb then
      if action_mode then
        mutation := vortex_record.change_record_by_named_action_internal(
          p_record_type_id, p_record_id, p_expected_concurrency_number,
          value_final_values, value_submitted_field_ids,
          action_owner_kind, action_owner_id, action_release_revision, action_id_value
        );
      else
        mutation := vortex_record.change_record(
          p_record_type_id, p_record_id, p_expected_concurrency_number,
          value_final_values, value_submitted_field_ids
        );
      end if;
      increment_for_relationship := false;
    elsif not action_mode
      and preview_installation is null
      and meta ->> 'storageScope' = 'application_contained'
      and pg_catalog.jsonb_array_length(relationship_changes) > 0 then
      mutation := vortex_record.change_record(
        p_record_type_id, p_record_id, p_expected_concurrency_number,
        value_final_values, value_submitted_field_ids
      );
      increment_for_relationship := false;
    elsif action_mode
      and p_operation = 'update'
      and preview_installation is null
      and meta ->> 'storageScope' = 'application_contained'
      and pg_catalog.jsonb_array_length(relationship_changes) > 0
      and creation_count = 0
      and pg_catalog.jsonb_typeof(action_parents) = 'array'
      and pg_catalog.jsonb_array_length(action_parents) = 0
      and (case
        when copy_plan is null then true
        when pg_catalog.jsonb_typeof(copy_plan) = 'object'
          and copy_plan ->> 'outcome' = 'planned'
          and pg_catalog.jsonb_typeof(copy_plan -> 'copies') = 'array'
          then pg_catalog.jsonb_array_length(copy_plan -> 'copies') = 0
        else false
      end)
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks') task(value)
        where task.value ->> 'type' = 'record.delete'
      ) then
      -- The named declaration and proposed graph already passed their protected
      -- decisions and target locks. Save one actual subject tuple before edges.
      execute pg_catalog.format(
        'update record_data.%I as stored
         set concurrency_number = stored.concurrency_number + 1,
           updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
           definition_revision = $4
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.concurrency_number = $5
         returning stored.record_id, stored.concurrency_number',
        loaded ->> 'table'
      ) into saved_record_id, saved_concurrency_number
      using organization_id_value, p_record_id, actor_id_value,
        (loaded ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
      get diagnostics changed_rows = row_count;
      if changed_rows <> 1 then
        raise exception using errcode = '40001',
          message = 'Named relationship change did not apply to exactly one row';
      end if;
      if saved_record_id is distinct from p_record_id
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency_number is null
        or saved_concurrency_number not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Named relationship saved identity is unavailable';
      end if;
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', saved_record_id,
        'concurrencyNumber', saved_concurrency_number
      );
      named_relationship_subject_saved := true;
      increment_for_relationship := false;
    else
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', p_record_id,
        'concurrencyNumber', p_expected_concurrency_number + 1
      );
      increment_for_relationship := true;
    end if;

    if mutation ->> 'outcome' in ('completed', 'allowed') then
      for relationship_change in
        select item.value
        from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
        order by (item.value ->> 'relationshipId')::uuid
      loop
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, p_record_id,
          (relationship_change ->> 'relationshipId')::uuid,
          relationship_change -> 'value', increment_for_relationship
        );
        increment_for_relationship := false;
      end loop;
    end if;
  end if;

  if mutation ->> 'outcome' not in ('completed', 'allowed') then
    if preview_installation is null
      and p_operation = 'create' and mutation ->> 'reasonCode' = 'access_refused' then
      activity_time := vortex_record.append_base_save_activity_internal(
        p_activity_id, 'create', organization_id_value,
        array[]::uuid[], 'refused'
      );
      mutation := mutation || pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded'
      );
    end if;
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return mutation;
  end if;

  saved_record_id := (mutation ->> 'recordId')::uuid;
  saved_concurrency_number := (mutation ->> 'concurrencyNumber')::bigint;
  perform vortex_record.mirror_person_links_internal(
    (meta ->> 'storageContractId')::uuid, organization_id_value,
    saved_record_id, final_values
  );
  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(
    case when p_operation = 'create' then mutation -> 'values'
      else final_values end
  ) as key;

  if action_mode then
    activity_time := vortex_record.append_named_action_activity_internal(
      p_activity_id, saved_record_id, changed_field_ids, 'completed'
    );
  elsif preview_installation is null then
    activity_time := vortex_record.append_base_save_activity_internal(
      p_activity_id, p_operation, saved_record_id,
      changed_field_ids, 'completed'
    );
  end if;

  if preview_installation is null then
    event_kind := case when p_operation = 'create' then 'created' else 'changed' end;
    event_payload := case when p_operation = 'create'
      then pg_catalog.jsonb_build_object('kind', 'created')
      else pg_catalog.jsonb_build_object(
        'kind', 'changed',
        'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      ) end;
    event_result := vortex_platform.append_record_occurrences(
      (meta ->> 'storageContractId')::uuid,
      saved_record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', event_kind,
          'recordTypeId', p_record_type_id
        ),
        'payload', event_payload
      ))
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
  end if;

  if action_mode and creation_count > 0 then
    named_action_receipt_pending := true;
    named_action_receipt_subject_write := true;
  else
    perform vortex_record.complete_command_receipt_internal(
      receipt_kind, effective_command_id, saved_record_id, saved_concurrency_number,
      'Record save receipt is stale'
    );
  end if;

  if action_mode then
    projection := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, saved_record_id
    );
    if projection ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    subject_written := true;
  else
    projection := vortex_record.read_record(p_record_type_id, saved_record_id);
    if projection ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '55000',
        message = 'Saved Record projection is unavailable';
    end if;
  end if;
  result_value := pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', case when preview_installation is null
      then 'pending' else 'none' end,
    'replayed', false
  );
  end subject_step;

  if not action_mode then
    if preview_installation is null
      and p_operation = 'update'
      and (
        value_final_values <> '{}'::jsonb
        or pg_catalog.jsonb_array_length(relationship_changes) > 0
      )
      and meta ->> 'storageScope' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          saved_record_id, saved_concurrency_number, 'changed',
          notice_sequence, notice_sequence, correlation_id_value
        );
      exception
        when others then
          -- Invalidation is advisory; a lost notice must not refuse the save.
          null;
      end;
    end if;
    return result_value;
  end if;

  -- The declared Events of a subject-writing action are appended against the
  -- values the subject was left with; an announce-only action appended its own
  -- in its subject step.
  if subject_written then
    event_loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id,
      (result_value ->> 'concurrencyNumber')::bigint
    );
    if event_loaded ->> 'outcome' <> 'loaded' then
      raise exception using errcode = '55000',
        message = 'Named action Event values are unavailable';
    end if;
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      event_loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(action_declared_occurrence_ids)
        with ordinality expected(value, ordinal) using (ordinal)
      where pg_catalog.jsonb_typeof(appended.value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(appended.value -> 'occurrenceId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(
          appended.value ->> 'occurrenceId', 'uuid'
        ), true)
        or (appended.value ->> 'occurrenceId')::uuid is distinct from
          (expected.value #>> '{}')::uuid
    ) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
  end if;

  if creation_count > 0 then
    if create_targets is null then
      raise exception using errcode = '55000',
        message = 'Named action creation plan is unavailable';
    end if;

    -- Every insert, in authored task order, before any edge. Each allocates
    -- its reference numbers (L4); keeping the whole set ahead of the edge pass
    -- is what matches ordinary create's counter-before-edge order.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(action_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_field_ids
      from pg_catalog.jsonb_object_keys(creation -> 'values') as key;
      inserted_value := vortex_record.insert_named_action_record_internal(
        (creation ->> 'recordTypeId')::uuid, creation -> 'finalValues', submitted_field_ids
      );
      perform vortex_record.mirror_person_links_internal(
        (inserted_value ->> 'storageContractId')::uuid, organization_id_value,
        (inserted_value ->> 'recordId')::uuid, inserted_value -> 'values'
      );
      created_records := created_records || pg_catalog.jsonb_build_object(
        creation ->> 'ordinal', inserted_value
      );
    end loop;

    -- Every edge, in one canonical order across all creations: by relationship,
    -- then target, matching the ascending relationship edge identity order every
    -- ordinary writer loop uses.
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ordinal', entry.ordinal,
        'sourceRecordTypeId', entry.source_record_type_id,
        'relationshipId', entry.relationship_id,
        'value', entry.target_value
      )
      order by entry.relationship_id, entry.target_record_id, entry.ordinal
    ), '[]'::jsonb)
    into edge_plan
    from (
      select (creation_item.value ->> 'ordinal')::integer as ordinal,
        (creation_item.value ->> 'recordTypeId')::uuid as source_record_type_id,
        (relationship_item.value ->> 'relationshipId')::uuid as relationship_id,
        pg_catalog.lower(relationship_item.value ->> 'fromFieldId') as from_field_id,
        (creation_item.value -> 'values'
          -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId')) as target_value,
        (creation_item.value -> 'values'
          -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId') ->> 'recordId')::uuid
          as target_record_id
      from pg_catalog.jsonb_array_elements(action_creations) creation_item(value)
      join pg_catalog.jsonb_array_elements(create_targets) target_item(value)
        on (target_item.value ->> 'ordinal')::integer =
          (creation_item.value ->> 'ordinal')::integer
      join pg_catalog.jsonb_array_elements(
        target_item.value -> 'recordType' -> 'relationships'
      ) relationship_item(value) on true
      where (creation_item.value -> 'values') ?
        pg_catalog.lower(relationship_item.value ->> 'fromFieldId')
        and pg_catalog.jsonb_typeof(
          creation_item.value -> 'values'
            -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId')
        ) = 'object'
    ) entry;

    for edge_entry in
      select item.value
      from pg_catalog.jsonb_array_elements(edge_plan) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      perform vortex_record.write_named_action_relationship_value_internal(
        (edge_entry ->> 'sourceRecordTypeId')::uuid,
        (created_records -> (edge_entry ->> 'ordinal') ->> 'recordId')::uuid,
        (edge_entry ->> 'relationshipId')::uuid,
        edge_entry -> 'value',
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end loop;

    -- Reauthorize the complete new graph before any created-row Activity or
    -- Event is visible. This barrier is intentionally whole-command, not per row.
    first_created_record_tuples :=
      vortex_record.authorize_created_records_for_command_internal(
        action_creations, created_records, original_context_value
      );
    if pg_catalog.jsonb_typeof(first_created_record_tuples) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action creation authority result is incomplete';
    end if;
    if pg_catalog.jsonb_array_length(first_created_record_tuples) is distinct from creation_count then
      raise exception using errcode = '55000',
        message = 'Named action creation authority result is incomplete';
    end if;

    -- Append each created-row Activity and its standard Event only after the
    -- complete set passed ordinary CREATE authorization.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(action_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      inserted_value := created_records -> (creation ->> 'ordinal');
      created_record_id := (inserted_value ->> 'recordId')::uuid;
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into changed_field_ids
      from pg_catalog.jsonb_object_keys(inserted_value -> 'values') as key;
      perform vortex_record.append_named_action_activity_internal(
        pg_catalog.gen_random_uuid(), created_record_id, changed_field_ids, 'completed'
      );
      select (item.value #>> '{}')::uuid into occurrence_id_value
      from pg_catalog.jsonb_array_elements(action_creation_occurrence_ids)
        with ordinality item(value, ordinality)
      where item.ordinality = (
        select position.ordinality
        from pg_catalog.jsonb_array_elements(action_creations) with ordinality position(value, ordinality)
        where (position.value ->> 'ordinal')::integer = (creation ->> 'ordinal')::integer
      );
      if occurrence_id_value is null then
        raise exception using errcode = '22023',
          message = 'Named action creation occurrence is invalid';
      end if;
      event_result := vortex_platform.append_record_occurrences(
        (inserted_value ->> 'storageContractId')::uuid, created_record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', occurrence_id_value,
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard', 'eventKind', 'created',
            'recordTypeId', (creation ->> 'recordTypeId')::uuid
          ),
          'payload', pg_catalog.jsonb_build_object('kind', 'created')
        ))
      );
      if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
      if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
      if pg_catalog.jsonb_typeof(event_result -> 0) is distinct from 'object'
        or event_result -> 0 ->> 'occurrenceId' is distinct from occurrence_id_value::text then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
    end loop;
  end if;

  if copy_plan is not null then
    perform vortex_record.apply_named_action_relationship_copies_internal(copy_plan);
  end if;

  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(action_parents) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    select item.value into strict prepared_parent
    from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
    where item.value ->> 'recordTypeId' = parent_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = parent_value ->> 'recordId';
    select coalesce(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into reduced_final_values
    from pg_catalog.jsonb_each(parent_value -> 'finalValues') entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_parent -> 'existingValues' -> entry.key, 'null'::jsonb
    );
    perform vortex_record.apply_relationship_total_parent_internal(
      (parent_value ->> 'recordTypeId')::uuid,
      (parent_value ->> 'recordId')::uuid,
      (parent_value ->> 'expectedConcurrencyNumber')::bigint,
      reduced_final_values
    );
  end loop;

  if creation_count > 0 then
    -- Re-load and reauthorize the entire graph after every mandatory created-row,
    -- copy and parent effect. These actual final target tuples drive both receipt
    -- completion and the narrow advisory created-notice attempts below.
    created_record_tuples := vortex_record.authorize_created_records_for_command_internal(
      action_creations, created_records, original_context_value
    );
    if pg_catalog.jsonb_typeof(created_record_tuples) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action final creation authority is incomplete';
    end if;
    if pg_catalog.jsonb_array_length(created_record_tuples) is distinct from creation_count then
      raise exception using errcode = '55000',
        message = 'Named action final creation authority is incomplete';
    end if;
    for final_created_tuple in
      select item.value
      from pg_catalog.jsonb_array_elements(created_record_tuples) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(final_created_tuple) is distinct from 'object'
        or not (final_created_tuple ?& array[
          'ordinal', 'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
          'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
          'storageScope', 'correlationId', 'eligible'
        ])
        or final_created_tuple - array[
          'ordinal', 'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
          'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
          'storageScope', 'correlationId', 'eligible'
        ]::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'ordinal') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'ordinal', 'integer'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'recordId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'recordId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'concurrencyNumber') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'concurrencyNumber', 'bigint'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'organizationId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'organizationId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'applicationRootId') not in ('string', 'null')
        or (pg_catalog.jsonb_typeof(final_created_tuple -> 'applicationRootId') = 'string'
          and coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'applicationRootId', 'uuid'), true))
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'moduleRootId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'moduleRootId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'recordTypeId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'recordTypeId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'storageContractId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'storageContractId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'moduleReleaseRevision') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'moduleReleaseRevision', 'bigint'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'storageScope') is distinct from 'string'
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'correlationId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'correlationId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'eligible') is distinct from 'boolean' then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple is malformed';
      end if;
      created_ordinal := (final_created_tuple ->> 'ordinal')::integer;
      created_record_id := (final_created_tuple ->> 'recordId')::uuid;
      created_concurrency_number := (final_created_tuple ->> 'concurrencyNumber')::bigint;
      if created_ordinal < 0
        or created_ordinal = any (seen_created_ordinals)
        or created_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or created_record_id = any (seen_created_ids)
        or created_concurrency_number not between 1 and 9007199254740991
        or (final_created_tuple ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
        or (final_created_tuple ->> 'organizationId')::uuid is distinct from organization_id_value
        or (final_created_tuple ->> 'correlationId')::uuid is distinct from correlation_id_value
        or (final_created_tuple ->> 'storageScope') not in ('application_contained', 'organization_shared')
        or ((final_created_tuple ->> 'storageScope') = 'application_contained'
          and (final_created_tuple ->> 'applicationRootId')::uuid is distinct from application_root_id_value)
        or ((final_created_tuple ->> 'storageScope') = 'organization_shared'
          and final_created_tuple -> 'applicationRootId' is distinct from 'null'::jsonb)
        or (final_created_tuple ->> 'eligible')::boolean is distinct from
          ((final_created_tuple ->> 'storageScope') = 'application_contained') then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple is invalid';
      end if;
      inserted_value := created_records -> created_ordinal::text;
      saved_tuple := inserted_value -> '_savedTuple';
      if inserted_value is null
        or final_created_tuple -> 'recordId' is distinct from inserted_value -> 'recordId'
        or final_created_tuple -> 'organizationId' is distinct from saved_tuple -> 'organizationId'
        or final_created_tuple -> 'applicationRootId' is distinct from saved_tuple -> 'applicationRootId'
        or final_created_tuple -> 'moduleRootId' is distinct from saved_tuple -> 'moduleRootId'
        or final_created_tuple -> 'recordTypeId' is distinct from saved_tuple -> 'recordTypeId'
        or final_created_tuple -> 'storageContractId' is distinct from saved_tuple -> 'storageContractId'
        or final_created_tuple -> 'moduleReleaseRevision' is distinct from saved_tuple -> 'moduleReleaseRevision'
        or final_created_tuple -> 'storageScope' is distinct from saved_tuple -> 'storageScope'
        or final_created_tuple -> 'correlationId' is distinct from saved_tuple -> 'correlationId'
        or final_created_tuple -> 'eligible' is distinct from saved_tuple -> 'eligible' then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple changed';
      end if;
      seen_created_ordinals := pg_catalog.array_append(seen_created_ordinals, created_ordinal);
      seen_created_ids := pg_catalog.array_append(seen_created_ids, created_record_id);
      public_created_records := public_created_records || pg_catalog.jsonb_build_object(
        created_ordinal::text, pg_catalog.jsonb_build_object(
          'recordId', inserted_value -> 'recordId',
          'storageContractId', inserted_value -> 'storageContractId',
          'values', inserted_value -> 'values'
        )
      );
    end loop;
    if pg_catalog.cardinality(seen_created_ordinals) <> creation_count
      or pg_catalog.cardinality(seen_created_ids) <> creation_count then
      raise exception using errcode = '55000',
        message = 'Named action final creation set is incomplete';
    end if;

    if not named_action_receipt_pending then
      raise exception using errcode = '55000',
        message = 'Named action receipt completion is unavailable';
    end if;
    if named_action_receipt_subject_write then
      if saved_record_id is null
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency_number is null
        or saved_concurrency_number not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Named action receipt completion tuple is unavailable';
      end if;
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, saved_record_id, saved_concurrency_number,
        'Record save receipt is stale'
      );
    else
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, p_record_id, p_expected_concurrency_number,
        'Named action receipt is stale'
      );
    end if;
    named_action_receipt_pending := false;
  end if;

  -- Only the new created-row notice attempt is advisory. All tuple and context
  -- validation above is outside this per-tuple catch; allocation, safe sequence
  -- validation and exact publication share one narrow failure boundary.
  for final_created_tuple in
    select item.value from pg_catalog.jsonb_array_elements(created_record_tuples) item(value)
  loop
    if (final_created_tuple ->> 'eligible')::boolean then
      created_record_id := (final_created_tuple ->> 'recordId')::uuid;
      created_concurrency_number := (final_created_tuple ->> 'concurrencyNumber')::bigint;
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
          raise exception using errcode = '22003',
            message = 'Created Record notice sequence is unavailable';
        end if;
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value,
          (final_created_tuple ->> 'recordTypeId')::uuid,
          created_record_id, created_concurrency_number, 'created',
          notice_sequence, notice_sequence, correlation_id_value
        );
      exception when others then
        null;
      end;
    end if;
  end loop;
  if named_relationship_subject_saved then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_platform.publish_change_notice(
        organization_id_value, application_root_id_value, p_record_type_id,
        saved_record_id, saved_concurrency_number, 'changed',
        notice_sequence, notice_sequence, correlation_id_value
      );
    exception when others then
      -- Invalidation is advisory after the protected named action is complete.
      null;
    end;
  end if;
  return result_value || pg_catalog.jsonb_build_object('createdRecords', public_created_records);
end
$function$;

alter function vortex_record.apply_record_changes(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) to vortex_record_adapter;

comment on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) is
  'The one protected Record-change operation: claims one command receipt (a preview command carries its own preview-scoped id) and applies an ordered mutation list under one canonical lock order. Live changes keep their access decisions, Activity, Event and background effects; preview changes belong only to the validated preview owner and append no live effects. Named-action and lifecycle commands are refused in previews.';

set local role vortex_record_adapter;

create or replace function vortex_record.preview_record_field_bounds_internal(
  p_record_type_id uuid,
  p_storage_contract_id uuid,
  p_record_type jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  preview_value jsonb;
begin
  preview_value := vortex_record.read_current_preview_installation_internal();
  if preview_value is null or preview_value ->> 'outcome' = 'refused'
    or pg_catalog.jsonb_typeof(p_record_type) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_record_type -> 'fields') is distinct from 'array'
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_platform.is_non_nil_uuid(p_storage_contract_id::text)
    or (p_record_type ->> 'recordTypeId')::uuid is distinct from p_record_type_id
    or p_record_type ? 'systemProjection' then
    return null;
  end if;

  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(preview_value -> 'storageIdentities')
      as binding(value)
    where (binding.value ->> 'previewStorageContractId')::uuid = p_storage_contract_id
      and (binding.value ->> 'recordTypeId')::uuid = p_record_type_id
  ) then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.lower(field.value ->> 'fieldId') order by
          pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      )
      from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as field(value)
    ), '[]'::jsonb),
    'changeableFieldIds', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.lower(field.value ->> 'fieldId') order by
          pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      )
      from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as field(value)
      where field.value ->> 'type' not in (
        'calculation', 'total', 'reference_number', 'link_to_person', 'attachment'
      )
    ), '[]'::jsonb)
  );
end
$function$;
alter function vortex_record.preview_record_field_bounds_internal(uuid,uuid,jsonb) owner to vortex_record_adapter;


alter function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb)
  to vortex_record_adapter;
comment on function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb) is
  'Field bounds for a record already proven to use the exact owner-only preview storage identity; generated and derived fields remain non-changeable.';

set local role vortex_record_adapter;

-- Private Record-adapter routine; migrations install the complete canonical body
-- under its owner with schema CREATE granted only for that migration transaction.
create or replace function vortex_record.write_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_increment_source_revision boolean
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  source_meta jsonb;
  source_context jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_value jsonb;
  field_column jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  source_application_root_id uuid;
  target_application_root_id uuid;
  mapping_row vortex_record.relationship_storage_mappings%rowtype;
  application_root_required boolean;
  existing_other boolean;
  update_sql text;
  changed_rows integer;
begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null or p_increment_source_revision is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
  end if;
  source_meta := vortex_record.resolve_record_action_context_internal(
    p_source_record_type_id, 'read'
  );
  source_context := source_meta -> 'context';
  source_type := source_meta -> 'recordType';
  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(source_type -> 'relationships') as item(value)
  where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
  if not found then
    raise exception using errcode = '23514',
      message = 'Relationship is not declared by the active record type';
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(source_type -> 'fields') as item(value)
  where (item.value ->> 'fieldId')::uuid = (relationship_value ->> 'fromFieldId')::uuid;
  if not found or field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
    raise exception using errcode = '55000',
      message = 'Relationship field definition is unavailable';
  end if;
  field_column := source_meta -> 'columns' -> pg_catalog.lower(field_value ->> 'fieldId');

  if source_meta ? 'previewInstallationId' then
    -- The exact owner-validated preview definition is its mapping. A live mapping's single
    -- relationship identity must never be repointed at a preview's isolated storage.
    mapping_row.source_storage_contract_id := (source_meta ->> 'storageContractId')::uuid;
    mapping_row.cardinality := relationship_value ->> 'cardinality';
    mapping_row.on_parent_delete := relationship_value ->> 'onParentDelete';
    select pg_catalog.array_agg((target.value ->> 'recordTypeId')::uuid)
    into mapping_row.target_record_type_ids
    from pg_catalog.jsonb_array_elements(case when relationship_value ? 'toRecordType'
      then pg_catalog.jsonb_build_array(relationship_value -> 'toRecordType')
      else relationship_value -> 'toRecordTypes' end) as target(value);
  else
    select mapping.* into mapping_row
    from vortex_record.relationship_storage_mappings as mapping
    where mapping.relationship_id = p_relationship_id
      and mapping.source_storage_contract_id =
        (source_meta ->> 'storageContractId')::uuid
      and mapping.source_field_id = (field_value ->> 'fieldId')::uuid
      and mapping.release_revision <= (source_meta ->> 'moduleReleaseRevision')::bigint;
    if not found
      or mapping_row.cardinality is distinct from (relationship_value ->> 'cardinality')
      or mapping_row.on_parent_delete is distinct from (relationship_value ->> 'onParentDelete') then
      raise exception using errcode = '55000',
        message = 'Relationship storage disagrees with the active definition';
    end if;
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    if p_increment_source_revision then
      perform vortex_record.bump_record_data_version_internal(
        (source_context ->> 'organizationId')::uuid,
        (source_meta ->> 'storageContractId')::uuid,
        case when source_meta ->> 'storageScope' = 'application_contained'
          then (source_context ->> 'applicationRootId')::uuid else null end
      );
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    delete from vortex_record.relationship_edges as edge
    where edge.relationship_id = p_relationship_id
      and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
      and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
      and edge.from_record_id = p_source_record_id;
    update_sql := pg_catalog.format(
      'update record_data.%I as stored set %I = null%s
       where stored.organisation_id = $1 and stored.record_id = $2',
      source_meta ->> 'table', field_column ->> 'token',
      case when p_increment_source_revision then
        ', concurrency_number = concurrency_number + 1, updated_at = pg_catalog.statement_timestamp(), updated_by = $3'
      else '' end
    );
    if p_increment_source_revision then
      execute update_sql using (source_context ->> 'organizationId')::uuid,
        p_source_record_id, (source_context ->> 'organizationAccountId')::uuid;
    else
      execute update_sql using (source_context ->> 'organizationId')::uuid,
        p_source_record_id;
    end if;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001',
        message = 'Relationship source record changed';
    end if;
    return;
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) <> 'object'
    or not (p_target_value ?& array['recordTypeId', 'recordId'])
    or p_target_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end if;
  begin
    target_type_id := (p_target_value ->> 'recordTypeId')::uuid;
    target_record_id := (p_target_value ->> 'recordId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end;
  if target_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_type_id <> all (mapping_row.target_record_type_ids) then
    raise exception using errcode = '23514', message = 'Relationship target is unavailable';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  source_application_root_id := case when source_meta ->> 'storageScope' = 'application_contained'
    then (source_context ->> 'applicationRootId')::uuid else null end;
  application_root_required := coalesce(
    (field_value #>> '{settings,applicationRootIdRequired}')::boolean, false
  );
  if application_root_required
    and (target_meta #>> '{recordType,systemProjection,protectedView}')
      is distinct from 'organization_accounts' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- Lock the protected row behind either ordinary record storage or a
  -- registered system projection before rebuilding eligibility from current
  -- facts. The lock is held until commit, so the target cannot disappear while
  -- the unconstrainted relationship edge is installed.
  perform vortex_record.lock_relationship_target_row_internal(
    target_type_id, target_record_id,
    (source_context ->> 'organizationId')::uuid
  );

  target_loaded := vortex_record.load_record_access_facts_internal(
    target_type_id, 'read', target_record_id, null, null::jsonb
  );
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  if source_meta ? 'previewInstallationId'
    and target_loaded ->> 'previewInstallationId' = source_meta ->> 'previewInstallationId'
    and exists (
      select 1 from vortex_definition.roots as root
      where root.root_id = (target_loaded #>> '{recordTypeMeta,moduleRootId}')::uuid
        and root.owner_application_root_id = (source_context ->> 'applicationRootId')::uuid
    ) then
    target_decision := pg_catalog.jsonb_build_object('outcome', 'allowed');
  else
    target_decision := vortex_access.evaluate_organization_record_access_internal(
      pg_catalog.jsonb_set(target_loaded -> 'declaration', '{authority}',
        '{"kind":"permission"}'::jsonb), target_record_id, target_loaded -> 'facts'
    );
  end if;
  if target_decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  select item.value into target_record
  from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = target_record_id;
  target_scope := target_record -> 'recordScope';
  target_application_root_id := case when target_meta ->> 'storageScope' = 'application_contained'
    then (target_scope ->> 'applicationRootId')::uuid else null end;
  if target_record is null or target_record ->> 'lifecycleState' <> 'active'
    or (target_scope ->> 'organizationId')::uuid <>
      (source_context ->> 'organizationId')::uuid
    or (source_application_root_id is not null and target_application_root_id is not null
      and source_application_root_id <> target_application_root_id) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  if application_root_required
    and not vortex_access.organization_account_has_current_application_access_internal(
      (source_context ->> 'organizationId')::uuid,
      target_record_id,
      (source_context ->> 'applicationRootId')::uuid
    ) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- The target row is share-locked and eligible. The source data version is
  -- taken next, then the shared edge identities last.
  if p_increment_source_revision then
    perform vortex_record.bump_record_data_version_internal(
      (source_context ->> 'organizationId')::uuid,
      (source_meta ->> 'storageContractId')::uuid,
      source_application_root_id
    );
  end if;
  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );
  if mapping_row.cardinality = 'one_to_one' then
    select exists (
      select 1 from vortex_record.relationship_edges as edge
      where edge.relationship_id = p_relationship_id
        and edge.to_organisation_id = (source_context ->> 'organizationId')::uuid
        and edge.to_storage_contract_id = (target_meta ->> 'storageContractId')::uuid
        and edge.to_record_id = target_record_id
        and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
        and edge.from_record_id <> p_source_record_id
    ) into existing_other;
    if existing_other then
      raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
    end if;
  end if;

  delete from vortex_record.relationship_edges as edge
  where edge.relationship_id = p_relationship_id
    and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
    and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and edge.from_record_id = p_source_record_id;
  insert into vortex_record.relationship_edges (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    p_relationship_id,
    (source_context ->> 'organizationId')::uuid,
    (source_context ->> 'organizationId')::uuid,
    source_application_root_id, target_application_root_id,
    (source_meta ->> 'storageContractId')::uuid, p_source_record_id,
    (target_meta ->> 'storageContractId')::uuid, target_record_id
  );

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %I = $3::jsonb%s
     where stored.organisation_id = $1 and stored.record_id = $2',
    source_meta ->> 'table', field_column ->> 'token',
    case when p_increment_source_revision then
      ', concurrency_number = concurrency_number + 1, updated_at = pg_catalog.statement_timestamp(), updated_by = $4'
    else '' end
  );
  if p_increment_source_revision then
    execute update_sql using (source_context ->> 'organizationId')::uuid,
      p_source_record_id, p_target_value,
      (source_context ->> 'organizationAccountId')::uuid;
  else
    execute update_sql using (source_context ->> 'organizationId')::uuid,
      p_source_record_id, p_target_value;
  end if;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Relationship source record changed';
  end if;
end
$function$;

alter function vortex_record.write_relationship_value_internal(uuid,uuid,uuid,jsonb,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean) is
  'Private relationship writer: validates the declared relationship and target eligibility, checks current application access for flagged Person links, share-locks the record or protected projection target, then takes the source data version and the shared edge identities before replacing the source link edge and typed value atomically. Owner-only.';

set local role vortex_owner;

CREATE OR REPLACE FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  declaration_action jsonb;
  declaration_target jsonb;
  declaration_permissions jsonb;
  declaration_binding jsonb;
  declaration_authentication jsonb;
  declaration_authority jsonb;
  permission_candidate jsonb;
  previous_identity text;
  candidate_identity text;
  operation_value text;
  action_kind_value text;
  target_application_value uuid;
  binding_record_type_value uuid;
  context_value jsonb;
  context_organization_value uuid;
  context_account_value uuid;
  context_access_version_value bigint;
  context_application_value uuid;
  context_expires_value timestamptz;
  context_correlation_value uuid;
  authentication_deadline timestamptz;
  authentication_satisfied boolean := true;
  context_current boolean := true;
  target_context_satisfied boolean := true;
  unsupported_context boolean := false;
  decision_checked_at timestamptz;
  catalogue_available boolean := false;
  scoped_available boolean := false;
  path_effective boolean := false;
  eligible_permissions jsonb;
  eligible_valid_until timestamptz;
  refusal_reason text;
  evidence jsonb;
begin
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or not p_declaration ?& array[
      'operationKey', 'action', 'target', 'requiredPermissions',
      'recordBinding', 'recentAuthentication', 'authority'
    ]
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_declaration) as supplied(key)
      where supplied.key <> all (array[
        'operationKey', 'action', 'target', 'requiredPermissions',
        'recordBinding', 'recentAuthentication', 'authority'
      ])
    )
    or pg_catalog.jsonb_typeof(p_declaration -> 'operationKey') <> 'string'
    or pg_catalog.char_length(p_declaration ->> 'operationKey') not between 3 and 120
    or (p_declaration ->> 'operationKey') !~
      '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    or (p_declaration ->> 'operationKey') ~ '(^|\.)[^.]{41,}(\.|$)' then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  declaration_action := p_declaration -> 'action';
  declaration_target := p_declaration -> 'target';
  declaration_permissions := p_declaration -> 'requiredPermissions';
  declaration_binding := p_declaration -> 'recordBinding';
  declaration_authentication := p_declaration -> 'recentAuthentication';
  declaration_authority := p_declaration -> 'authority';

  if pg_catalog.jsonb_typeof(declaration_action) <> 'object'
    or not declaration_action ? 'actionKind'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_action) as supplied(key)
      where supplied.key <> all (array['actionKind', 'namedAction'])
    )
    or pg_catalog.jsonb_typeof(declaration_action -> 'actionKind') <> 'string'
    or declaration_action ->> 'actionKind' not in (
      'create', 'read', 'update', 'delete', 'restore', 'export', 'share', 'manage', 'transfer', 'named'
    )
    or (
      (declaration_action ->> 'actionKind') = 'named'
      and (
        not declaration_action ? 'namedAction'
        or pg_catalog.jsonb_typeof(declaration_action -> 'namedAction') <> 'string'
        or pg_catalog.char_length(declaration_action ->> 'namedAction') not between 1 and 40
        or (declaration_action ->> 'namedAction') !~
          '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      )
    )
    or (
      (declaration_action ->> 'actionKind') <> 'named'
      and declaration_action ? 'namedAction'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_target) <> 'object'
    or not declaration_target ?& array['kind', 'applicationRootId']
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_target) as supplied(key)
      where supplied.key <> all (array['kind', 'applicationRootId'])
    )
    or pg_catalog.jsonb_typeof(declaration_target -> 'kind') <> 'string'
    or declaration_target ->> 'kind' <> 'application'
    or not vortex_platform.is_non_nil_uuid(
      declaration_target ->> 'applicationRootId'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_binding) <> 'object'
    or not declaration_binding ?& array[
      'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'
    ]
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_binding) as supplied(key)
      where supplied.key <> all (array[
        'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'
      ])
    )
    or not vortex_platform.is_non_nil_uuid(declaration_binding ->> 'moduleRootId')
    or not vortex_platform.is_non_nil_uuid(declaration_binding ->> 'recordTypeId')
    or not vortex_platform.is_non_nil_uuid(
      declaration_binding ->> 'storageContractId'
    )
    or pg_catalog.jsonb_typeof(declaration_binding -> 'storageScope') <> 'string'
    or declaration_binding ->> 'storageScope' not in (
      'organization_shared', 'application_contained'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_authentication) <> 'object'
    or not declaration_authentication ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authentication -> 'kind') <> 'string'
    or declaration_authentication ->> 'kind' not in ('none', 'primary', 'multi_factor')
    or (
      declaration_authentication ->> 'kind' = 'none'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
      and (
        not declaration_authentication ? 'maximumAgeSeconds'
        or pg_catalog.jsonb_typeof(
          declaration_authentication -> 'maximumAgeSeconds'
        ) <> 'number'
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
          where supplied.key <> all (array['kind', 'maximumAgeSeconds'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
    and (
      (declaration_authentication ->> 'maximumAgeSeconds')::numeric < 1
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric >
        9007199254740991
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric <>
        pg_catalog.trunc(
          (declaration_authentication ->> 'maximumAgeSeconds')::numeric
        )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  -- A record operation carries ordinary permission authority only; delegated
  -- management scopes stay on the existing non-record path.
  if pg_catalog.jsonb_typeof(declaration_authority) <> 'object'
    or not declaration_authority ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authority -> 'kind') <> 'string'
    or declaration_authority ->> 'kind' <> 'permission'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_authority) as supplied(key)
      where supplied.key <> 'kind'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_permissions) <> 'array'
    or pg_catalog.jsonb_array_length(declaration_permissions) = 0 then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  previous_identity := null;
  for permission_candidate in
    select item.value
    from pg_catalog.jsonb_array_elements(declaration_permissions) as item(value)
  loop
    if pg_catalog.jsonb_typeof(permission_candidate) <> 'object'
      or not permission_candidate ?& array[
        'applicationRootId', 'ownerKind', 'ownerId', 'permissionId'
      ]
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(permission_candidate) as supplied(key)
        where supplied.key <> all (array[
          'applicationRootId', 'ownerKind', 'ownerId', 'permissionId'
        ])
      )
      or pg_catalog.jsonb_typeof(permission_candidate -> 'ownerKind') <> 'string'
      or permission_candidate ->> 'ownerKind' not in ('application', 'module')
      or not vortex_platform.is_non_nil_uuid(
        permission_candidate ->> 'applicationRootId'
      )
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'ownerId')
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'permissionId')
      or pg_catalog.lower(permission_candidate ->> 'applicationRootId') <>
        pg_catalog.lower(declaration_target ->> 'applicationRootId')
      or (
        permission_candidate ->> 'ownerKind' = 'application'
        and pg_catalog.lower(permission_candidate ->> 'ownerId') <>
          pg_catalog.lower(permission_candidate ->> 'applicationRootId')
      )
      or (
        permission_candidate ->> 'ownerKind' = 'module'
        and pg_catalog.lower(permission_candidate ->> 'ownerId') <>
          pg_catalog.lower(declaration_binding ->> 'moduleRootId')
      ) then
      raise exception using errcode = '22023',
        message = 'Organization record permission declaration is invalid';
    end if;

    candidate_identity := pg_catalog.concat_ws(
      ':',
      pg_catalog.lower(permission_candidate ->> 'applicationRootId'),
      permission_candidate ->> 'ownerKind',
      pg_catalog.lower(permission_candidate ->> 'ownerId'),
      pg_catalog.lower(permission_candidate ->> 'permissionId')
    );
    if previous_identity is not null
      and previous_identity collate "C" >= candidate_identity then
      raise exception using errcode = '22023',
        message = 'Organization record permission declaration is invalid';
    end if;
    previous_identity := candidate_identity;
  end loop;

  operation_value := p_declaration ->> 'operationKey';
  action_kind_value := declaration_action ->> 'actionKind';
  target_application_value := (declaration_target ->> 'applicationRootId')::uuid;
  binding_record_type_value := (declaration_binding ->> 'recordTypeId')::uuid;

  if action_kind_value = 'named'
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(declaration_permissions) as item(value)
      where item.value ->> 'ownerKind' <>
          declaration_permissions -> 0 ->> 'ownerKind'
        or pg_catalog.lower(item.value ->> 'ownerId') <>
          pg_catalog.lower(declaration_permissions -> 0 ->> 'ownerId')
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  context_value := p_context;
  context_organization_value := (context_value ->> 'organizationId')::uuid;
  context_account_value := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version_value := (context_value ->> 'accessVersion')::bigint;
  context_application_value := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  context_expires_value := (context_value ->> 'expiresAt')::timestamptz;
  context_correlation_value := (context_value ->> 'correlationId')::uuid;
  decision_checked_at := p_checked_at;
  context_current := context_expires_value > decision_checked_at;

  unsupported_context := context_value ? 'delegatedContext'
    or context_value ? 'supportContext';
  target_context_satisfied := coalesce(
    context_application_value = target_application_value, false
  );

  authentication_deadline := vortex_access.recent_authentication_deadline_internal(
    context_value, decision_checked_at, declaration_authentication
  );
  authentication_satisfied := authentication_deadline is not null;

  -- Every declared alternative is evaluated against its exact record type by the
  -- shared role-path helper under this one context and checked time. A candidate
  -- keeps its own catalogue record scope, immutable source release and path
  -- deadline; an alternative never lends authority to another. Keeping
  -- path_valid_until separate from authentication_deadline here (instead of
  -- combining them per row) is what lets the three existence flags below tell
  -- "no catalogue entry", "entry without record scope" and "scoped entry
  -- without a live path" apart as distinct refusal reasons.
  with candidate as (
    select declared.ordinality as alternative_ordinal,
      -- A preview's system projection uses the builder's live registration. Keep that
      -- registration's permission address with its accepted meaning for every later reader.
      pg_catalog.jsonb_build_object(
        'applicationRootId', (evaluated.permission_entry).application_root_id,
        'ownerKind', (evaluated.permission_entry).owner_kind,
        'ownerId', (evaluated.permission_entry).owner_id,
        'permissionId', (evaluated.permission_entry).permission_id
      ) as permission_value,
      (evaluated.permission_entry).registration_revision as registration_revision,
      (evaluated.permission_entry).record_scope as record_scope,
      pg_catalog.jsonb_build_object(
        'kind', (evaluated.permission_entry).source_kind,
        'definitionKey', (evaluated.permission_entry).source_definition_key,
        'rootId', (evaluated.permission_entry).source_root_id,
        'releaseRevision', (evaluated.permission_entry).source_revision,
        'releaseVersion', (evaluated.permission_entry).source_version,
        'validationContractVersion',
          (evaluated.permission_entry).source_validation_contract_version
      ) as source_release,
      evaluated.path_valid_until as path_valid_until
    from pg_catalog.jsonb_array_elements(declaration_permissions)
      with ordinality as declared(value, ordinality)
    cross join lateral vortex_access.evaluate_permission_role_path_internal(
      context_value, decision_checked_at, declared.value, declaration_action,
      binding_record_type_value
    ) as evaluated
  )
  select pg_catalog.count(*) > 0,
    pg_catalog.count(*) filter (where candidate.record_scope is not null) > 0,
    pg_catalog.count(*) filter (
      where candidate.record_scope is not null
        and candidate.path_valid_until is not null
    ) > 0,
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'permission', candidate.permission_value,
        'registrationRevision', candidate.registration_revision,
        'recordScope', candidate.record_scope,
        'source', candidate.source_release,
        'validUntil', pg_catalog.to_char(
          pg_catalog.timezone(
            'UTC', least(candidate.path_valid_until, authentication_deadline)
          ),
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      ) order by candidate.alternative_ordinal
    ) filter (
      where candidate.record_scope is not null
        and candidate.path_valid_until is not null
        and authentication_deadline is not null
    ),
    pg_catalog.min(least(candidate.path_valid_until, authentication_deadline))
      filter (
        where candidate.record_scope is not null
          and candidate.path_valid_until is not null
          and authentication_deadline is not null
      )
  into catalogue_available, scoped_available, path_effective, eligible_permissions,
    eligible_valid_until
  from candidate;

  evidence := pg_catalog.jsonb_build_object(
    'operationKey', operation_value,
    'target', declaration_target,
    'organizationId', context_organization_value,
    'organizationAccountId', context_account_value,
    'accessVersion', context_access_version_value,
    'checkedAt', pg_catalog.to_char(
      pg_catalog.timezone('UTC', decision_checked_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'correlationId', context_correlation_value,
    'recordBinding', declaration_binding
  );

  -- Refusal precedence keeps each cause distinguishable: an unsupported
  -- context always wins; then "no candidate has any catalogue entry"; then
  -- "entries exist but none carries record_scope"; then "scoped entries exist
  -- but none has a live role path"; only then does recent-authentication
  -- refuse an otherwise-complete set of alternatives.
  refusal_reason := case
    when not context_current
      or unsupported_context or not target_context_satisfied
      then 'target_policy_unavailable'
    when not catalogue_available then 'permission_unavailable'
    when not scoped_available then 'target_policy_unavailable'
    when not path_effective then 'permission_not_effective'
    when not authentication_satisfied then 'authentication_unsatisfied'
    else null
  end;

  if refusal_reason is not null then
    return evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', refusal_reason
    );
  end if;

  return evidence || pg_catalog.jsonb_build_object(
    'outcome', 'eligible',
    'validUntil', pg_catalog.to_char(
      pg_catalog.timezone('UTC', eligible_valid_until),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'eligiblePermissions', eligible_permissions
  );
end
$_$;

ALTER FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) OWNER TO vortex_owner;

COMMENT ON FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) IS 'Private record-permission eligibility evidence per declared alternative; carries the declared record binding as context and is never a record allow result. The caller supplies one Access-bound context and checked time.';

REVOKE ALL ON FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) TO vortex_owner;

grant execute on function vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) to postgres;
grant execute on function vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) to vortex_record_adapter;

set local role vortex_owner;

CREATE OR REPLACE FUNCTION vortex_record.enforce_relationship_edge_scope() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  relationship_value jsonb;
  source_row vortex_record.storage_catalogue%rowtype;
  target_row vortex_record.storage_catalogue%rowtype;
begin
  select catalogue.* into strict source_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = new.from_storage_contract_id;
  select catalogue.* into strict target_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = new.to_storage_contract_id;
  -- Each storage identity carries its declared record type, including an isolated preview.
  -- Validate the edge against that source's own relationship rather than an installed mapping
  -- of the same relationship identity that belongs to another storage contract.
  select relationship.value into strict relationship_value
  from pg_catalog.jsonb_array_elements(source_row.record_type_definition -> 'relationships')
    as relationship(value)
  where (relationship.value ->> 'relationshipId')::uuid = new.relationship_id;
  if not vortex_record.relationship_declares_target_internal(
      relationship_value, target_row.record_type_id
    )
    or (source_row.storage_scope = 'organization_shared') <> (new.from_application_root_id is null)
    or (target_row.storage_scope = 'organization_shared') <> (new.to_application_root_id is null)
    or (
      source_row.storage_scope = 'application_contained'
      and target_row.storage_scope = 'application_contained'
      and new.from_application_root_id <> new.to_application_root_id
    ) then
    raise exception using errcode = '23514', message = 'Relationship edge scope is invalid';
  end if;
  return new;
exception when no_data_found or too_many_rows then
  raise exception using errcode = '23514', message = 'Relationship edge mapping is unavailable';
end
$$;
alter function vortex_record.enforce_relationship_edge_scope() owner to vortex_owner;


REVOKE ALL ON FUNCTION vortex_record.enforce_relationship_edge_scope() FROM PUBLIC;

set local role vortex_record_adapter;

-- Private Record-adapter routine; migrations install the complete canonical body
-- under its owner with schema CREATE granted only for that migration transaction.
create or replace function vortex_record.write_named_action_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_subject_record_type_id uuid,
  p_subject_record_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  source_meta jsonb;
  source_context jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_value jsonb;
  field_column jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  source_application_root_id uuid;
  target_application_root_id uuid;
  mapping_row vortex_record.relationship_storage_mappings%rowtype;
  application_root_required boolean;
  existing_other boolean;
  update_sql text;
  changed_rows integer;
begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_subject_record_type_id is null or p_subject_record_id is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
  end if;
  source_meta := vortex_record.resolve_record_action_context_internal(
    p_source_record_type_id, 'read'
  );
  source_context := source_meta -> 'context';
  source_type := source_meta -> 'recordType';
  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(source_type -> 'relationships') as item(value)
  where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
  if not found then
    raise exception using errcode = '23514',
      message = 'Relationship is not declared by the active record type';
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(source_type -> 'fields') as item(value)
  where (item.value ->> 'fieldId')::uuid = (relationship_value ->> 'fromFieldId')::uuid;
  if not found or field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
    raise exception using errcode = '55000',
      message = 'Relationship field definition is unavailable';
  end if;
  field_column := source_meta -> 'columns' -> pg_catalog.lower(field_value ->> 'fieldId');

  select mapping.* into mapping_row
  from vortex_record.relationship_storage_mappings as mapping
  where mapping.relationship_id = p_relationship_id
    and mapping.source_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and mapping.source_field_id = (field_value ->> 'fieldId')::uuid
    and mapping.release_revision <= (source_meta ->> 'moduleReleaseRevision')::bigint;
  if not found
    or mapping_row.cardinality is distinct from (relationship_value ->> 'cardinality')
    or mapping_row.on_parent_delete is distinct from (relationship_value ->> 'onParentDelete') then
    raise exception using errcode = '55000',
      message = 'Relationship storage disagrees with the active definition';
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    delete from vortex_record.relationship_edges as edge
    where edge.relationship_id = p_relationship_id
      and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
      and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
      and edge.from_record_id = p_source_record_id;
    update_sql := pg_catalog.format(
      'update record_data.%I as stored set %I = null
       where stored.organisation_id = $1 and stored.record_id = $2',
      source_meta ->> 'table', field_column ->> 'token'
    );
    execute update_sql using (source_context ->> 'organizationId')::uuid, p_source_record_id;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Relationship source record changed';
    end if;
    return;
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) <> 'object'
    or not (p_target_value ?& array['recordTypeId', 'recordId'])
    or p_target_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end if;
  begin
    target_type_id := (p_target_value ->> 'recordTypeId')::uuid;
    target_record_id := (p_target_value ->> 'recordId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end;
  if target_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_type_id <> all (mapping_row.target_record_type_ids) then
    raise exception using errcode = '23514', message = 'Relationship target is unavailable';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  source_application_root_id := case when source_meta ->> 'storageScope' = 'application_contained'
    then (source_context ->> 'applicationRootId')::uuid else null end;
  application_root_required := coalesce(
    (field_value #>> '{settings,applicationRootIdRequired}')::boolean, false
  );
  if application_root_required
    and (target_meta #>> '{recordType,systemProjection,protectedView}')
      is distinct from 'organization_accounts' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  perform vortex_record.lock_relationship_target_row_internal(
    target_type_id, target_record_id,
    (source_context ->> 'organizationId')::uuid
  );

  -- The one substitution. Executing a permitted named action must not require
  -- ordinary read authority on its own subject (#50 section 4), so when the
  -- selected target is exactly this command's subject the decision is taken on
  -- the installed named declaration instead. The loader re-resolves the active
  -- installation, the owner kind/id/release revision, the action id and the
  -- action's declared subject record type, and the Access evaluation binds the
  -- organization, application, record type, record and the actor's current
  -- authority. Every other target keeps the ordinary read check unchanged.
  if target_type_id = p_subject_record_type_id and target_record_id = p_subject_record_id then
    target_loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, target_type_id, target_record_id, null
    );
  else
    target_loaded := vortex_record.load_record_access_facts_internal(
      target_type_id, 'read', target_record_id, null, null::jsonb
    );
  end if;
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  target_decision := vortex_access.evaluate_organization_record_access_internal(
    target_loaded -> 'declaration', target_record_id, target_loaded -> 'facts'
  );
  if target_decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  select item.value into target_record
  from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = target_record_id;
  target_scope := target_record -> 'recordScope';
  target_application_root_id := case when target_meta ->> 'storageScope' = 'application_contained'
    then (target_scope ->> 'applicationRootId')::uuid else null end;
  if target_record is null or target_record ->> 'lifecycleState' <> 'active'
    or (target_scope ->> 'organizationId')::uuid <>
      (source_context ->> 'organizationId')::uuid
    or (source_application_root_id is not null and target_application_root_id is not null
      and source_application_root_id <> target_application_root_id) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  if application_root_required
    and not vortex_access.organization_account_has_current_application_access_internal(
      (source_context ->> 'organizationId')::uuid,
      target_record_id,
      (source_context ->> 'applicationRootId')::uuid
    ) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- The target row is share-locked (the command preflight already holds every
  -- link target) and eligible; the shared edge identities are taken last,
  -- exactly as `write_relationship_value_internal` takes them.
  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );
  if mapping_row.cardinality = 'one_to_one' then
    select exists (
      select 1 from vortex_record.relationship_edges as edge
      where edge.relationship_id = p_relationship_id
        and edge.to_organisation_id = (source_context ->> 'organizationId')::uuid
        and edge.to_storage_contract_id = (target_meta ->> 'storageContractId')::uuid
        and edge.to_record_id = target_record_id
        and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
        and edge.from_record_id <> p_source_record_id
    ) into existing_other;
    if existing_other then
      raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
    end if;
  end if;

  delete from vortex_record.relationship_edges as edge
  where edge.relationship_id = p_relationship_id
    and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
    and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and edge.from_record_id = p_source_record_id;
  insert into vortex_record.relationship_edges (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    p_relationship_id,
    (source_context ->> 'organizationId')::uuid,
    (source_context ->> 'organizationId')::uuid,
    source_application_root_id, target_application_root_id,
    (source_meta ->> 'storageContractId')::uuid, p_source_record_id,
    (target_meta ->> 'storageContractId')::uuid, target_record_id
  );

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %I = $3::jsonb
     where stored.organisation_id = $1 and stored.record_id = $2',
    source_meta ->> 'table', field_column ->> 'token'
  );
  execute update_sql using (source_context ->> 'organizationId')::uuid,
    p_source_record_id, p_target_value;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Relationship source record changed';
  end if;
end
$function$;

alter function vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) owner to vortex_record_adapter;

revoke all on function
  vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) to vortex_record_adapter;

comment on function vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) is
  'Private named-action edge writer: checks current application access for flagged Person links, uses the ordinary or protected projection target lock and edge flow, and authorises the command subject by re-evaluating the exact installed named action rather than ordinary read.';

set local role vortex_owner;

create or replace function vortex_record.mirror_person_links_internal(
  p_storage_contract_id uuid,
  p_organization_id uuid,
  p_record_id uuid,
  p_values jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  pair record;
  old_value jsonb;
  new_value jsonb;
  account_id uuid;
  mirror_to_link boolean;
  table_token text;
  target_storage_id uuid;
  source_application_id uuid;
  source_exists boolean;
begin
  if pg_catalog.jsonb_typeof(p_values) <> 'object' then
    raise exception using errcode = '22023', message = 'Person link mirror values are invalid';
  end if;
  select catalogue.physical_table_token into table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.physical_schema_token = 'record_data';
  if table_token is null then
    raise exception using errcode = '55000', message = 'Person link mirror storage is unavailable';
  end if;

  for pair in
    select newer.field_id as new_field_id,
      (newer.field_definition #>> '{settings,legacyPersonFieldId}')::uuid as old_field_id,
      relationship.relationship_id,
      relationship.target_record_type_ids[1] as target_type_id
    from vortex_record.field_storage_mappings as newer
    join vortex_record.relationship_storage_mappings as relationship
      on relationship.source_storage_contract_id = newer.storage_contract_id
      and relationship.source_field_id = newer.field_id
    where newer.storage_contract_id = p_storage_contract_id
      and newer.state = 'active'
      and newer.field_definition #>> '{settings,legacyPersonFieldId}' is not null
      and pg_catalog.cardinality(relationship.target_record_type_ids) = 1
    order by newer.field_id
  loop
    if not (p_values ? pair.old_field_id::text or p_values ? pair.new_field_id::text) then
      continue;
    end if;
    if not exists (
      select 1 from vortex_record.field_storage_mappings as older
      where older.storage_contract_id = p_storage_contract_id
        and older.field_id = pair.old_field_id
        and older.field_definition ->> 'type' = 'link_to_person'
    ) then
      raise exception using errcode = '55000', message = 'Person link mirror declaration is incompatible';
    end if;
    mirror_to_link := p_values ? pair.old_field_id::text;
    if mirror_to_link then
      old_value := p_values -> pair.old_field_id::text;
      if pg_catalog.jsonb_typeof(old_value) <> 'null'
        and not vortex_record.canonical_record_value_matches(old_value, 'link_to_person', 'json') then
        raise exception using errcode = '22023', message = 'Person link mirror source is invalid';
      end if;
      account_id := case when pg_catalog.jsonb_typeof(old_value) = 'null'
        then null else (old_value ->> 'organizationAccountId')::uuid end;
      new_value := case when account_id is null then 'null'::jsonb else
        pg_catalog.jsonb_build_object('recordTypeId', pair.target_type_id, 'recordId', account_id)
      end;
      if p_values ? pair.new_field_id::text
        and p_values -> pair.new_field_id::text is distinct from new_value then
        raise exception using errcode = '23514', message = 'Person link mirror values disagree';
      end if;
    else
      new_value := p_values -> pair.new_field_id::text;
      if pg_catalog.jsonb_typeof(new_value) <> 'null'
        and (pg_catalog.jsonb_typeof(new_value) <> 'object'
          or new_value ->> 'recordTypeId' is distinct from pair.target_type_id::text
          or not pg_catalog.pg_input_is_valid(new_value ->> 'recordId', 'uuid')) then
        raise exception using errcode = '22023', message = 'Person link mirror target is invalid';
      end if;
      account_id := case when pg_catalog.jsonb_typeof(new_value) = 'null'
        then null else (new_value ->> 'recordId')::uuid end;
      old_value := case when account_id is null then 'null'::jsonb else
        pg_catalog.jsonb_build_object('organizationAccountId', account_id) end;
    end if;

    if account_id is not null and not exists (
      select 1 from vortex_identity.organization_accounts as account
      where account.organization_id = p_organization_id
        and account.organization_account_id = account_id
    ) then
      raise exception using errcode = 'P0002', message = 'Person link mirror account is unavailable';
    end if;
    select catalogue.storage_contract_id into target_storage_id
    from vortex_record.storage_catalogue as catalogue
    where catalogue.record_type_id = pair.target_type_id
      and catalogue.physical_schema_token = 'system_projection';
    if target_storage_id is null then
      raise exception using errcode = '55000', message = 'Person link mirror target storage is unavailable';
    end if;
    execute pg_catalog.format(
      'select stored.application_root_id from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2', table_token
    ) into source_application_id using p_organization_id, p_record_id;
    source_exists := found;
    if not source_exists then
      raise exception using errcode = '40001', message = 'Person link mirror source changed';
    end if;
    if mirror_to_link then
      execute pg_catalog.format(
        'update record_data.%I as stored set %I = $3
         where stored.organisation_id = $1 and stored.record_id = $2',
        table_token, 'f_' || pg_catalog.replace(pair.new_field_id::text, '-', '')
      ) using p_organization_id, p_record_id, new_value;
      delete from vortex_record.relationship_edges as edge
      where edge.relationship_id = pair.relationship_id
        and edge.from_organisation_id = p_organization_id
        and edge.from_storage_contract_id = p_storage_contract_id
        and edge.from_record_id = p_record_id;
      if account_id is not null then
        insert into vortex_record.relationship_edges (
          relationship_id, from_organisation_id, to_organisation_id,
          from_application_root_id, to_application_root_id,
          from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
        ) values (
          pair.relationship_id, p_organization_id, p_organization_id,
          source_application_id, null, p_storage_contract_id, p_record_id,
          target_storage_id, account_id
        );
      end if;
    else
      execute pg_catalog.format(
        'update record_data.%I as stored set %I = $3
         where stored.organisation_id = $1 and stored.record_id = $2',
        table_token, 'f_' || pg_catalog.replace(pair.old_field_id::text, '-', '')
      ) using p_organization_id, p_record_id, old_value;
    end if;
  end loop;
end
$function$;

alter function vortex_record.mirror_person_links_internal(uuid,uuid,uuid,jsonb) owner to vortex_owner;
revoke all on function vortex_record.mirror_person_links_internal(uuid,uuid,uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.mirror_person_links_internal(uuid,uuid,uuid,jsonb)
  to vortex_owner, vortex_record_adapter;

set local role vortex_owner;

create or replace function vortex_record.backfill_person_links_internal(
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  pair record;
  source_row record;
  table_token text;
  old_column text;
  new_column text;
  account_id uuid;
  target_storage_id uuid;
  expected_link jsonb;
  has_legacy_values boolean;
  changed_count integer := 0;
  changed_rows integer;
begin
  for pair in
    select (record_type.value ->> 'storageContractId')::uuid as storage_id,
      (field.value ->> 'fieldId')::uuid as new_field_id,
      (field.value #>> '{settings,legacyPersonFieldId}')::uuid as old_field_id,
      relationship.relationship_id,
      relationship.target_record_type_ids[1] as target_type_id
    from vortex_definition.releases as release
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,recordTypes}'
    ) as record_type(value)
    cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
    join vortex_record.relationship_storage_mappings as relationship
      on relationship.source_storage_contract_id = (record_type.value ->> 'storageContractId')::uuid
      and relationship.source_field_id = (field.value ->> 'fieldId')::uuid
    where release.root_id = p_module_root_id
      and release.release_revision = p_module_release_revision
      and field.value ->> 'type' = 'link'
      and field.value #>> '{settings,legacyPersonFieldId}' is not null
      and pg_catalog.cardinality(relationship.target_record_type_ids) = 1
    order by (record_type.value ->> 'storageContractId')::uuid,
      (field.value ->> 'fieldId')::uuid
  loop
    select catalogue.physical_table_token into table_token
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = pair.storage_id
      and catalogue.physical_schema_token = 'record_data';
    if table_token is null or not exists (
      select 1 from vortex_record.field_storage_mappings as old_mapping
      join vortex_record.field_storage_mappings as new_mapping
        on new_mapping.storage_contract_id = old_mapping.storage_contract_id
      where old_mapping.storage_contract_id = pair.storage_id
        and old_mapping.field_id = pair.old_field_id
        and old_mapping.field_definition ->> 'type' = 'link_to_person'
        and new_mapping.field_id = pair.new_field_id
        and new_mapping.field_definition #>> '{settings,legacyPersonFieldId}' = pair.old_field_id::text
    ) then
      raise exception using errcode = '55000', message = 'Person link backfill storage is incompatible';
    end if;
    old_column := 'f_' || pg_catalog.replace(pair.old_field_id::text, '-', '');
    new_column := 'f_' || pg_catalog.replace(pair.new_field_id::text, '-', '');
    select catalogue.storage_contract_id into target_storage_id
    from vortex_record.storage_catalogue as catalogue
    where catalogue.record_type_id = pair.target_type_id
      and catalogue.physical_schema_token = 'system_projection';
    if target_storage_id is null then
      -- A new installation can provision the source before its projection dependency.
      -- There is nothing to backfill until a legacy value exists.
      execute pg_catalog.format(
        'select exists (select 1 from record_data.%I where %I is not null)',
        table_token, old_column
      ) into has_legacy_values;
      if has_legacy_values then
        raise exception using errcode = '55000',
          message = 'Person link backfill target storage is unavailable';
      end if;
      continue;
    end if;
    for source_row in execute pg_catalog.format(
      'select stored.organisation_id, stored.application_root_id, stored.record_id,
         stored.%I as old_value, stored.%I as new_value
       from record_data.%I as stored where stored.%I is not null
       order by stored.organisation_id, stored.record_id',
      old_column, new_column, table_token, old_column
    ) loop
      if not vortex_record.canonical_record_value_matches(
        source_row.old_value, 'link_to_person', 'json'
      ) then
        raise exception using errcode = '55000', message = 'Stored person reference is invalid';
      end if;
      account_id := (source_row.old_value ->> 'organizationAccountId')::uuid;
      if not exists (
        select 1 from vortex_identity.organization_accounts as account
        where account.organization_id = source_row.organisation_id
          and account.organization_account_id = account_id
      ) then
        raise log 'Person link backfill skipped vanished account for storage %, field %',
          pair.storage_id, pair.old_field_id;
        continue;
      end if;
      expected_link := pg_catalog.jsonb_build_object(
        'recordTypeId', pair.target_type_id, 'recordId', account_id
      );
      if source_row.new_value is not null and source_row.new_value <> expected_link then
        raise exception using errcode = '55000', message = 'Stored person link disagrees with legacy value';
      end if;
      if source_row.new_value is null then
        execute pg_catalog.format(
          'update record_data.%I as stored set %I = $3
           where stored.organisation_id = $1 and stored.record_id = $2 and stored.%I is null',
          table_token, new_column, new_column
        ) using source_row.organisation_id, source_row.record_id, expected_link;
        get diagnostics changed_rows = row_count;
        changed_count := changed_count + changed_rows;
      end if;
      if not exists (
        select 1 from vortex_record.relationship_edges as edge
        where edge.relationship_id = pair.relationship_id
          and edge.from_organisation_id = source_row.organisation_id
          and edge.from_storage_contract_id = pair.storage_id
          and edge.from_record_id = source_row.record_id
          and edge.to_storage_contract_id = target_storage_id
          and edge.to_record_id = account_id
      ) then
        if exists (
          select 1 from vortex_record.relationship_edges as edge
          where edge.relationship_id = pair.relationship_id
            and edge.from_organisation_id = source_row.organisation_id
            and edge.from_storage_contract_id = pair.storage_id
            and edge.from_record_id = source_row.record_id
        ) then
          raise exception using errcode = '55000', message = 'Stored person link edge disagrees with legacy value';
        end if;
        insert into vortex_record.relationship_edges (
          relationship_id, from_organisation_id, to_organisation_id,
          from_application_root_id, to_application_root_id,
          from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
        ) values (
          pair.relationship_id, source_row.organisation_id, source_row.organisation_id,
          source_row.application_root_id, null, pair.storage_id, source_row.record_id,
          target_storage_id, account_id
        );
        changed_count := changed_count + 1;
      end if;
    end loop;
  end loop;
  return changed_count;
end
$function$;

alter function vortex_record.backfill_person_links_internal(uuid,bigint) owner to vortex_owner;
revoke all on function vortex_record.backfill_person_links_internal(uuid,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
grant execute on function vortex_record.backfill_person_links_internal(uuid,bigint)
  to vortex_owner;

reset role;
