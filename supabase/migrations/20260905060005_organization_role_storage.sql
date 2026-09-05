-- Inert organisation-owned role catalogue and continuity storage.
-- No role is created and no callable mutation path is exposed by this migration.

create table vortex_access.organization_roles (
  organization_id uuid not null,
  role_id uuid not null,
  role_kind text not null,
  role_key text not null,
  application_root_id uuid,
  application_scope_id uuid generated always as (
    coalesce(
      application_root_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  ) stored,
  source_role_id uuid,
  derived_application_root_id uuid,
  derived_source_role_id uuid,
  derived_source_definition_key text,
  derived_source_release_revision bigint,
  derived_source_release_version text,
  derived_source_validation_contract_version text,
  derived_source_content_fingerprint text,
  derived_source_resolution_fingerprint text,
  derived_source_template_fingerprint text,
  live_revision bigint not null,
  created_by uuid not null,
  created_at timestamptz not null,
  constraint organization_roles_pk primary key (organization_id, role_id),
  constraint organization_roles_scope_identity_unique unique (
    organization_id, role_id, role_kind, application_scope_id
  ),
  constraint organization_roles_key_unique unique (organization_id, role_key),
  constraint organization_roles_kind_valid check (role_kind in ('application', 'custom')),
  constraint organization_roles_ids_non_nil check (
    role_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and (application_root_id is null
      or application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and (source_role_id is null
      or source_role_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and (derived_application_root_id is null
      or derived_application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and (derived_source_role_id is null
      or derived_source_role_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and created_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_roles_key_format check (
    pg_catalog.char_length(role_key) between 1 and 40
    and role_key ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
  ),
  constraint organization_roles_revision_range check (
    live_revision between 1 and 9007199254740991
    and (
      derived_source_release_revision is null
      or derived_source_release_revision between 1 and 9007199254740991
    )
  ),
  constraint organization_roles_derived_definition_key_format check (
    derived_source_definition_key is null
    or (
      pg_catalog.char_length(derived_source_definition_key) between 3 and 120
      and derived_source_definition_key ~
        '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
      and derived_source_definition_key !~ '(^|\.)[^.]{41,}(\.|$)'
    )
  ),
  constraint organization_roles_derived_release_version_format check (
    derived_source_release_version is null
    or derived_source_release_version ~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  constraint organization_roles_derived_validation_version_format check (
    derived_source_validation_contract_version is null
    or derived_source_validation_contract_version ~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
  ),
  constraint organization_roles_derived_fingerprints_valid check (
    (derived_source_content_fingerprint is null
      or derived_source_content_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and (derived_source_resolution_fingerprint is null
      or derived_source_resolution_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and (derived_source_template_fingerprint is null
      or derived_source_template_fingerprint ~ '^sha256:[a-f0-9]{64}$')
  ),
  constraint organization_roles_kind_shape check (
    (
      role_kind = 'application'
      and application_root_id is not null
      and source_role_id is not null
      and derived_application_root_id is null
      and derived_source_role_id is null
      and derived_source_definition_key is null
      and derived_source_release_revision is null
      and derived_source_release_version is null
      and derived_source_validation_contract_version is null
      and derived_source_content_fingerprint is null
      and derived_source_resolution_fingerprint is null
      and derived_source_template_fingerprint is null
    )
    or (
      role_kind = 'custom'
      and application_root_id is null
      and source_role_id is null
      and (
        (
          derived_application_root_id is null
          and derived_source_role_id is null
          and derived_source_definition_key is null
          and derived_source_release_revision is null
          and derived_source_release_version is null
          and derived_source_validation_contract_version is null
          and derived_source_content_fingerprint is null
          and derived_source_resolution_fingerprint is null
          and derived_source_template_fingerprint is null
        )
        or (
          derived_application_root_id is not null
          and derived_source_role_id is not null
          and derived_source_definition_key is not null
          and derived_source_release_revision is not null
          and derived_source_release_version is not null
          and derived_source_validation_contract_version is not null
          and derived_source_content_fingerprint is not null
          and derived_source_resolution_fingerprint is not null
          and derived_source_template_fingerprint is not null
        )
      )
    )
  ),
  constraint organization_roles_created_at_finite check (
    created_at <> '-infinity'::timestamptz and created_at <> 'infinity'::timestamptz
  ),
  constraint organization_roles_organization_fk foreign key (organization_id)
    references vortex_identity.organizations (organization_id)
);

create unique index organization_roles_application_source_unique
  on vortex_access.organization_roles (organization_id, application_root_id, source_role_id)
  where role_kind = 'application';

create table vortex_access.organization_role_activation_policy_revisions (
  organization_id uuid not null,
  role_id uuid not null,
  activation_policy_id uuid not null,
  revision bigint not null,
  policy_fingerprint text not null,
  maximum_activation_duration_seconds bigint not null,
  reason_required boolean not null,
  authentication_requirement text not null,
  authentication_maximum_age_seconds bigint,
  independent_approval_required boolean not null,
  changed_by uuid not null,
  changed_at timestamptz not null,
  change_correlation_id uuid not null,
  constraint organization_role_activation_policy_revisions_pk primary key (
    organization_id, role_id, activation_policy_id, revision
  ),
  constraint organization_role_activation_policy_revisions_exact_unique unique (
    organization_id, role_id, activation_policy_id, revision, policy_fingerprint
  ),
  constraint organization_role_activation_policy_revisions_ids_non_nil check (
    role_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and activation_policy_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and change_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_role_activation_policy_revisions_ranges_valid check (
    revision between 1 and 9007199254740991
    and maximum_activation_duration_seconds between 1 and 9007199254740991
    and (
      authentication_maximum_age_seconds is null
      or authentication_maximum_age_seconds between 1 and 9007199254740991
    )
  ),
  constraint organization_role_activation_policy_revisions_fingerprint_valid check (
    policy_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint organization_role_activation_policy_revisions_authentication_shape check (
    (authentication_requirement = 'none' and authentication_maximum_age_seconds is null)
    or (
      authentication_requirement in ('primary', 'multi_factor')
      and authentication_maximum_age_seconds is not null
    )
  ),
  constraint organization_role_activation_policy_revisions_changed_at_finite check (
    changed_at <> '-infinity'::timestamptz and changed_at <> 'infinity'::timestamptz
  ),
  constraint organization_role_activation_policy_revisions_role_fk foreign key (
    organization_id, role_id
  ) references vortex_access.organization_roles (
    organization_id, role_id
  ) deferrable initially deferred
);

create table vortex_access.organization_role_revisions (
  organization_id uuid not null,
  role_id uuid not null,
  revision bigint not null,
  role_kind text not null,
  application_root_id uuid,
  application_scope_id uuid generated always as (
    coalesce(
      application_root_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  ) stored,
  lifecycle text not null,
  privilege_classification text not null,
  assignment_policy text not null,
  policy_continuity_revision bigint not null,
  activation_policy_id uuid,
  activation_policy_revision bigint,
  activation_policy_fingerprint text,
  role_key text not null,
  label text not null,
  description text not null,
  source_definition_key text,
  source_release_revision bigint,
  source_release_version text,
  source_validation_contract_version text,
  source_content_fingerprint text,
  source_resolution_fingerprint text,
  source_template_fingerprint text,
  source_catalogue_fingerprint text,
  accepted_registration_revision bigint,
  template_continuity_revision bigint,
  accepted_grant_fingerprint text,
  changed_by uuid not null,
  changed_at timestamptz not null,
  change_correlation_id uuid not null,
  source_registration_kind text generated always as (
    case when role_kind = 'application' then 'application'::text else null::text end
  ) stored,
  constraint organization_role_revisions_pk primary key (
    organization_id, role_id, revision
  ),
  constraint organization_role_revisions_scope_identity_unique unique (
    organization_id, role_id, revision, role_kind, application_scope_id
  ),
  constraint organization_role_revisions_current_key_unique unique (
    organization_id, role_id, revision, role_key
  ),
  constraint organization_role_revisions_kind_valid check (
    role_kind in ('application', 'custom')
  ),
  constraint organization_role_revisions_lifecycle_valid check (
    (role_kind = 'application'
      and lifecycle in ('active', 'acceptance_required', 'unavailable', 'retired'))
    or (role_kind = 'custom' and lifecycle in ('active', 'retired'))
  ),
  constraint organization_role_revisions_privilege_classification_valid check (
    privilege_classification in ('standard', 'privileged')
  ),
  constraint organization_role_revisions_assignment_policy_valid check (
    assignment_policy in ('standing', 'activation_required')
  ),
  constraint organization_role_revisions_key_format check (
    pg_catalog.char_length(role_key) between 1 and 40
    and role_key ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
  ),
  constraint organization_role_revisions_ids_non_nil check (
    role_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and (application_root_id is null
      or application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and (activation_policy_id is null
      or activation_policy_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and change_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_role_revisions_revision_range check (
    revision between 1 and 9007199254740991
    and policy_continuity_revision between 1 and 9007199254740991
    and (
      activation_policy_revision is null
      or activation_policy_revision between 1 and 9007199254740991
    )
    and (
      source_release_revision is null
      or source_release_revision between 1 and 9007199254740991
    )
    and (
      accepted_registration_revision is null
      or accepted_registration_revision between 1 and 9007199254740991
    )
    and (
      template_continuity_revision is null
      or template_continuity_revision between 1 and 9007199254740991
    )
  ),
  constraint organization_role_revisions_label_valid check (
    label = pg_catalog.btrim(label) and pg_catalog.char_length(label) between 1 and 60
  ),
  constraint organization_role_revisions_description_valid check (
    description = pg_catalog.btrim(description)
    and pg_catalog.char_length(description) between 1 and 1000
  ),
  constraint organization_role_revisions_definition_key_format check (
    source_definition_key is null
    or (
      pg_catalog.char_length(source_definition_key) between 3 and 120
      and source_definition_key ~
        '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
      and source_definition_key !~ '(^|\.)[^.]{41,}(\.|$)'
    )
  ),
  constraint organization_role_revisions_release_version_format check (
    source_release_version is null
    or source_release_version ~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  constraint organization_role_revisions_validation_version_format check (
    source_validation_contract_version is null
    or source_validation_contract_version ~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
  ),
  constraint organization_role_revisions_fingerprints_valid check (
    (source_content_fingerprint is null
      or source_content_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and (source_resolution_fingerprint is null
      or source_resolution_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and (source_template_fingerprint is null
      or source_template_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and (source_catalogue_fingerprint is null
      or source_catalogue_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and (accepted_grant_fingerprint is null
      or accepted_grant_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and (activation_policy_fingerprint is null
      or activation_policy_fingerprint ~ '^sha256:[a-f0-9]{64}$')
  ),
  constraint organization_role_revisions_assignment_policy_shape check (
    (
      assignment_policy = 'standing'
      and activation_policy_id is null
      and activation_policy_revision is null
      and activation_policy_fingerprint is null
    )
    or (
      assignment_policy = 'activation_required'
      and activation_policy_id is not null
      and activation_policy_revision is not null
      and activation_policy_fingerprint is not null
    )
  ),
  constraint organization_role_revisions_source_shape check (
    (
      role_kind = 'application'
      and application_root_id is not null
      and source_definition_key is not null
      and source_release_revision is not null
      and source_release_version is not null
      and source_validation_contract_version is not null
      and source_content_fingerprint is not null
      and source_resolution_fingerprint is not null
      and source_template_fingerprint is not null
      and source_catalogue_fingerprint is not null
      and accepted_registration_revision is not null
      and template_continuity_revision is not null
      and accepted_grant_fingerprint is not null
    )
    or (
      role_kind = 'custom'
      and application_root_id is null
      and source_definition_key is null
      and source_release_revision is null
      and source_release_version is null
      and source_validation_contract_version is null
      and source_content_fingerprint is null
      and source_resolution_fingerprint is null
      and source_template_fingerprint is null
      and source_catalogue_fingerprint is null
      and accepted_registration_revision is null
      and template_continuity_revision is null
      and accepted_grant_fingerprint is null
    )
  ),
  constraint organization_role_revisions_changed_at_finite check (
    changed_at <> '-infinity'::timestamptz and changed_at <> 'infinity'::timestamptz
  ),
  constraint organization_role_revisions_role_fk foreign key (
    organization_id, role_id, role_kind, application_scope_id
  ) references vortex_access.organization_roles (
    organization_id, role_id, role_kind, application_scope_id
  ) deferrable initially deferred,
  constraint organization_role_revisions_activation_policy_fk foreign key (
    organization_id, role_id, activation_policy_id,
    activation_policy_revision, activation_policy_fingerprint
  ) references vortex_access.organization_role_activation_policy_revisions (
    organization_id, role_id, activation_policy_id, revision, policy_fingerprint
  ) deferrable initially deferred,
  constraint organization_role_revisions_source_registration_fk foreign key (
    organization_id, source_registration_kind, application_root_id,
    accepted_registration_revision
  ) references vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision
  )
);

alter table vortex_access.organization_roles
  add constraint organization_roles_current_revision_fk foreign key (
    organization_id, role_id, live_revision, role_key
  ) references vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_key
  ) deferrable initially deferred;

create index organization_role_revisions_source_registration_idx
  on vortex_access.organization_role_revisions (
    organization_id, source_registration_kind, application_root_id,
    accepted_registration_revision
  ) where role_kind = 'application';

create index organization_role_revisions_activation_policy_idx
  on vortex_access.organization_role_revisions (
    organization_id, role_id, activation_policy_id,
    activation_policy_revision, activation_policy_fingerprint
  ) where activation_policy_id is not null;

create table vortex_access.organization_role_permission_entries (
  organization_id uuid not null,
  role_id uuid not null,
  role_revision bigint not null,
  entry_ordinal bigint not null,
  role_kind text not null,
  role_application_root_id uuid,
  role_application_scope_id uuid generated always as (
    coalesce(
      role_application_root_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  ) stored,
  application_root_id uuid,
  owner_kind text not null,
  owner_id uuid not null,
  permission_id uuid not null,
  registration_kind text not null,
  registration_owner_id uuid not null,
  accepted_registration_revision bigint not null,
  catalogue_fingerprint text not null,
  continuity_revision bigint not null,
  meaning_fingerprint text not null,
  constraint organization_role_permission_entries_pk primary key (
    organization_id, role_id, role_revision, entry_ordinal
  ),
  constraint organization_role_permission_entries_identity_unique unique nulls not distinct (
    organization_id, role_id, role_revision, application_root_id,
    owner_kind, owner_id, permission_id
  ),
  constraint organization_role_permission_entries_kind_valid check (
    role_kind in ('application', 'custom')
    and owner_kind in ('platform', 'application', 'module')
    and registration_kind in ('platform', 'application')
  ),
  constraint organization_role_permission_entries_ids_non_nil check (
    role_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and (role_application_root_id is null
      or role_application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and (application_root_id is null
      or application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and owner_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and permission_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and registration_owner_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_role_permission_entries_revision_range check (
    role_revision between 1 and 9007199254740991
    and entry_ordinal between 1 and 9007199254740991
    and accepted_registration_revision between 1 and 9007199254740991
    and continuity_revision between 1 and 9007199254740991
  ),
  constraint organization_role_permission_entries_fingerprints_valid check (
    catalogue_fingerprint ~ '^sha256:[a-f0-9]{64}$'
    and meaning_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint organization_role_permission_entries_permission_scope check (
    (
      application_root_id is null
      and owner_kind = 'platform'
      and registration_kind = 'platform'
      and registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
      and owner_id = registration_owner_id
    )
    or (
      application_root_id is not null
      and owner_kind in ('application', 'module')
      and registration_kind = 'application'
      and registration_owner_id = application_root_id
      and (owner_kind <> 'application' or owner_id = application_root_id)
    )
  ),
  constraint organization_role_permission_entries_role_scope check (
    (
      role_kind = 'application'
      and role_application_root_id is not null
      and application_root_id = role_application_root_id
      and owner_kind in ('application', 'module')
    )
    or (role_kind = 'custom' and role_application_root_id is null)
  ),
  constraint organization_role_permission_entries_role_revision_fk foreign key (
    organization_id, role_id, role_revision, role_kind, role_application_scope_id
  ) references vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_scope_id
  ),
  constraint organization_role_permission_entries_catalogue_entry_fk foreign key (
    organization_id, registration_kind, registration_owner_id,
    accepted_registration_revision, owner_kind, owner_id, permission_id
  ) references vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, owner_kind, owner_id, permission_id
  )
);

create index organization_role_permission_entries_catalogue_entry_idx
  on vortex_access.organization_role_permission_entries (
    organization_id, registration_kind, registration_owner_id,
    accepted_registration_revision, owner_kind, owner_id, permission_id
  );

create table vortex_access.permission_continuities (
  organization_id uuid not null,
  application_root_id uuid,
  application_scope_id uuid generated always as (
    coalesce(
      application_root_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  ) stored,
  owner_kind text not null,
  owner_id uuid not null,
  permission_id uuid not null,
  registration_kind text not null,
  registration_owner_id uuid not null,
  state text not null,
  continuity_revision bigint not null,
  meaning_fingerprint text not null,
  last_processed_registration_revision bigint not null,
  changed_at timestamptz not null,
  constraint permission_continuities_pk primary key (
    organization_id, application_scope_id, owner_kind, owner_id, permission_id
  ),
  constraint permission_continuities_kind_valid check (
    owner_kind in ('platform', 'application', 'module')
    and registration_kind in ('platform', 'application')
  ),
  constraint permission_continuities_state_valid check (
    state in ('available', 'unavailable')
  ),
  constraint permission_continuities_ids_non_nil check (
    (application_root_id is null
      or application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and owner_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and permission_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and registration_owner_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint permission_continuities_revision_range check (
    continuity_revision between 1 and 9007199254740991
    and last_processed_registration_revision between 1 and 9007199254740991
  ),
  constraint permission_continuities_meaning_fingerprint_format check (
    meaning_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint permission_continuities_scope_shape check (
    (
      application_root_id is null
      and owner_kind = 'platform'
      and registration_kind = 'platform'
      and registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
      and owner_id = registration_owner_id
    )
    or (
      application_root_id is not null
      and owner_kind in ('application', 'module')
      and registration_kind = 'application'
      and registration_owner_id = application_root_id
      and (owner_kind <> 'application' or owner_id = application_root_id)
    )
  ),
  constraint permission_continuities_changed_at_finite check (
    changed_at <> '-infinity'::timestamptz and changed_at <> 'infinity'::timestamptz
  ),
  constraint permission_continuities_registration_revision_fk foreign key (
    organization_id, registration_kind, registration_owner_id,
    last_processed_registration_revision
  ) references vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision
  )
);

create index permission_continuities_registration_revision_idx
  on vortex_access.permission_continuities (
    organization_id, registration_kind, registration_owner_id,
    last_processed_registration_revision
  );

create table vortex_access.application_role_template_continuities (
  organization_id uuid not null,
  application_root_id uuid not null,
  source_role_id uuid not null,
  state text not null,
  continuity_revision bigint not null,
  source_template_fingerprint text not null,
  last_processed_registration_revision bigint not null,
  changed_at timestamptz not null,
  registration_kind text generated always as ('application'::text) stored,
  constraint application_role_template_continuities_pk primary key (
    organization_id, application_root_id, source_role_id
  ),
  constraint application_role_template_continuities_state_valid check (
    state in ('available', 'unavailable')
  ),
  constraint application_role_template_continuities_ids_non_nil check (
    application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and source_role_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint application_role_template_continuities_revision_range check (
    continuity_revision between 1 and 9007199254740991
    and last_processed_registration_revision between 1 and 9007199254740991
  ),
  constraint application_role_template_continuities_fingerprint_format check (
    source_template_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint application_role_template_continuities_changed_at_finite check (
    changed_at <> '-infinity'::timestamptz and changed_at <> 'infinity'::timestamptz
  ),
  constraint application_role_template_continuities_registration_revision_fk foreign key (
    organization_id, registration_kind, application_root_id,
    last_processed_registration_revision
  ) references vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision
  )
);

create index application_role_template_continuities_registration_revision_idx
  on vortex_access.application_role_template_continuities (
    organization_id, registration_kind, application_root_id,
    last_processed_registration_revision
  );

alter table vortex_access.organization_roles enable row level security;
alter table vortex_access.organization_roles force row level security;
alter table vortex_access.organization_role_activation_policy_revisions
  enable row level security;
alter table vortex_access.organization_role_activation_policy_revisions
  force row level security;
alter table vortex_access.organization_role_revisions enable row level security;
alter table vortex_access.organization_role_revisions force row level security;
alter table vortex_access.organization_role_permission_entries enable row level security;
alter table vortex_access.organization_role_permission_entries force row level security;
alter table vortex_access.permission_continuities enable row level security;
alter table vortex_access.permission_continuities force row level security;
alter table vortex_access.application_role_template_continuities enable row level security;
alter table vortex_access.application_role_template_continuities force row level security;

create function vortex_access.protect_organization_role_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'Organization roles cannot be deleted';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.role_id is distinct from old.role_id
    or new.role_kind is distinct from old.role_kind
    or new.application_root_id is distinct from old.application_root_id
    or new.source_role_id is distinct from old.source_role_id
    or new.derived_application_root_id is distinct from old.derived_application_root_id
    or new.derived_source_role_id is distinct from old.derived_source_role_id
    or new.derived_source_definition_key is distinct from old.derived_source_definition_key
    or new.derived_source_release_revision is distinct from old.derived_source_release_revision
    or new.derived_source_release_version is distinct from old.derived_source_release_version
    or new.derived_source_validation_contract_version is distinct
      from old.derived_source_validation_contract_version
    or new.derived_source_content_fingerprint is distinct
      from old.derived_source_content_fingerprint
    or new.derived_source_resolution_fingerprint is distinct
      from old.derived_source_resolution_fingerprint
    or new.derived_source_template_fingerprint is distinct
      from old.derived_source_template_fingerprint
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or old.live_revision = 9007199254740991
    or new.live_revision <> old.live_revision + 1 then
    raise exception using errcode = '23514',
      message = 'Organization role updates require one permanent-identity revision';
  end if;

  return new;
end;
$$;

create trigger organization_roles_protect_change
before update or delete on vortex_access.organization_roles
for each row execute function vortex_access.protect_organization_role_identity();

create function vortex_access.refuse_organization_role_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '23514', message = 'Organization role history is immutable';
end;
$$;

create trigger organization_role_revisions_immutable
before update or delete on vortex_access.organization_role_revisions
for each row execute function vortex_access.refuse_organization_role_history_mutation();

create trigger organization_role_activation_policy_revisions_immutable
before update or delete on vortex_access.organization_role_activation_policy_revisions
for each row execute function vortex_access.refuse_organization_role_history_mutation();

create trigger organization_role_permission_entries_immutable
before update or delete on vortex_access.organization_role_permission_entries
for each row execute function vortex_access.refuse_organization_role_history_mutation();

create function vortex_access.validate_organization_role_revision_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_organization_id uuid;
  target_role_id uuid;
  target_role_revision bigint;
  target_role_kind text;
  target_lifecycle text;
  target_privilege_classification text;
  target_assignment_policy text;
  target_policy_continuity_revision bigint;
  target_activation_policy_id uuid;
  target_activation_policy_revision bigint;
  target_activation_policy_fingerprint text;
  target_application_root_id uuid;
  target_catalogue_fingerprint text;
  target_registration_revision bigint;
  previous_assignment_policy text;
  previous_policy_continuity_revision bigint;
  previous_activation_policy_id uuid;
  previous_activation_policy_revision bigint;
  previous_activation_policy_fingerprint text;
  policy_unchanged boolean;
  permission_count bigint;
  administrative_permission_count bigint;
  inconsistent_permission_count bigint;
  inconsistent_source_count bigint;
begin
  if tg_table_name = 'organization_role_revisions' then
    target_organization_id := new.organization_id;
    target_role_id := new.role_id;
    target_role_revision := new.revision;
  else
    target_organization_id := new.organization_id;
    target_role_id := new.role_id;
    target_role_revision := new.role_revision;
  end if;

  select revision.role_kind, revision.lifecycle, revision.privilege_classification,
    revision.assignment_policy, revision.policy_continuity_revision,
    revision.activation_policy_id, revision.activation_policy_revision,
    revision.activation_policy_fingerprint, revision.application_root_id,
    revision.source_catalogue_fingerprint, revision.accepted_registration_revision
  into target_role_kind, target_lifecycle, target_privilege_classification,
    target_assignment_policy, target_policy_continuity_revision,
    target_activation_policy_id, target_activation_policy_revision,
    target_activation_policy_fingerprint, target_application_root_id,
    target_catalogue_fingerprint, target_registration_revision
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = target_organization_id
    and revision.role_id = target_role_id
    and revision.revision = target_role_revision;

  if not found then
    return null;
  end if;

  if target_role_revision = 1 then
    if target_policy_continuity_revision <> 1 then
      raise exception using errcode = '23514',
        message = 'An initial organization role policy continuity revision must be one';
    end if;
  else
    select revision.assignment_policy, revision.policy_continuity_revision,
      revision.activation_policy_id, revision.activation_policy_revision,
      revision.activation_policy_fingerprint
    into previous_assignment_policy, previous_policy_continuity_revision,
      previous_activation_policy_id, previous_activation_policy_revision,
      previous_activation_policy_fingerprint
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = target_role_revision - 1;

    if not found then
      raise exception using errcode = '23514',
        message = 'An organization role revision requires its immediate predecessor';
    end if;

    policy_unchanged :=
      target_assignment_policy = previous_assignment_policy
      and target_activation_policy_id is not distinct from previous_activation_policy_id
      and target_activation_policy_revision is not distinct
        from previous_activation_policy_revision
      and target_activation_policy_fingerprint is not distinct
        from previous_activation_policy_fingerprint;

    if policy_unchanged and
      target_policy_continuity_revision <> previous_policy_continuity_revision then
      raise exception using errcode = '23514',
        message = 'Unchanged role policy must preserve policy continuity';
    end if;

    if not policy_unchanged and (
      previous_policy_continuity_revision = 9007199254740991
      or target_policy_continuity_revision <> previous_policy_continuity_revision + 1
    ) then
      raise exception using errcode = '23514',
        message = 'Changed role policy must advance policy continuity exactly once';
    end if;
  end if;

  select pg_catalog.count(*) into permission_count
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision;

  if (target_role_kind = 'custom' or target_lifecycle = 'active')
    and permission_count = 0 then
    raise exception using errcode = '23514',
      message = 'This organization role lifecycle requires accepted permissions';
  end if;

  select pg_catalog.count(*) into inconsistent_source_count
  from vortex_access.organization_role_permission_entries as permission
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = permission.organization_id
    and registration.registration_kind = permission.registration_kind
    and registration.registration_owner_id = permission.registration_owner_id
    and registration.revision = permission.accepted_registration_revision
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = permission.organization_id
    and catalogue.registration_kind = permission.registration_kind
    and catalogue.registration_owner_id = permission.registration_owner_id
    and catalogue.registration_revision = permission.accepted_registration_revision
    and catalogue.owner_kind = permission.owner_kind
    and catalogue.owner_id = permission.owner_id
    and catalogue.permission_id = permission.permission_id
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision
    and (
      permission.catalogue_fingerprint <> registration.permission_catalogue_fingerprint
      or permission.meaning_fingerprint <> catalogue.meaning_fingerprint
    );

  if inconsistent_source_count <> 0 then
    raise exception using errcode = '23514',
      message = 'Role permissions must retain exact catalogue and meaning evidence';
  end if;

  select pg_catalog.count(*) into administrative_permission_count
  from vortex_access.organization_role_permission_entries as permission
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = permission.organization_id
    and catalogue.registration_kind = permission.registration_kind
    and catalogue.registration_owner_id = permission.registration_owner_id
    and catalogue.registration_revision = permission.accepted_registration_revision
    and catalogue.owner_kind = permission.owner_kind
    and catalogue.owner_id = permission.owner_id
    and catalogue.permission_id = permission.permission_id
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision
    and catalogue.administrative;

  if target_privilege_classification = 'standard'
    and administrative_permission_count <> 0 then
    raise exception using errcode = '23514',
      message = 'Administrative permissions require privileged role classification';
  end if;

  if target_role_kind = 'application' then
    select pg_catalog.count(*) into inconsistent_source_count
    from vortex_access.organization_role_revisions as revision
    join vortex_access.permission_registration_revisions as registration
      on registration.organization_id = revision.organization_id
      and registration.registration_kind = revision.source_registration_kind
      and registration.registration_owner_id = revision.application_root_id
      and registration.revision = revision.accepted_registration_revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = target_role_revision
      and (
        revision.source_definition_key <> registration.source_definition_key
        or revision.source_release_revision <> registration.source_revision
        or revision.source_release_version <> registration.source_version
        or revision.source_validation_contract_version <>
          registration.validation_contract_version
        or revision.source_content_fingerprint <> registration.source_content_fingerprint
        or revision.source_resolution_fingerprint <>
          registration.source_resolution_fingerprint
        or revision.source_catalogue_fingerprint <>
          registration.permission_catalogue_fingerprint
      );

    if inconsistent_source_count <> 0 then
      raise exception using errcode = '23514',
        message = 'Application role source must match exact registration evidence';
    end if;

    select pg_catalog.count(*) into inconsistent_permission_count
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = target_role_revision
      and (
        permission.application_root_id is distinct from target_application_root_id
        or permission.accepted_registration_revision <> target_registration_revision
        or permission.catalogue_fingerprint <> target_catalogue_fingerprint
      );

    if inconsistent_permission_count <> 0 then
      raise exception using errcode = '23514',
        message = 'Application role permissions must match accepted registration evidence';
    end if;
  end if;

  return null;
end;
$$;

create constraint trigger organization_role_revisions_evidence
after insert on vortex_access.organization_role_revisions
deferrable initially deferred
for each row execute function vortex_access.validate_organization_role_revision_evidence();

create constraint trigger organization_role_permission_entries_evidence
after insert on vortex_access.organization_role_permission_entries
deferrable initially deferred
for each row execute function vortex_access.validate_organization_role_revision_evidence();

create function vortex_access.protect_permission_continuity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'Permission continuity cannot be deleted';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.application_root_id is distinct from old.application_root_id
    or new.owner_kind is distinct from old.owner_kind
    or new.owner_id is distinct from old.owner_id
    or new.permission_id is distinct from old.permission_id
    or new.registration_kind is distinct from old.registration_kind
    or new.registration_owner_id is distinct from old.registration_owner_id
    or old.last_processed_registration_revision = 9007199254740991
    or new.last_processed_registration_revision <= old.last_processed_registration_revision
    or new.continuity_revision not in (
      old.continuity_revision,
      old.continuity_revision + 1
    )
    or (
      new.continuity_revision = old.continuity_revision
      and (
        new.state is distinct from old.state
        or new.meaning_fingerprint is distinct from old.meaning_fingerprint
      )
    )
    or (
      new.continuity_revision = old.continuity_revision + 1
      and new.state is not distinct from old.state
      and new.meaning_fingerprint is not distinct from old.meaning_fingerprint
    ) then
    raise exception using errcode = '23514',
      message = 'Permission continuity transition is invalid';
  end if;

  return new;
end;
$$;

create trigger permission_continuities_protect_change
before update or delete on vortex_access.permission_continuities
for each row execute function vortex_access.protect_permission_continuity();

create function vortex_access.validate_permission_continuity_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.state = 'available' and not exists (
    select 1
    from vortex_access.permission_registration_revisions as registration
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = registration.organization_id
      and catalogue.registration_kind = registration.registration_kind
      and catalogue.registration_owner_id = registration.registration_owner_id
      and catalogue.registration_revision = registration.revision
    where registration.organization_id = new.organization_id
      and registration.registration_kind = new.registration_kind
      and registration.registration_owner_id = new.registration_owner_id
      and registration.revision = new.last_processed_registration_revision
      and registration.state = 'active'
      and catalogue.owner_kind = new.owner_kind
      and catalogue.owner_id = new.owner_id
      and catalogue.permission_id = new.permission_id
      and catalogue.application_root_id is not distinct from new.application_root_id
      and catalogue.meaning_fingerprint = new.meaning_fingerprint
  ) then
    raise exception using errcode = '23514',
      message = 'Available permission continuity requires exact active catalogue evidence';
  end if;

  return null;
end;
$$;

create constraint trigger permission_continuities_evidence
after insert or update on vortex_access.permission_continuities
deferrable initially deferred
for each row execute function vortex_access.validate_permission_continuity_evidence();

create function vortex_access.protect_application_role_template_continuity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Application role template continuity cannot be deleted';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.application_root_id is distinct from old.application_root_id
    or new.source_role_id is distinct from old.source_role_id
    or old.last_processed_registration_revision = 9007199254740991
    or new.last_processed_registration_revision <= old.last_processed_registration_revision
    or new.continuity_revision not in (
      old.continuity_revision,
      old.continuity_revision + 1
    )
    or (
      new.continuity_revision = old.continuity_revision
      and new.state is distinct from old.state
    )
    or (
      new.continuity_revision = old.continuity_revision + 1
      and new.state is not distinct from old.state
    ) then
    raise exception using errcode = '23514',
      message = 'Application role template continuity transition is invalid';
  end if;

  return new;
end;
$$;

create trigger application_role_template_continuities_protect_change
before update or delete on vortex_access.application_role_template_continuities
for each row execute function vortex_access.protect_application_role_template_continuity();

create function vortex_access.validate_application_role_template_continuity_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.state = 'available' and not exists (
    select 1
    from vortex_access.permission_registration_revisions as registration
    where registration.organization_id = new.organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = new.application_root_id
      and registration.revision = new.last_processed_registration_revision
      and registration.state = 'active'
  ) then
    raise exception using errcode = '23514',
      message = 'Available role template continuity requires an active registration revision';
  end if;

  return null;
end;
$$;

create constraint trigger application_role_template_continuities_evidence
after insert or update on vortex_access.application_role_template_continuities
deferrable initially deferred
for each row execute function
  vortex_access.validate_application_role_template_continuity_evidence();

revoke all on table vortex_access.organization_roles,
  vortex_access.organization_role_activation_policy_revisions,
  vortex_access.organization_role_revisions,
  vortex_access.organization_role_permission_entries,
  vortex_access.permission_continuities,
  vortex_access.application_role_template_continuities
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke execute on function vortex_access.protect_organization_role_identity(),
  vortex_access.refuse_organization_role_history_mutation(),
  vortex_access.validate_organization_role_revision_evidence(),
  vortex_access.protect_permission_continuity(),
  vortex_access.validate_permission_continuity_evidence(),
  vortex_access.protect_application_role_template_continuity(),
  vortex_access.validate_application_role_template_continuity_evidence()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on table vortex_access.organization_roles is
  'Private current pointer and permanent identity for one organisation-owned assignable role.';
comment on table vortex_access.organization_role_activation_policy_revisions is
  'Immutable role-scoped activation requirements; policy rows grant no authority by themselves.';
comment on table vortex_access.organization_role_revisions is
  'Immutable role lifecycle, classification, assignment policy and exact accepted source evidence.';
comment on table vortex_access.organization_role_permission_entries is
  'Immutable exact owner-qualified permissions accepted for one role revision.';
comment on table vortex_access.permission_continuities is
  'Current availability continuity or retained tombstone for one exact permission scope.';
comment on table vortex_access.application_role_template_continuities is
  'Current availability continuity or retained tombstone for one supplied application role template.';
