-- Immutable published Definition revisions and their exact dependency manifests.
-- A root's nullable current_release_revision is only a discovery/default pointer;
-- consumers always retain their own exact release reference.

alter table vortex_definition.roots
  add column current_release_revision bigint,
  add constraint roots_current_release_revision_range check (
    current_release_revision is null
    or current_release_revision between 1 and 9007199254740991
  );

create table vortex_definition.releases (
  root_id uuid not null,
  release_revision bigint not null,
  release_version text not null,
  authored_source jsonb not null,
  authored_source_fingerprint text not null,
  source_contract_version text not null,
  compilation_output jsonb not null,
  resolution_snapshot jsonb not null,
  content_fingerprint text not null,
  resolution_fingerprint text not null,
  validation_contract_version text not null,
  comparison_fingerprint text not null,
  impact_reasons jsonb not null,
  release_note text not null,
  published_at timestamptz not null default pg_catalog.statement_timestamp(),
  published_by uuid not null,
  constraint releases_pk primary key (root_id, release_revision),
  constraint releases_root_version_unique unique (root_id, release_version),
  constraint releases_root_revision_version_fingerprint_unique unique (
    root_id,
    release_revision,
    release_version,
    content_fingerprint
  ),
  constraint releases_revision_range check (
    release_revision between 1 and 9007199254740991
  ),
  constraint releases_release_version_format check (
    release_version ~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  constraint releases_authored_source_object check (
    pg_catalog.jsonb_typeof(authored_source) = 'object'
  ),
  constraint releases_authored_source_fingerprint_format check (
    authored_source_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint releases_source_contract_version_format check (
    pg_catalog.char_length(source_contract_version) between 1 and 120
    and source_contract_version ~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
  ),
  constraint releases_compilation_output_object check (
    pg_catalog.jsonb_typeof(compilation_output) = 'object'
  ),
  constraint releases_resolution_snapshot_object check (
    pg_catalog.jsonb_typeof(resolution_snapshot) = 'object'
  ),
  constraint releases_resolution_snapshot_fingerprint_match check (
    resolution_snapshot ->> 'fingerprint' = resolution_fingerprint
  ),
  constraint releases_content_fingerprint_format check (
    content_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint releases_resolution_fingerprint_format check (
    resolution_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint releases_validation_contract_version_format check (
    validation_contract_version ~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
  ),
  constraint releases_comparison_fingerprint_format check (
    comparison_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint releases_impact_reasons_array check (
    pg_catalog.jsonb_typeof(impact_reasons) = 'array'
  ),
  constraint releases_release_note_length check (
    release_note = pg_catalog.btrim(release_note)
    and pg_catalog.char_length(release_note) between 1 and 2000
  ),
  constraint releases_published_at_finite check (
    published_at <> '-infinity'::timestamptz
    and published_at <> 'infinity'::timestamptz
  ),
  constraint releases_published_by_non_nil check (
    published_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint releases_root_fk foreign key (root_id)
    references vortex_definition.roots (root_id)
);

alter table vortex_definition.roots
  add constraint roots_current_release_fk foreign key (
    root_id,
    current_release_revision
  ) references vortex_definition.releases (
    root_id,
    release_revision
  );

create table vortex_definition.release_dependencies (
  root_id uuid not null,
  release_revision bigint not null,
  dependency_kind text not null,
  dependency_reference text not null,
  dependency_version text not null,
  dependency_content_fingerprint text not null,
  evidence_fingerprint text not null,
  target_root_id uuid,
  target_release_revision bigint,
  catalogue_item_id uuid,
  constraint release_dependencies_pk primary key (
    root_id,
    release_revision,
    dependency_kind,
    dependency_reference
  ),
  constraint release_dependencies_kind_valid check (
    dependency_kind in ('module', 'connection_type', 'platform_theme')
  ),
  constraint release_dependencies_reference_shape check (
    (
      dependency_kind in ('module', 'connection_type')
      and pg_catalog.char_length(dependency_reference) between 3 and 120
      and dependency_reference ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
      and dependency_reference !~ '(^|\.)[^.]{41,}(\.|$)'
    )
    or (
      dependency_kind = 'platform_theme'
      and dependency_reference ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and dependency_reference <> '00000000-0000-0000-0000-000000000000'
    )
  ),
  constraint release_dependencies_version_format check (
    dependency_version ~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  constraint release_dependencies_content_fingerprint_format check (
    dependency_content_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint release_dependencies_evidence_fingerprint_format check (
    evidence_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint release_dependencies_target_shape check (
    (
      dependency_kind = 'module'
      and target_root_id is not null
      and target_release_revision between 1 and 9007199254740991
      and catalogue_item_id is null
    )
    or (
      dependency_kind = 'connection_type'
      and target_root_id is null
      and target_release_revision is null
      and catalogue_item_id is not null
      and catalogue_item_id <> '00000000-0000-0000-0000-000000000000'::uuid
    )
    or (
      dependency_kind = 'platform_theme'
      and target_root_id is null
      and target_release_revision is null
      and catalogue_item_id is null
    )
  ),
  constraint release_dependencies_release_fk foreign key (
    root_id,
    release_revision
  ) references vortex_definition.releases (
    root_id,
    release_revision
  ),
  constraint release_dependencies_target_release_fk foreign key (
    target_root_id,
    target_release_revision,
    dependency_version,
    dependency_content_fingerprint
  ) references vortex_definition.releases (
    root_id,
    release_revision,
    release_version,
    content_fingerprint
  )
);

create index release_dependencies_target_release_idx
  on vortex_definition.release_dependencies (target_root_id, target_release_revision)
  where target_root_id is not null;

alter table vortex_definition.releases enable row level security;
alter table vortex_definition.releases force row level security;
alter table vortex_definition.release_dependencies enable row level security;
alter table vortex_definition.release_dependencies force row level security;

create function vortex_definition.refuse_release_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '23514',
    message = 'Definition releases and dependency manifests are append-only';
end
$function$;

create function vortex_definition.validate_release_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  root_kind text;
  root_key text;
  root_created_at timestamptz;
begin
  select root.kind, root.key, root.created_at
  into root_kind, root_key, root_created_at
  from vortex_definition.roots as root
  where root.root_id = new.root_id;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'A definition release requires an existing root';
  end if;

  if new.authored_source ->> 'kind' is distinct from root_kind
    or new.authored_source ->> 'key' is distinct from root_key
    or new.authored_source ->> 'source_contract_version'
      is distinct from new.source_contract_version then
    raise exception using
      errcode = '23514',
      message = 'Definition release source metadata must match its permanent root and source contract';
  end if;

  if new.published_at < root_created_at then
    raise exception using
      errcode = '23514',
      message = 'Definition release publication time cannot precede root creation';
  end if;

  return new;
end
$function$;

create trigger releases_append_only
before update or delete on vortex_definition.releases
for each row execute function vortex_definition.refuse_release_mutation();

create trigger release_dependencies_append_only
before update or delete on vortex_definition.release_dependencies
for each row execute function vortex_definition.refuse_release_mutation();

create trigger releases_validate_insert
before insert on vortex_definition.releases
for each row execute function vortex_definition.validate_release_insert();

revoke all on table vortex_definition.releases
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on table vortex_definition.release_dependencies
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_definition.refuse_release_mutation()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_definition.validate_release_insert()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on table vortex_definition.releases is
  'Immutable published Module and Application revisions with their complete compilation and resolution evidence.';
comment on table vortex_definition.release_dependencies is
  'Exact immutable dependency manifest for one Definition release; module dependencies bind to one target release.';
comment on column vortex_definition.roots.current_release_revision is
  'Nullable discovery/default release pointer only; it never retargets an existing consumer.';
