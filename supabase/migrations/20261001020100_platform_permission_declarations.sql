begin;

set local role vortex_access_owner;

create table vortex_access.platform_permission_declarations (
  owner_kind text not null default 'platform',
  owner_id uuid not null default 'cabe121e-0baf-4084-9471-cce915d460a8',
  permission_id uuid not null,
  permission_key text not null,
  action_kind text not null,
  label text not null,
  description text not null,
  meaning_fingerprint text not null,
  source_module_key text not null,
  steward_minimum boolean not null default false,
  first_revision bigint not null,
  constraint platform_permission_declarations_pk primary key (permission_id),
  constraint platform_permission_declarations_key_unique unique (permission_key),
  constraint platform_permission_declarations_owner_scope check (
    owner_kind = 'platform'
    and owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
  ),
  constraint platform_permission_declarations_id_non_nil check (
    permission_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint platform_permission_declarations_key_format check (
    pg_catalog.char_length(permission_key) between 3 and 120
    and permission_key ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    and permission_key !~ '(^|\.)[^.]{41,}(\.|$)'
  ),
  constraint platform_permission_declarations_action_kind_valid check (
    action_kind in ('create', 'read', 'update', 'delete', 'restore', 'export', 'share', 'manage', 'named')
  ),
  constraint platform_permission_declarations_label_valid check (
    label = pg_catalog.btrim(label)
    and pg_catalog.char_length(label) between 1 and 60
  ),
  constraint platform_permission_declarations_description_valid check (
    description = pg_catalog.btrim(description)
    and pg_catalog.char_length(description) between 1 and 1000
  ),
  constraint platform_permission_declarations_fingerprint_valid check (
    meaning_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint platform_permission_declarations_source_module_valid check (
    source_module_key in ('organisation-administration', 'system-core')
  ),
  constraint platform_permission_declarations_first_revision_valid check (
    first_revision between 1 and 9007199254740991
  )
);

comment on table vortex_access.platform_permission_declarations is
  'Current declared platform permissions, scoped to the permanent platform owner; first_revision records immutable catalogue history.';

comment on column vortex_access.platform_permission_declarations.source_module_key is
  'System module source that owns this declaration, independent of its permanent platform permission owner.';

comment on column vortex_access.platform_permission_declarations.steward_minimum is
  'Whether this permission is part of the guarded permanent-steward minimum.';

comment on column vortex_access.platform_permission_declarations.first_revision is
  'First immutable platform catalogue revision containing this permission.';

insert into vortex_access.platform_permission_declarations (
  permission_id, permission_key, action_kind, label, description,
  meaning_fingerprint, source_module_key, steward_minimum, first_revision
) values
  (
    '687d5649-62ee-43dd-b684-b8af3a5394c1',
    'platform.organization.permissions.read',
    'read',
    'View available permissions',
    'View the selected organisation''s registered permission catalogue without receiving use or assignment authority.',
    'sha256:be47b7066dd31f8797452f035cadcb18ef6ead6ff06bec6d3ec54ff769812567',
    'organisation-administration',
    true,
    1
  ),
  (
    'ca5f56d4-5382-4bf8-9a91-fbfdc77642b2',
    'platform.organization.roles.read',
    'read',
    'View roles',
    'View the selected organisation''s live roles and registered application role templates.',
    'sha256:87c065a43a5dc6676c3276aea10d4ad848665c07a39393dae237e72d6582367b',
    'organisation-administration',
    true,
    1
  ),
  (
    '87c96495-c806-4692-9bc2-250ddb10613c',
    'platform.organization.roles.manage',
    'manage',
    'Manage roles',
    'Create, change or retire roles only within the actor''s explicit delegated scope.',
    'sha256:91eb8281f4905ef55dbe5acf537d49febeede8df37aeaf2ff69292107a59ae2b',
    'organisation-administration',
    true,
    1
  ),
  (
    '290ae49f-4cab-4159-9c20-6e664f07d50b',
    'platform.organization.groups.read',
    'read',
    'View groups',
    'View the selected organisation''s Groups and membership administration data.',
    'sha256:cfb428fda5934cc18c54bc71bcbb4b6e7038714550587b189df0a3c0a3e44f8a',
    'organisation-administration',
    true,
    1
  ),
  (
    '6185dc64-464b-4776-97dc-c64a6f299550',
    'platform.organization.groups.manage',
    'manage',
    'Manage groups',
    'Manage Groups and memberships subject to delegated scope and permanent-steward safeguards.',
    'sha256:a44b20bb994a4519ca283fbd7cc933b7dbba7f7c6c4c0e036492cb84f432b22e',
    'organisation-administration',
    true,
    1
  ),
  (
    '9901c0dc-8bac-45c7-be0b-3642cb839bb1',
    'platform.organization.assignments.read',
    'read',
    'View access assignments',
    'View the selected organisation''s role and delegation assignments and their effective scope.',
    'sha256:e46f5f2b4e9dcf77e6f96918828c7421044605b35216c5eecc0e29909c9a6848',
    'organisation-administration',
    true,
    1
  ),
  (
    '156d01f3-8f80-45fb-8fc8-b31c47dbb1df',
    'platform.organization.assignments.manage',
    'manage',
    'Manage access assignments',
    'Grant, change or revoke use and delegation assignments only within the actor''s explicit delegated scope.',
    'sha256:9c2cf2b688335a1c3edf32d397c7a9e611743736680e30c3672dfaf11c7a9f36',
    'organisation-administration',
    true,
    1
  ),
  (
    '02c772e5-2921-4300-ad90-4f5772a7fa46',
    'platform.organization.accounts.read',
    'read',
    'View organisation accounts',
    'View the selected organisation''s safe account-administration information.',
    'sha256:51234f517c9a62379cecc8ef047c3b5266096381dbc58e77d8a889fc3be32641',
    'organisation-administration',
    true,
    1
  ),
  (
    '630a980c-0ff5-40b1-a329-7326a2122395',
    'platform.organization.accounts.manage',
    'manage',
    'Manage organisation accounts',
    'Change organisation-account lifecycle through the protected operation without changing global identity or removing the final permanent steward.',
    'sha256:59439415b18b92167020f82086693b45cd238c9c4b8ac6fdd3ce071bc6d5b9e0',
    'organisation-administration',
    true,
    1
  ),
  (
    '9300e501-6d56-41b1-b203-3361dbace9bc',
    'platform.organization.invitations.read',
    'read',
    'View invitations',
    'View safe invitation administration metadata without the raw invitation secret or its stored fingerprint.',
    'sha256:b4462ee4471b7c93d820caef5690a31f7e7be4070e3ba8b7e83fe2e68b024cd8',
    'organisation-administration',
    true,
    1
  ),
  (
    'c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb',
    'platform.organization.invitations.manage',
    'manage',
    'Manage invitations',
    'Create or revoke invitations through the protected operation; role assignment additionally requires the actor''s assignment authority.',
    'sha256:65b1804f9f5148adfb06d50ac16243b9711cab368b8c9950ff935e2e89a69154',
    'organisation-administration',
    true,
    1
  ),
  (
    '6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5',
    'platform.organization.runtime_settings.read',
    'read',
    'View organisation display settings',
    'View the organisation''s default language, time zone, currency, date and number display settings.',
    'sha256:cba574ab17eff487cc68f32e8ce013eea83570060f17f73b02e91764f665120a',
    'organisation-administration',
    true,
    1
  ),
  (
    'c658c254-2884-414a-9012-512c0cfe4b34',
    'platform.organization.runtime_settings.manage',
    'manage',
    'Manage organisation display settings',
    'Change the organisation''s validated default display settings through the protected revision-checked operation.',
    'sha256:e79914b57f2c0b37bb07698bee58dc8557762020d3f082e19a4ceb8304b8e4f7',
    'organisation-administration',
    true,
    1
  ),
  (
    '7ecd3304-f16c-47d4-94db-0964980091ba',
    'platform.organization.applications.manage',
    'manage',
    'Manage applications',
    'Install, upgrade or detach exact application bindings in the selected organisation without receiving business-record use or role-assignment authority.',
    'sha256:f3c8f4195e1d61f27a1cc65b82f6aa46ac45629195f3a8ea125925c7f12f3f81',
    'organisation-administration',
    false,
    3
  ),
  (
    'ec2908a1-f3cd-4c4a-8bf7-91bffbf4cb3d',
    'platform.organization.connections.manage',
    'manage',
    'Manage connections',
    'Register, grant, check, revoke and reauthorise connection instances in the selected organisation without application-installation or access-assignment authority.',
    'sha256:809b4b3ad29ff61ab5ea73c06504909540b8111a2b3c2e1310559a7e9dc2e31e',
    'system-core',
    false,
    4
  ),
  (
    'e85c2232-2ed7-4ce8-b1e5-7e2ad8e2b847',
    'platform.security.identities.disable',
    'manage',
    'Disable identities',
    'Disable an identity and revoke its active sessions through the identity owner''s protected operation without receiving general identity-administration or business-record authority.',
    'sha256:d3b44fd282d1155370c5325aecc38590891afebf6172a29d1b3afcc8501ce745',
    'system-core',
    false,
    5
  ),
  (
    '014d2898-1969-4434-805c-eeb0f0e6f797',
    'platform.support.access.request',
    'manage',
    'Request support access',
    'Request time-bounded support access to another organisation for a named operator and exact scope without receiving standing access to that organisation.',
    'sha256:1cd6a404fef31df331259055de726ca6f176b58994e79946ceb069bac113ce4c',
    'system-core',
    false,
    5
  ),
  (
    '07e4653c-d358-489f-8067-46e085d99478',
    'platform.organization.support.approve',
    'manage',
    'Approve support access',
    'Approve or refuse a time-bounded support-access request for one''s own organisation without granting the requester standing authority.',
    'sha256:84b1f9b314ca426256aceec5c156dcc3e771a9d5612505ab77dbcfd89df9c659',
    'system-core',
    false,
    5
  ),
  (
    '0548c061-b1a9-48e5-a04a-eb1d0dae0644',
    'platform.organization.definition_drafts.manage',
    'manage',
    'Manage definition drafts',
    'Create and change module and application drafts, including flows, placements and role templates, without publication or installation authority.',
    'sha256:29c4f706d6b65b54f4c3378de3f64816c01a22dc308ee7f6f0898d71eda216a0',
    'system-core',
    false,
    6
  ),
  (
    'dfdd5aba-2b85-4169-b570-92be284e7b5c',
    'platform.organization.definition_releases.manage',
    'manage',
    'Manage definition releases',
    'Publish module and application drafts as immutable releases without receiving installation or business-record authority.',
    'sha256:b291e3a7d8a7f5cc0f346762914d1b1122be875d21fa70e5fdad819d28b1a80a',
    'system-core',
    false,
    6
  ),
  (
    'd1be247f-094d-47c1-a38d-762290868c91',
    'platform.organization.custom_code.manage',
    'manage',
    'Manage custom code',
    'Required in addition to the application-management permission to install, upgrade or uninstall packages that bundle custom components or scripts.',
    'sha256:d8faa202f04c0c453cb87ed37f3b8f226b4171d133fc1277616a2b418db43c21',
    'system-core',
    false,
    6
  ),
  (
    'eaade6fd-7390-44d2-a7ef-343324c7384a',
    'platform.organization.system_applications.manage',
    'manage',
    'Manage system applications',
    'Change system application definitions, including extension fields, theme, navigation and dependent applications, without uninstallation authority.',
    'sha256:0c68ccc8a752c8009a5b84e5a22a584f3f22f666213121db1be7fb010cdbc50b',
    'system-core',
    false,
    6
  );

create or replace function vortex_access.protect_platform_permission_declarations()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    if old.steward_minimum then
      raise exception using errcode = '23514',
        message = 'Guarded platform permission declarations cannot be deleted';
    end if;
    return old;
  end if;

  if row(new.permission_id, new.permission_key)
    is distinct from row(old.permission_id, old.permission_key) then
    raise exception using errcode = '23514',
      message = 'Platform permission declaration identity is immutable';
  end if;

  if new.first_revision is distinct from old.first_revision then
    raise exception using errcode = '23514',
      message = 'Platform permission declaration first revision is immutable';
  end if;

  if old.steward_minimum then
    if not new.steward_minimum then
      raise exception using errcode = '23514',
        message = 'Guarded platform permission minimum cannot be cleared';
    end if;
    if row(
      new.owner_kind,
      new.owner_id,
      new.action_kind,
      new.label,
      new.description,
      new.meaning_fingerprint,
      new.source_module_key,
      new.steward_minimum,
      new.first_revision
    ) is distinct from row(
      old.owner_kind,
      old.owner_id,
      old.action_kind,
      old.label,
      old.description,
      old.meaning_fingerprint,
      old.source_module_key,
      old.steward_minimum,
      old.first_revision
    ) then
      raise exception using errcode = '23514',
        message = 'Guarded platform permission declarations are immutable';
    end if;
  end if;

  return new;
end
$function$;

revoke all on function
  vortex_access.protect_platform_permission_declarations()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.protect_platform_permission_declarations() is
  'Rejects removal or silent substitution of a guarded platform permission declaration.';

alter function vortex_access.protect_platform_permission_declarations()
  owner to vortex_access_owner;

create trigger platform_permission_declarations_protect_guarded
before update or delete on vortex_access.platform_permission_declarations
for each row execute function vortex_access.protect_platform_permission_declarations();

revoke all on table vortex_access.platform_permission_declarations
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

reset role;

commit;
