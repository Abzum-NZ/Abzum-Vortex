-- Organisation-local permission availability and immutable registration history.
-- Canonical Definition declarations are prepared by the server through #22;
-- these helpers remain owner-only until protected application/access operations
-- compose them with current authorisation.

create table vortex_access.permission_registrations (
  organization_id uuid not null,
  registration_kind text not null,
  registration_owner_id uuid not null,
  state text not null,
  revision bigint not null,
  source_definition_key text,
  source_version text not null,
  source_revision bigint,
  validation_contract_version text,
  source_content_fingerprint text,
  source_resolution_fingerprint text,
  permission_catalogue_fingerprint text not null,
  candidate_fingerprint text not null,
  changed_at timestamptz not null,
  changed_by uuid not null,
  change_correlation_id uuid not null,
  constraint permission_registrations_pk primary key (
    organization_id, registration_kind, registration_owner_id
  ),
  constraint permission_registrations_kind_valid check (
    registration_kind in ('platform', 'application')
  ),
  constraint permission_registrations_state_valid check (state in ('active', 'withdrawn')),
  constraint permission_registrations_owner_non_nil check (
    registration_owner_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint permission_registrations_revision_range check (
    revision between 1 and 9007199254740991
  ),
  constraint permission_registrations_source_version_format check (
    source_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  constraint permission_registrations_source_definition_key_format check (
    source_definition_key is null
    or (
      pg_catalog.char_length(source_definition_key) between 3 and 120
      and source_definition_key ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
      and source_definition_key !~ '(^|\.)[^.]{41,}(\.|$)'
    )
  ),
  constraint permission_registrations_source_revision_range check (
    source_revision is null or source_revision between 1 and 9007199254740991
  ),
  constraint permission_registrations_validation_version_format check (
    validation_contract_version is null
    or validation_contract_version ~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
  ),
  constraint permission_registrations_source_content_fingerprint_format check (
    source_content_fingerprint is null
    or source_content_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint permission_registrations_source_resolution_fingerprint_format check (
    source_resolution_fingerprint is null
    or source_resolution_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint permission_registrations_catalogue_fingerprint_format check (
    permission_catalogue_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint permission_registrations_candidate_fingerprint_format check (
    candidate_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint permission_registrations_source_shape check (
    (
      registration_kind = 'platform'
      and state = 'active'
      and registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
      and source_definition_key is null
      and source_revision is null
      and validation_contract_version is null
      and source_content_fingerprint is null
      and source_resolution_fingerprint is null
    )
    or (
      registration_kind = 'application'
      and source_definition_key is not null
      and source_revision is not null
      and validation_contract_version is not null
      and source_content_fingerprint is not null
      and source_resolution_fingerprint is not null
    )
  ),
  constraint permission_registrations_changed_by_non_nil check (
    changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint permission_registrations_correlation_non_nil check (
    change_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint permission_registrations_changed_at_finite check (
    changed_at <> '-infinity'::timestamptz and changed_at <> 'infinity'::timestamptz
  ),
  constraint permission_registrations_organization_fk foreign key (organization_id)
    references vortex_identity.organizations (organization_id)
);

create table vortex_access.permission_registration_revisions (
  organization_id uuid not null,
  registration_kind text not null,
  registration_owner_id uuid not null,
  revision bigint not null,
  state text not null,
  operation text not null,
  source_definition_key text,
  source_version text not null,
  source_revision bigint,
  validation_contract_version text,
  source_content_fingerprint text,
  source_resolution_fingerprint text,
  permission_catalogue_fingerprint text not null,
  candidate_fingerprint text not null,
  changed_at timestamptz not null,
  changed_by uuid not null,
  change_correlation_id uuid not null,
  constraint permission_registration_revisions_pk primary key (
    organization_id, registration_kind, registration_owner_id, revision
  ),
  constraint permission_registration_revisions_kind_valid check (
    registration_kind in ('platform', 'application')
  ),
  constraint permission_registration_revisions_state_valid check (
    state in ('active', 'withdrawn')
  ),
  constraint permission_registration_revisions_operation_valid check (
    operation in ('platform_initialize', 'register', 'update', 'reactivate', 'withdraw')
  ),
  constraint permission_registration_revisions_transition_shape check (
    (registration_kind = 'platform' and operation = 'platform_initialize' and state = 'active')
    or (
      registration_kind = 'application'
      and (
        (operation in ('register', 'update', 'reactivate') and state = 'active')
        or (operation = 'withdraw' and state = 'withdrawn')
      )
    )
  ),
  constraint permission_registration_revisions_owner_non_nil check (
    registration_owner_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint permission_registration_revisions_revision_range check (
    revision between 1 and 9007199254740991
  ),
  constraint permission_registration_revisions_source_version_format check (
    source_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  constraint permission_registration_revisions_source_definition_key_format check (
    source_definition_key is null
    or (
      pg_catalog.char_length(source_definition_key) between 3 and 120
      and source_definition_key ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
      and source_definition_key !~ '(^|\.)[^.]{41,}(\.|$)'
    )
  ),
  constraint permission_registration_revisions_source_revision_range check (
    source_revision is null or source_revision between 1 and 9007199254740991
  ),
  constraint permission_registration_revisions_validation_version_format check (
    validation_contract_version is null
    or validation_contract_version ~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
  ),
  constraint permission_registration_revisions_fingerprints_valid check (
    (source_content_fingerprint is null or source_content_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and (source_resolution_fingerprint is null or source_resolution_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and permission_catalogue_fingerprint ~ '^sha256:[a-f0-9]{64}$'
    and candidate_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint permission_registration_revisions_source_shape check (
    (
      registration_kind = 'platform'
      and registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
      and source_definition_key is null
      and source_revision is null
      and validation_contract_version is null
      and source_content_fingerprint is null
      and source_resolution_fingerprint is null
    )
    or (
      registration_kind = 'application'
      and source_definition_key is not null
      and source_revision is not null
      and validation_contract_version is not null
      and source_content_fingerprint is not null
      and source_resolution_fingerprint is not null
    )
  ),
  constraint permission_registration_revisions_changed_by_non_nil check (
    changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint permission_registration_revisions_correlation_non_nil check (
    change_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint permission_registration_revisions_changed_at_finite check (
    changed_at <> '-infinity'::timestamptz and changed_at <> 'infinity'::timestamptz
  ),
  constraint permission_registration_revisions_organization_fk foreign key (organization_id)
    references vortex_identity.organizations (organization_id)
);

alter table vortex_access.permission_registrations
  add constraint permission_registrations_current_revision_fk foreign key (
    organization_id, registration_kind, registration_owner_id, revision
  ) references vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision
  ) deferrable initially deferred;

create table vortex_access.permission_catalogue_entries (
  organization_id uuid not null,
  registration_kind text not null,
  registration_owner_id uuid not null,
  registration_revision bigint not null,
  application_root_id uuid,
  owner_kind text not null,
  owner_id uuid not null,
  permission_id uuid not null,
  permission_key text not null,
  label text not null,
  description text not null,
  record_type_id uuid,
  action_kind text not null,
  named_action text,
  administrative boolean not null,
  source_kind text not null,
  source_definition_key text,
  source_root_id uuid,
  source_version text not null,
  source_revision bigint,
  source_validation_contract_version text,
  source_content_fingerprint text,
  source_resolution_fingerprint text,
  source_catalogue_fingerprint text,
  meaning_fingerprint text not null,
  constraint permission_catalogue_entries_pk primary key (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    owner_kind, owner_id, permission_id
  ),
  constraint permission_catalogue_entries_owner_key_unique unique (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    owner_kind, owner_id, permission_key
  ),
  constraint permission_catalogue_entries_registration_kind_valid check (
    registration_kind in ('platform', 'application')
  ),
  constraint permission_catalogue_entries_owner_kind_valid check (
    owner_kind in ('platform', 'application', 'module')
  ),
  constraint permission_catalogue_entries_source_kind_valid check (
    source_kind in ('platform_catalogue', 'application', 'module')
  ),
  constraint permission_catalogue_entries_ids_non_nil check (
    registration_owner_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and owner_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and permission_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and (application_root_id is null or application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and (record_type_id is null or record_type_id <> '00000000-0000-0000-0000-000000000000'::uuid)
  ),
  constraint permission_catalogue_entries_revision_range check (
    registration_revision between 1 and 9007199254740991
    and (source_revision is null or source_revision between 1 and 9007199254740991)
  ),
  constraint permission_catalogue_entries_permission_key_format check (
    pg_catalog.char_length(permission_key) between 3 and 120
    and permission_key ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    and permission_key !~ '(^|\.)[^.]{41,}(\.|$)'
  ),
  constraint permission_catalogue_entries_source_definition_key_format check (
    source_definition_key is null
    or (
      pg_catalog.char_length(source_definition_key) between 3 and 120
      and source_definition_key ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
      and source_definition_key !~ '(^|\.)[^.]{41,}(\.|$)'
    )
  ),
  constraint permission_catalogue_entries_label_valid check (
    label = pg_catalog.btrim(label) and pg_catalog.char_length(label) between 1 and 60
  ),
  constraint permission_catalogue_entries_description_valid check (
    description = pg_catalog.btrim(description)
    and pg_catalog.char_length(description) between 1 and 1000
  ),
  constraint permission_catalogue_entries_action_kind_valid check (
    action_kind in ('create', 'read', 'update', 'delete', 'restore', 'export', 'share', 'manage', 'named')
  ),
  constraint permission_catalogue_entries_named_action_shape check (
    (action_kind = 'named') = (named_action is not null)
    and (
      named_action is null
      or (
        pg_catalog.char_length(named_action) between 1 and 40
        and named_action ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      )
    )
  ),
  constraint permission_catalogue_entries_source_version_format check (
    source_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  constraint permission_catalogue_entries_validation_version_format check (
    source_validation_contract_version is null
    or source_validation_contract_version ~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
  ),
  constraint permission_catalogue_entries_fingerprints_valid check (
    (source_content_fingerprint is null or source_content_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and (source_resolution_fingerprint is null or source_resolution_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and (source_catalogue_fingerprint is null or source_catalogue_fingerprint ~ '^sha256:[a-f0-9]{64}$')
    and meaning_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint permission_catalogue_entries_scope_shape check (
    (
      registration_kind = 'platform'
      and registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
      and application_root_id is null
      and owner_kind = 'platform'
      and owner_id = registration_owner_id
      and source_kind = 'platform_catalogue'
      and source_definition_key is null
      and source_root_id is null
      and source_revision is null
      and source_validation_contract_version is null
      and source_content_fingerprint is null
      and source_resolution_fingerprint is null
      and source_catalogue_fingerprint is not null
    )
    or (
      registration_kind = 'application'
      and application_root_id = registration_owner_id
      and owner_kind in ('application', 'module')
      and source_kind = owner_kind
      and source_definition_key is not null
      and source_root_id = owner_id
      and source_revision is not null
      and source_validation_contract_version is not null
      and source_content_fingerprint is not null
      and source_resolution_fingerprint is not null
      and source_catalogue_fingerprint is null
      and (owner_kind <> 'application' or owner_id = application_root_id)
    )
  ),
  constraint permission_catalogue_entries_revision_fk foreign key (
    organization_id, registration_kind, registration_owner_id, registration_revision
  ) references vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision
  )
);

create index permission_catalogue_entries_current_lookup_idx
  on vortex_access.permission_catalogue_entries (
    organization_id, application_root_id, owner_kind, owner_id, permission_id,
    registration_kind, registration_owner_id, registration_revision
  );

alter table vortex_access.permission_registrations enable row level security;
alter table vortex_access.permission_registrations force row level security;
alter table vortex_access.permission_registration_revisions enable row level security;
alter table vortex_access.permission_registration_revisions force row level security;
alter table vortex_access.permission_catalogue_entries enable row level security;
alter table vortex_access.permission_catalogue_entries force row level security;

create function vortex_access.protect_permission_registration()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'Permission registrations cannot be deleted';
  end if;
  if new.organization_id is distinct from old.organization_id
    or new.registration_kind is distinct from old.registration_kind
    or new.registration_owner_id is distinct from old.registration_owner_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at then
    raise exception using errcode = '23514', message = 'Permission registration updates require one permanent-scope revision';
  end if;
  return new;
end
$function$;

create trigger permission_registrations_protect_change
before update or delete on vortex_access.permission_registrations
for each row execute function vortex_access.protect_permission_registration();

create function vortex_access.refuse_permission_registration_history_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using errcode = '23514', message = 'Permission registration history is immutable';
end
$function$;

create trigger permission_registration_revisions_immutable
before update or delete on vortex_access.permission_registration_revisions
for each row execute function vortex_access.refuse_permission_registration_history_mutation();
create trigger permission_catalogue_entries_immutable
before update or delete on vortex_access.permission_catalogue_entries
for each row execute function vortex_access.refuse_permission_registration_history_mutation();

create function vortex_access.initialize_platform_permission_catalogue(
  p_organization_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  organization_id uuid,
  registration_revision bigint,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_registration vortex_access.permission_registrations%rowtype;
  resulting_version bigint;
  catalogue_fingerprint constant text := 'sha256:f618491ff7091595ba5dde875e030bfdf7c4bdfe49572a3428914e91a6fe25bd';
  catalogue_entries constant jsonb := $catalogue$[
    {"permissionId":"687d5649-62ee-43dd-b684-b8af3a5394c1","key":"platform.organization.permissions.read","label":"View available permissions","description":"View the selected organisation's registered permission catalogue without receiving use or assignment authority.","actionKind":"read","meaningFingerprint":"sha256:be47b7066dd31f8797452f035cadcb18ef6ead6ff06bec6d3ec54ff769812567"},
    {"permissionId":"ca5f56d4-5382-4bf8-9a91-fbfdc77642b2","key":"platform.organization.roles.read","label":"View roles","description":"View the selected organisation's live roles and registered application role templates.","actionKind":"read","meaningFingerprint":"sha256:87c065a43a5dc6676c3276aea10d4ad848665c07a39393dae237e72d6582367b"},
    {"permissionId":"87c96495-c806-4692-9bc2-250ddb10613c","key":"platform.organization.roles.manage","label":"Manage roles","description":"Create, change or retire roles only within the actor's explicit delegated scope.","actionKind":"manage","meaningFingerprint":"sha256:91eb8281f4905ef55dbe5acf537d49febeede8df37aeaf2ff69292107a59ae2b"},
    {"permissionId":"290ae49f-4cab-4159-9c20-6e664f07d50b","key":"platform.organization.teams.read","label":"View teams","description":"View the selected organisation's Teams and membership administration data.","actionKind":"read","meaningFingerprint":"sha256:b91f3b608e3a1f7426040b0e947727726f1eab888eb2bb5a87f613bd266ebb2f"},
    {"permissionId":"6185dc64-464b-4776-97dc-c64a6f299550","key":"platform.organization.teams.manage","label":"Manage teams","description":"Manage Teams and memberships subject to delegated scope and permanent-steward safeguards.","actionKind":"manage","meaningFingerprint":"sha256:094f5e4fe28756a9497a33b357f6bd9fa7283fe0e53ada77b5b6894bcebff4a5"},
    {"permissionId":"9901c0dc-8bac-45c7-be0b-3642cb839bb1","key":"platform.organization.assignments.read","label":"View access assignments","description":"View the selected organisation's role and delegation assignments and their effective scope.","actionKind":"read","meaningFingerprint":"sha256:e46f5f2b4e9dcf77e6f96918828c7421044605b35216c5eecc0e29909c9a6848"},
    {"permissionId":"156d01f3-8f80-45fb-8fc8-b31c47dbb1df","key":"platform.organization.assignments.manage","label":"Manage access assignments","description":"Grant, change or revoke use and delegation assignments only within the actor's explicit delegated scope.","actionKind":"manage","meaningFingerprint":"sha256:9c2cf2b688335a1c3edf32d397c7a9e611743736680e30c3672dfaf11c7a9f36"},
    {"permissionId":"02c772e5-2921-4300-ad90-4f5772a7fa46","key":"platform.organization.accounts.read","label":"View organisation accounts","description":"View the selected organisation's safe account-administration information.","actionKind":"read","meaningFingerprint":"sha256:51234f517c9a62379cecc8ef047c3b5266096381dbc58e77d8a889fc3be32641"},
    {"permissionId":"630a980c-0ff5-40b1-a329-7326a2122395","key":"platform.organization.accounts.manage","label":"Manage organisation accounts","description":"Change organisation-account lifecycle through the protected operation without changing global identity or removing the final permanent steward.","actionKind":"manage","meaningFingerprint":"sha256:59439415b18b92167020f82086693b45cd238c9c4b8ac6fdd3ce071bc6d5b9e0"},
    {"permissionId":"9300e501-6d56-41b1-b203-3361dbace9bc","key":"platform.organization.invitations.read","label":"View invitations","description":"View safe invitation administration metadata without the raw invitation secret or its stored fingerprint.","actionKind":"read","meaningFingerprint":"sha256:b4462ee4471b7c93d820caef5690a31f7e7be4070e3ba8b7e83fe2e68b024cd8"},
    {"permissionId":"c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb","key":"platform.organization.invitations.manage","label":"Manage invitations","description":"Create or revoke invitations through the protected operation; role assignment additionally requires the actor's assignment authority.","actionKind":"manage","meaningFingerprint":"sha256:65b1804f9f5148adfb06d50ac16243b9711cab368b8c9950ff935e2e89a69154"},
    {"permissionId":"6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5","key":"platform.organization.runtime_settings.read","label":"View organisation display settings","description":"View the organisation's default language, time zone, currency, date and number display settings.","actionKind":"read","meaningFingerprint":"sha256:cba574ab17eff487cc68f32e8ce013eea83570060f17f73b02e91764f665120a"},
    {"permissionId":"c658c254-2884-414a-9012-512c0cfe4b34","key":"platform.organization.runtime_settings.manage","label":"Manage organisation display settings","description":"Change the organisation's validated default display settings through the protected revision-checked operation.","actionKind":"manage","meaningFingerprint":"sha256:e79914b57f2c0b37bb07698bee58dc8557762020d3f082e19a4ceb8304b8e4f7"}
  ]$catalogue$::jsonb;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Platform permission registration input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501', message = 'Platform permission registration scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid;

  if found then
    if current_registration.state <> 'active'
      or current_registration.revision <> 1
      or current_registration.source_version <> '1.0.0'
      or current_registration.permission_catalogue_fingerprint <> catalogue_fingerprint
      or current_registration.candidate_fingerprint <> catalogue_fingerprint then
      raise exception using errcode = '55000', message = 'Platform permission registration evidence is invalid';
    end if;
    return query
    select current_registration.organization_id, current_registration.revision,
      version.current_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return;
  end if;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision, state, operation,
    source_definition_key, source_version, source_revision, validation_contract_version,
    source_content_fingerprint, source_resolution_fingerprint,
    permission_catalogue_fingerprint, candidate_fingerprint,
    changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 1,
    'active', 'platform_initialize', null, '1.0.0', null, null, null, null,
    catalogue_fingerprint, catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    application_root_id, owner_kind, owner_id, permission_id, permission_key,
    label, description, record_type_id, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint, meaning_fingerprint
  )
  select p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 1,
    null, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8',
    (entry ->> 'permissionId')::uuid, entry ->> 'key', entry ->> 'label',
    entry ->> 'description', null, entry ->> 'actionKind', null, true,
    'platform_catalogue', null, null, '1.0.0', null, null, null, null,
    catalogue_fingerprint, entry ->> 'meaningFingerprint'
  from pg_catalog.jsonb_array_elements(catalogue_entries) as item(entry);

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state, revision,
    source_definition_key, source_version, source_revision, validation_contract_version,
    source_content_fingerprint, source_resolution_fingerprint,
    permission_catalogue_fingerprint, candidate_fingerprint,
    changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'active', 1,
    null, '1.0.0', null, null, null, null, catalogue_fingerprint, catalogue_fingerprint,
    operation_at, p_changed_by, p_correlation_id
  );

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'application_access_changed'
  ) as incremented;
  return query select p_organization_id, 1::bigint, resulting_version;
end
$function$;

create function vortex_access.apply_application_permission_registration(
  p_operation text,
  p_expected_revision bigint,
  p_candidate jsonb,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  operation text,
  organization_id uuid,
  application_root_id uuid,
  registration_state text,
  registration_revision bigint,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  candidate_organization_id uuid;
  candidate_application_root_id uuid;
  candidate_release jsonb;
  candidate_release_revision bigint;
  candidate_release_version text;
  candidate_validation_version text;
  candidate_content_fingerprint text;
  candidate_resolution_fingerprint text;
  candidate_catalogue_fingerprint text;
  supplied_candidate_fingerprint text;
  current_registration vortex_access.permission_registrations%rowtype;
  next_revision bigint;
  resulting_version bigint;
  entry_value jsonb;
  permission_value jsonb;
  source_value jsonb;
  entry_owner_kind text;
  entry_owner_id uuid;
  entry_source_revision bigint;
  canonical_application_permissions jsonb;
begin
  if p_operation not in ('register', 'update', 'reactivate')
    or p_candidate is null
    or pg_catalog.jsonb_typeof(p_candidate) <> 'object'
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'register' and p_expected_revision is not null)
    or (p_operation <> 'register' and (p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991))
    or p_candidate - array[
      'contractVersion', 'organizationId', 'applicationRootId', 'applicationRelease',
      'applicationCatalogueFingerprint', 'applicationPermissionIds', 'entries',
      'candidateFingerprint'
    ]::text[] <> '{}'::jsonb
    or not (p_candidate ?& array[
      'contractVersion', 'organizationId', 'applicationRootId', 'applicationRelease',
      'applicationCatalogueFingerprint', 'applicationPermissionIds', 'entries',
      'candidateFingerprint'
    ])
    or p_candidate ->> 'contractVersion' <> '1.0.0'
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationRelease') <> 'object'
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationPermissionIds') <> 'array'
    or pg_catalog.jsonb_typeof(p_candidate -> 'entries') <> 'array' then
    raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
  end if;

  begin
    candidate_organization_id := (p_candidate ->> 'organizationId')::uuid;
    candidate_application_root_id := (p_candidate ->> 'applicationRootId')::uuid;
    candidate_release := p_candidate -> 'applicationRelease';
    candidate_release_revision := (candidate_release ->> 'releaseRevision')::bigint;
    candidate_release_version := candidate_release ->> 'releaseVersion';
    candidate_validation_version := candidate_release ->> 'validationContractVersion';
    candidate_content_fingerprint := candidate_release ->> 'contentFingerprint';
    candidate_resolution_fingerprint := candidate_release ->> 'resolutionFingerprint';
    candidate_catalogue_fingerprint := p_candidate ->> 'applicationCatalogueFingerprint';
    supplied_candidate_fingerprint := p_candidate ->> 'candidateFingerprint';
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
  end;

  if candidate_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or candidate_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or candidate_release - array[
      'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
      'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
    ]::text[] <> '{}'::jsonb
    or not (candidate_release ?& array[
      'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
      'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
    ])
    or candidate_release ->> 'kind' <> 'application'
    or (candidate_release ->> 'rootId')::uuid <> candidate_application_root_id
    or candidate_release_revision not between 1 and 9007199254740991
    or candidate_catalogue_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or supplied_candidate_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = candidate_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501', message = 'Application permission registration scope is unavailable';
  end if;

  select release.compilation_output #> '{canonical,content,permissions}'
  into canonical_application_permissions
    from vortex_definition.roots as root
    join vortex_definition.releases as release on release.root_id = root.root_id
    where root.root_id = candidate_application_root_id
      and root.organization_id = candidate_organization_id
      and root.kind = 'application'
      and root.key = candidate_release ->> 'definitionKey'
      and release.release_revision = candidate_release_revision
      and release.release_version = candidate_release_version
      and release.validation_contract_version = candidate_validation_version
      and release.content_fingerprint = candidate_content_fingerprint
      and release.resolution_fingerprint = candidate_resolution_fingerprint;
  if not found
    or pg_catalog.jsonb_typeof(canonical_application_permissions) is distinct from 'array' then
    raise exception using errcode = '40001', message = 'Application permission release evidence is stale or unavailable';
  end if;

  for entry_value in
    select item.entry from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry)
  loop
    if pg_catalog.jsonb_typeof(entry_value) <> 'object'
      or entry_value - array[
        'applicationRootId', 'ownerKind', 'ownerId', 'permission',
        'sourceRelease', 'meaningFingerprint'
      ]::text[] <> '{}'::jsonb
      or (entry_value ->> 'applicationRootId')::uuid <> candidate_application_root_id
      or pg_catalog.jsonb_typeof(entry_value -> 'permission') <> 'object'
      or pg_catalog.jsonb_typeof(entry_value -> 'sourceRelease') <> 'object'
      or entry_value ->> 'meaningFingerprint' !~ '^sha256:[a-f0-9]{64}$' then
      raise exception using errcode = '22023', message = 'Application permission entry is invalid';
    end if;
    permission_value := entry_value -> 'permission';
    source_value := entry_value -> 'sourceRelease';
    begin
      entry_owner_kind := entry_value ->> 'ownerKind';
      entry_owner_id := (entry_value ->> 'ownerId')::uuid;
      entry_source_revision := (source_value ->> 'releaseRevision')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '22023', message = 'Application permission entry is invalid';
    end;
    if entry_owner_kind not in ('application', 'module')
      or entry_owner_id = '00000000-0000-0000-0000-000000000000'::uuid
      or permission_value - array[
        'permissionId', 'key', 'label', 'description', 'recordTypeId',
        'actionKind', 'namedAction', 'administrative'
      ]::text[] <> '{}'::jsonb
      or not (permission_value ?& array[
        'permissionId', 'key', 'label', 'description', 'actionKind', 'administrative'
      ])
      or source_value - array[
        'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
        'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
      ]::text[] <> '{}'::jsonb
      or not (source_value ?& array[
        'kind', 'definitionKey', 'rootId', 'releaseRevision', 'releaseVersion',
        'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
      ])
      or source_value ->> 'kind' <> entry_owner_kind
      or (source_value ->> 'rootId')::uuid <> entry_owner_id
      or entry_source_revision not between 1 and 9007199254740991 then
      raise exception using errcode = '22023', message = 'Application permission entry is invalid';
    end if;
    if entry_owner_kind = 'application' then
      if entry_owner_id <> candidate_application_root_id or source_value <> candidate_release then
        raise exception using errcode = '40001', message = 'Application permission ownership evidence is stale or unavailable';
      end if;
    elsif not exists (
      select 1
      from vortex_definition.release_dependencies as dependency
      join vortex_definition.roots as module_root on module_root.root_id = dependency.target_root_id
      join vortex_definition.releases as module_release
        on module_release.root_id = dependency.target_root_id
        and module_release.release_revision = dependency.target_release_revision
      where dependency.root_id = candidate_application_root_id
        and dependency.release_revision = candidate_release_revision
        and dependency.dependency_kind = 'module'
        and dependency.target_root_id = entry_owner_id
        and dependency.target_release_revision = entry_source_revision
        and dependency.dependency_reference = source_value ->> 'definitionKey'
        and dependency.dependency_version = source_value ->> 'releaseVersion'
        and dependency.dependency_content_fingerprint = source_value ->> 'contentFingerprint'
        and dependency.evidence_fingerprint = source_value ->> 'resolutionFingerprint'
        and module_root.organization_id = candidate_organization_id
        and module_root.kind = 'module'
        and module_root.key = source_value ->> 'definitionKey'
        and module_release.release_version = source_value ->> 'releaseVersion'
        and module_release.validation_contract_version = source_value ->> 'validationContractVersion'
        and module_release.content_fingerprint = source_value ->> 'contentFingerprint'
        and module_release.resolution_fingerprint = source_value ->> 'resolutionFingerprint'
    ) then
      raise exception using errcode = '40001', message = 'Module permission ownership evidence is stale or unavailable';
    end if;
  end loop;

  if coalesce(
    (
      select pg_catalog.jsonb_agg(permission_value order by
        (permission_value ->> 'key') collate "C",
        (permission_value ->> 'permissionId') collate "C")
      from pg_catalog.jsonb_array_elements(canonical_application_permissions) as stored(permission_value)
    ),
    '[]'::jsonb
  ) is distinct from coalesce(
    (
      select pg_catalog.jsonb_agg(item.entry_value -> 'permission' order by
        (item.entry_value #>> '{permission,key}') collate "C",
        (item.entry_value #>> '{permission,permissionId}') collate "C")
      from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
      where item.entry_value ->> 'ownerKind' = 'application'
    ),
    '[]'::jsonb
  ) then
    raise exception using errcode = '40001', message = 'Application permission declarations are stale or unavailable';
  end if;

  if exists (
    select 1
    from vortex_definition.release_dependencies as dependency
    join vortex_definition.releases as module_release
      on module_release.root_id = dependency.target_root_id
      and module_release.release_revision = dependency.target_release_revision
    where dependency.root_id = candidate_application_root_id
      and dependency.release_revision = candidate_release_revision
      and dependency.dependency_kind = 'module'
      and (
        pg_catalog.jsonb_typeof(
          module_release.compilation_output #> '{canonical,content,permissions}'
        ) is distinct from 'array'
        or coalesce(
          (
            select pg_catalog.jsonb_agg(permission_value order by
              (permission_value ->> 'key') collate "C",
              (permission_value ->> 'permissionId') collate "C")
            from pg_catalog.jsonb_array_elements(
              module_release.compilation_output #> '{canonical,content,permissions}'
            ) as stored(permission_value)
          ),
          '[]'::jsonb
        ) is distinct from coalesce(
          (
            select pg_catalog.jsonb_agg(item.entry_value -> 'permission' order by
              (item.entry_value #>> '{permission,key}') collate "C",
              (item.entry_value #>> '{permission,permissionId}') collate "C")
            from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
            where item.entry_value ->> 'ownerKind' = 'module'
              and (item.entry_value ->> 'ownerId')::uuid = dependency.target_root_id
          ),
          '[]'::jsonb
        )
      )
  ) then
    raise exception using errcode = '40001', message = 'Module permission declarations are stale or unavailable';
  end if;

  if coalesce(
    (
      select pg_catalog.jsonb_agg(item.entry_value order by
        (item.entry_value ->> 'ownerKind') collate "C",
        (item.entry_value ->> 'ownerId') collate "C",
        (item.entry_value #>> '{permission,key}') collate "C",
        (item.entry_value #>> '{permission,permissionId}') collate "C")
      from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
    ),
    '[]'::jsonb
  ) <> p_candidate -> 'entries' then
    raise exception using errcode = '22023', message = 'Application permission entry order is invalid';
  end if;

  if (
    select coalesce(
      pg_catalog.jsonb_agg(permission.permission_value ->> 'permissionId' order by
        (permission.permission_value ->> 'key') collate "C",
        (permission.permission_value ->> 'permissionId') collate "C"),
      '[]'::jsonb
    )
    from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
    cross join lateral (select item.entry_value -> 'permission' as permission_value) as permission
    where item.entry_value ->> 'ownerKind' = 'application'
      and (permission.permission_value ->> 'administrative')::boolean = false
  ) <> p_candidate -> 'applicationPermissionIds' then
    raise exception using errcode = '22023', message = 'Application permission snapshot is invalid';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = candidate_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = candidate_application_root_id;

  if p_operation = 'register' then
    if found then
      raise exception using errcode = '40001', message = 'Application permission registration already exists';
    end if;
    next_revision := 1;
  else
    if not found
      or current_registration.revision <> p_expected_revision
      or current_registration.revision = 9007199254740991
      or (p_operation = 'update' and current_registration.state <> 'active')
      or (p_operation = 'reactivate' and current_registration.state <> 'withdrawn') then
      raise exception using errcode = '40001', message = 'Application permission registration revision is stale or unavailable';
    end if;
    next_revision := current_registration.revision + 1;
  end if;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision, state, operation,
    source_definition_key, source_version, source_revision, validation_contract_version,
    source_content_fingerprint, source_resolution_fingerprint,
    permission_catalogue_fingerprint, candidate_fingerprint,
    changed_at, changed_by, change_correlation_id
  ) values (
    candidate_organization_id, 'application', candidate_application_root_id,
    next_revision, 'active', p_operation, candidate_release ->> 'definitionKey', candidate_release_version,
    candidate_release_revision, candidate_validation_version,
    candidate_content_fingerprint, candidate_resolution_fingerprint,
    candidate_catalogue_fingerprint, supplied_candidate_fingerprint,
    operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id, registration_revision,
    application_root_id, owner_kind, owner_id, permission_id, permission_key,
    label, description, record_type_id, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint, meaning_fingerprint
  )
  select candidate_organization_id, 'application', candidate_application_root_id,
    next_revision, candidate_application_root_id, item.entry_value ->> 'ownerKind',
    (item.entry_value ->> 'ownerId')::uuid,
    (permission.permission_value ->> 'permissionId')::uuid,
    permission.permission_value ->> 'key', permission.permission_value ->> 'label',
    permission.permission_value ->> 'description',
    (permission.permission_value ->> 'recordTypeId')::uuid,
    permission.permission_value ->> 'actionKind',
    permission.permission_value ->> 'namedAction',
    (permission.permission_value ->> 'administrative')::boolean,
    source.source_value ->> 'kind', source.source_value ->> 'definitionKey',
    (source.source_value ->> 'rootId')::uuid, source.source_value ->> 'releaseVersion',
    (source.source_value ->> 'releaseRevision')::bigint,
    source.source_value ->> 'validationContractVersion',
    source.source_value ->> 'contentFingerprint',
    source.source_value ->> 'resolutionFingerprint', null,
    item.entry_value ->> 'meaningFingerprint'
  from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(entry_value)
  cross join lateral (select item.entry_value -> 'permission' as permission_value) as permission
  cross join lateral (select item.entry_value -> 'sourceRelease' as source_value) as source;

  if p_operation = 'register' then
    insert into vortex_access.permission_registrations (
      organization_id, registration_kind, registration_owner_id, state, revision,
      source_definition_key, source_version, source_revision, validation_contract_version,
      source_content_fingerprint, source_resolution_fingerprint,
      permission_catalogue_fingerprint, candidate_fingerprint,
      changed_at, changed_by, change_correlation_id
    ) values (
      candidate_organization_id, 'application', candidate_application_root_id,
      'active', next_revision, candidate_release ->> 'definitionKey', candidate_release_version,
      candidate_release_revision,
      candidate_validation_version, candidate_content_fingerprint,
      candidate_resolution_fingerprint, candidate_catalogue_fingerprint,
      supplied_candidate_fingerprint, operation_at, p_changed_by, p_correlation_id
    );
  else
    update vortex_access.permission_registrations as registration
    set state = 'active', revision = next_revision,
        source_definition_key = candidate_release ->> 'definitionKey',
        source_version = candidate_release_version,
        source_revision = candidate_release_revision,
        validation_contract_version = candidate_validation_version,
        source_content_fingerprint = candidate_content_fingerprint,
        source_resolution_fingerprint = candidate_resolution_fingerprint,
        permission_catalogue_fingerprint = candidate_catalogue_fingerprint,
        candidate_fingerprint = supplied_candidate_fingerprint,
        changed_at = operation_at, changed_by = p_changed_by,
        change_correlation_id = p_correlation_id
    where registration.organization_id = candidate_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = candidate_application_root_id;
  end if;

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    candidate_organization_id, p_changed_by, p_correlation_id, 'application_access_changed'
  ) as incremented;

  return query select p_operation, candidate_organization_id, candidate_application_root_id,
    'active'::text, next_revision, resulting_version, p_correlation_id;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'Application permission registration input is invalid';
end
$function$;

create function vortex_access.withdraw_application_permission_registration(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_expected_revision bigint,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  operation text,
  organization_id uuid,
  application_root_id uuid,
  registration_state text,
  registration_revision bigint,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_registration vortex_access.permission_registrations%rowtype;
  next_revision bigint;
  resulting_version bigint;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Application permission withdrawal input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501', message = 'Application permission withdrawal scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id;
  if not found
    or current_registration.state <> 'active'
    or current_registration.revision <> p_expected_revision
    or current_registration.revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Application permission registration revision is stale or unavailable';
  end if;
  next_revision := current_registration.revision + 1;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision, state, operation,
    source_definition_key, source_version, source_revision, validation_contract_version,
    source_content_fingerprint, source_resolution_fingerprint,
    permission_catalogue_fingerprint, candidate_fingerprint,
    changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'application', p_application_root_id, next_revision,
    'withdrawn', 'withdraw', current_registration.source_definition_key,
    current_registration.source_version,
    current_registration.source_revision, current_registration.validation_contract_version,
    current_registration.source_content_fingerprint,
    current_registration.source_resolution_fingerprint,
    current_registration.permission_catalogue_fingerprint,
    current_registration.candidate_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries
  select entry.organization_id, entry.registration_kind, entry.registration_owner_id,
    next_revision, entry.application_root_id, entry.owner_kind, entry.owner_id,
    entry.permission_id, entry.permission_key, entry.label, entry.description,
    entry.record_type_id, entry.action_kind, entry.named_action, entry.administrative,
    entry.source_kind, entry.source_definition_key, entry.source_root_id,
    entry.source_version, entry.source_revision, entry.source_validation_contract_version,
    entry.source_content_fingerprint, entry.source_resolution_fingerprint,
    entry.source_catalogue_fingerprint, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = p_application_root_id
    and entry.registration_revision = current_registration.revision;

  update vortex_access.permission_registrations as registration
  set state = 'withdrawn', revision = next_revision, changed_at = operation_at,
      changed_by = p_changed_by, change_correlation_id = p_correlation_id
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id;

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'application_access_changed'
  ) as incremented;
  return query select 'withdraw'::text, p_organization_id, p_application_root_id,
    'withdrawn'::text, next_revision, resulting_version, p_correlation_id;
end
$function$;

create function vortex_access.read_available_permission(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_owner_kind text,
  p_owner_id uuid,
  p_permission_id uuid
)
returns table (
  organization_id uuid,
  application_root_id uuid,
  registration_revision bigint,
  owner_kind text,
  owner_id uuid,
  permission_id uuid,
  permission_key text,
  label text,
  description text,
  record_type_id uuid,
  action_kind text,
  named_action text,
  administrative boolean,
  source_kind text,
  source_definition_key text,
  source_root_id uuid,
  source_version text,
  source_revision bigint,
  source_validation_contract_version text,
  source_content_fingerprint text,
  source_resolution_fingerprint text,
  source_catalogue_fingerprint text,
  meaning_fingerprint text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select entry.organization_id, entry.application_root_id, entry.registration_revision,
    entry.owner_kind, entry.owner_id, entry.permission_id, entry.permission_key,
    entry.label, entry.description, entry.record_type_id, entry.action_kind,
    entry.named_action, entry.administrative, entry.source_kind,
    entry.source_definition_key, entry.source_root_id, entry.source_version,
    entry.source_revision, entry.source_validation_contract_version,
    entry.source_content_fingerprint, entry.source_resolution_fingerprint,
    entry.source_catalogue_fingerprint, entry.meaning_fingerprint
  from vortex_access.permission_registrations as registration
  join vortex_access.permission_catalogue_entries as entry
    on entry.organization_id = registration.organization_id
    and entry.registration_kind = registration.registration_kind
    and entry.registration_owner_id = registration.registration_owner_id
    and entry.registration_revision = registration.revision
  where registration.organization_id = p_organization_id
    and registration.state = 'active'
    and entry.owner_kind = p_owner_kind
    and entry.owner_id = p_owner_id
    and entry.permission_id = p_permission_id
    and (
      (p_owner_kind = 'platform' and p_application_root_id is null and entry.application_root_id is null)
      or (
        p_owner_kind in ('application', 'module')
        and p_application_root_id is not null
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_application_root_id
        and entry.application_root_id = p_application_root_id
      )
    )
$function$;

create function vortex_access.read_application_permission_snapshot(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns table (
  organization_id uuid,
  application_root_id uuid,
  registration_revision bigint,
  release_revision bigint,
  definition_key text,
  release_version text,
  validation_contract_version text,
  content_fingerprint text,
  resolution_fingerprint text,
  catalogue_fingerprint text,
  permission_ids uuid[]
)
language sql
stable
security definer
set search_path = ''
as $function$
  select registration.organization_id, registration.registration_owner_id,
    registration.revision, registration.source_revision, registration.source_definition_key,
    registration.source_version,
    registration.validation_contract_version, registration.source_content_fingerprint,
    registration.source_resolution_fingerprint,
    registration.permission_catalogue_fingerprint,
    coalesce(
      pg_catalog.array_agg(entry.permission_id order by
        entry.permission_key collate "C", entry.permission_id)
        filter (where entry.permission_id is not null),
      array[]::uuid[]
    )
  from vortex_access.permission_registrations as registration
  left join vortex_access.permission_catalogue_entries as entry
    on entry.organization_id = registration.organization_id
    and entry.registration_kind = registration.registration_kind
    and entry.registration_owner_id = registration.registration_owner_id
    and entry.registration_revision = registration.revision
    and entry.owner_kind = 'application'
    and entry.administrative = false
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
    and registration.state = 'active'
  group by registration.organization_id, registration.registration_owner_id,
    registration.revision, registration.source_revision, registration.source_definition_key,
    registration.source_version,
    registration.validation_contract_version, registration.source_content_fingerprint,
    registration.source_resolution_fingerprint,
    registration.permission_catalogue_fingerprint
$function$;

revoke all on table vortex_access.permission_registrations,
  vortex_access.permission_registration_revisions,
  vortex_access.permission_catalogue_entries
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.protect_permission_registration(),
  vortex_access.refuse_permission_registration_history_mutation(),
  vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid),
  vortex_access.apply_application_permission_registration(text, bigint, jsonb, uuid, uuid),
  vortex_access.withdraw_application_permission_registration(uuid, uuid, bigint, uuid, uuid),
  vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid),
  vortex_access.read_application_permission_snapshot(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on table vortex_access.permission_registrations is
  'Current organisation-local platform or application permission availability pointer.';
comment on table vortex_access.permission_registration_revisions is
  'Immutable permission registration lifecycle and exact source evidence.';
comment on table vortex_access.permission_catalogue_entries is
  'Immutable owner-qualified permissions supplied by one exact registration revision.';
comment on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid) is
  'Owner-only explicit organisation registration of the closed platform permission catalogue.';
comment on function vortex_access.apply_application_permission_registration(text, bigint, jsonb, uuid, uuid) is
  'Owner-only apply of a server-prepared canonical application permission candidate.';
comment on function vortex_access.withdraw_application_permission_registration(uuid, uuid, bigint, uuid, uuid) is
  'Owner-only revision-checked application permission withdrawal.';
comment on function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid) is
  'Owner-only exact current permission lookup retaining application context.';
comment on function vortex_access.read_application_permission_snapshot(uuid, uuid) is
  'Owner-only active exact release reference and deterministic application-only permission snapshot; role templates remain in Definition.';
