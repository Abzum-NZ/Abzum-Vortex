\set ON_ERROR_STOP on

-- This is a credential-free, data-free description of the operated database
-- shape and its security boundary.  Each row is canonical JSON text and the
-- delivery runner hashes the complete ordered stream.  Object contents and
-- application data are deliberately outside this bounded proof.
with operated_namespaces as (
  select n.oid, n.nspname
  from pg_catalog.pg_namespace n
  where n.nspname = 'public'
     or n.nspname = 'record_data'
     or n.nspname like 'vortex\_%' escape '\'
), facts as (
  select '01-schema' as category, n.nspname as identity,
    pg_catalog.jsonb_build_object(
      'name', n.nspname,
      'owner', pg_catalog.pg_get_userbyid(n.nspowner),
      'acl', coalesce(n.nspacl::text, '')
    ) as fact
  from operated_namespaces o
  join pg_catalog.pg_namespace n on n.oid = o.oid

  union all
  select '02-relation', o.nspname || '.' || c.relname,
    pg_catalog.jsonb_build_object(
      'schema', o.nspname, 'name', c.relname, 'kind', c.relkind,
      'persistence', c.relpersistence,
      'owner', pg_catalog.pg_get_userbyid(c.relowner),
      'row_security', c.relrowsecurity,
      'force_row_security', c.relforcerowsecurity,
      'options', coalesce(c.reloptions::text, ''),
      'view_definition', case when c.relkind in ('v', 'm')
        then pg_catalog.pg_get_viewdef(c.oid, true) else '' end,
      'acl', coalesce(c.relacl::text, '')
    )
  from operated_namespaces o
  join pg_catalog.pg_class c on c.relnamespace = o.oid
  where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')

  union all
  select '03-column', o.nspname || '.' || c.relname || '.' || a.attnum,
    pg_catalog.jsonb_build_object(
      'schema', o.nspname, 'relation', c.relname, 'number', a.attnum,
      'name', a.attname,
      'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
      'not_null', a.attnotnull, 'identity', a.attidentity,
      'generated', a.attgenerated,
      'default', coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''),
      'acl', coalesce(a.attacl::text, '')
    )
  from operated_namespaces o
  join pg_catalog.pg_class c on c.relnamespace = o.oid
  join pg_catalog.pg_attribute a on a.attrelid = c.oid
  left join pg_catalog.pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
  where c.relkind in ('r', 'p', 'v', 'm', 'f')
    and a.attnum > 0 and not a.attisdropped

  union all
  select '04-constraint', o.nspname || '.' || c.relname || '.' || con.conname,
    pg_catalog.jsonb_build_object(
      'schema', o.nspname, 'relation', c.relname, 'name', con.conname,
      'type', con.contype, 'deferrable', con.condeferrable,
      'initially_deferred', con.condeferred,
      'validated', con.convalidated,
      'definition', pg_catalog.pg_get_constraintdef(con.oid, true)
    )
  from operated_namespaces o
  join pg_catalog.pg_class c on c.relnamespace = o.oid
  join pg_catalog.pg_constraint con on con.conrelid = c.oid

  union all
  select '05-index', o.nspname || '.' || c.relname,
    pg_catalog.jsonb_build_object(
      'schema', o.nspname, 'name', c.relname,
      'definition', pg_catalog.pg_get_indexdef(c.oid)
    )
  from operated_namespaces o
  join pg_catalog.pg_class c on c.relnamespace = o.oid
  where c.relkind = 'i'

  union all
  select '06-policy', o.nspname || '.' || c.relname || '.' || p.polname,
    pg_catalog.jsonb_build_object(
      'schema', o.nspname, 'relation', c.relname, 'name', p.polname,
      'permissive', p.polpermissive, 'command', p.polcmd,
      'roles', coalesce((
        select pg_catalog.jsonb_agg(coalesce(r.rolname, 'public') order by role_oid)
        from pg_catalog.unnest(p.polroles) role_oid
        left join pg_catalog.pg_roles r on r.oid = role_oid
      ), '[]'::jsonb),
      'using', coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), ''),
      'check', coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
    )
  from operated_namespaces o
  join pg_catalog.pg_class c on c.relnamespace = o.oid
  join pg_catalog.pg_policy p on p.polrelid = c.oid

  union all
  select '07-function', o.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
    pg_catalog.jsonb_build_object(
      'schema', o.nspname, 'name', p.proname,
      'arguments', pg_catalog.pg_get_function_identity_arguments(p.oid),
      'result', pg_catalog.pg_get_function_result(p.oid),
      'language', l.lanname, 'owner', pg_catalog.pg_get_userbyid(p.proowner),
      'security_definer', p.prosecdef, 'leakproof', p.proleakproof,
      'strict', p.proisstrict, 'volatility', p.provolatile,
      'parallel', p.proparallel,
      'configuration', coalesce(p.proconfig::text, ''),
      'acl', coalesce(p.proacl::text, ''),
      'definition', pg_catalog.pg_get_functiondef(p.oid)
    )
  from operated_namespaces o
  join pg_catalog.pg_proc p on p.pronamespace = o.oid
  join pg_catalog.pg_language l on l.oid = p.prolang

  union all
  select '08-trigger', o.nspname || '.' || c.relname || '.' || t.tgname,
    pg_catalog.jsonb_build_object(
      'schema', o.nspname, 'relation', c.relname, 'name', t.tgname,
      'enabled', t.tgenabled,
      'definition', pg_catalog.pg_get_triggerdef(t.oid, true)
    )
  from operated_namespaces o
  join pg_catalog.pg_class c on c.relnamespace = o.oid
  join pg_catalog.pg_trigger t on t.tgrelid = c.oid
  where not t.tgisinternal

  union all
  select '09-default-acl', o.nspname || '.' || d.defaclobjtype::text || '.' || d.defaclrole::text,
    pg_catalog.jsonb_build_object(
      'schema', o.nspname, 'object_type', d.defaclobjtype,
      'owner', pg_catalog.pg_get_userbyid(d.defaclrole),
      'acl', coalesce(d.defaclacl::text, '')
    )
  from operated_namespaces o
  join pg_catalog.pg_default_acl d on d.defaclnamespace = o.oid

  union all
  select '10-role', r.rolname,
    pg_catalog.jsonb_build_object(
      'name', r.rolname, 'superuser', r.rolsuper,
      'inherit', r.rolinherit, 'create_role', r.rolcreaterole,
      'create_db', r.rolcreatedb, 'can_login', r.rolcanlogin,
      'replication', r.rolreplication, 'bypass_rls', r.rolbypassrls,
      'connection_limit', r.rolconnlimit,
      'configuration', coalesce(r.rolconfig::text, '')
    )
  from pg_catalog.pg_roles r
  where r.rolname like 'vortex\_%' escape '\'

  union all
  select '11-role-membership', granted.rolname || '.' || member.rolname,
    pg_catalog.jsonb_build_object(
      'role', granted.rolname, 'member', member.rolname,
      'grantor', grantor.rolname, 'admin', membership.admin_option,
      'inherit', membership.inherit_option, 'set', membership.set_option
    )
  from pg_catalog.pg_auth_members membership
  join pg_catalog.pg_roles granted on granted.oid = membership.roleid
  join pg_catalog.pg_roles member on member.oid = membership.member
  join pg_catalog.pg_roles grantor on grantor.oid = membership.grantor
  where granted.rolname like 'vortex\_%' escape '\'
     or member.rolname like 'vortex\_%' escape '\'

  union all
  select '12-role-setting', coalesce(db.datname, '*') || '.' || r.rolname,
    pg_catalog.jsonb_build_object(
      'database', coalesce(db.datname, '*'), 'role', r.rolname,
      'settings', setting.setconfig::text
    )
  from pg_catalog.pg_db_role_setting setting
  join pg_catalog.pg_roles r on r.oid = setting.setrole
  left join pg_catalog.pg_database db on db.oid = setting.setdatabase
  where r.rolname like 'vortex\_%' escape '\'

  union all
  select '13-extension', e.extname,
    pg_catalog.jsonb_build_object(
      'name', e.extname, 'version', e.extversion,
      'schema', n.nspname, 'relocatable', e.extrelocatable
    )
  from pg_catalog.pg_extension e
  join pg_catalog.pg_namespace n on n.oid = e.extnamespace
)
select pg_catalog.jsonb_build_object(
  'category', category,
  'identity', identity,
  'fact', fact
)::text
from facts
order by category, identity, fact::text;
