-- The account-deletion path is gone (DF-11), so nothing reads record tables as
-- vortex_record_inventory any more. Every Record table keeps its owner-account fence trigger; its
-- provisioner is renamed for what it does and no longer grants the inventory role a read policy.
-- The inventory policies and privileges on existing tables go, and so does the role.

set role vortex_owner;

create or replace function vortex_record.ensure_record_owner_account_fence_internal(
  p_physical_table_token text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_physical_table_token is null
    or p_physical_table_token !~ '^rt_[a-f0-9]{32}$'
    or pg_catalog.to_regclass(
      pg_catalog.format('record_data.%I', p_physical_table_token)
    ) is null then
    raise exception using errcode = '55000',
      message = 'Record owner-account fence storage is unavailable';
  end if;

  execute pg_catalog.format(
    'drop trigger if exists record_owner_account_fence on record_data.%I',
    p_physical_table_token
  );
  execute pg_catalog.format(
    'create trigger record_owner_account_fence
       before insert or update of owner_organisation_account_id, organisation_id
       on record_data.%I
       for each row execute function vortex_access.fence_record_owner_account_target_internal()',
    p_physical_table_token
  );
end
$function$;

alter function vortex_record.ensure_record_owner_account_fence_internal(text) owner to vortex_owner;

revoke all on function vortex_record.ensure_record_owner_account_fence_internal(text) from public;

comment on function vortex_record.ensure_record_owner_account_fence_internal(text) is
  'Private provisioner for one Record table: the row trigger that keeps an assigned account owner active in the row organisation.';

create or replace function vortex_record.provision_record_owner_account_fence_internal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.physical_schema_token = 'record_data' then
    perform vortex_record.ensure_record_owner_account_fence_internal(new.physical_table_token);
  end if;
  return new;
end
$function$;

alter function vortex_record.provision_record_owner_account_fence_internal() owner to vortex_owner;

revoke all on function vortex_record.provision_record_owner_account_fence_internal() from public;

comment on function vortex_record.provision_record_owner_account_fence_internal() is
  'Storage catalogue trigger: gives every new Record table its owner-account fence.';

drop trigger storage_catalogue_account_deletion_fence on vortex_record.storage_catalogue;
create trigger storage_catalogue_record_owner_account_fence
  after insert on vortex_record.storage_catalogue
  for each row execute function vortex_record.provision_record_owner_account_fence_internal();

drop function vortex_record.provision_account_deletion_fence_internal();
drop function vortex_record.ensure_account_deletion_fence_internal(text);

reset role;

-- Every policy that names the inventory role: drop it when it is the only role, otherwise keep the
-- other roles. Each change runs as the table owner.
do $inventory_policies$
declare
  entry record;
  remaining text;
begin
  for entry in
    select policy.polname, policy.polrelid::pg_catalog.regclass::text as relation,
      owner.rolname as owner,
      array(
        select pg_catalog.quote_ident(role.rolname)
        from pg_catalog.unnest(policy.polroles) as member(oid)
        join pg_catalog.pg_roles as role on role.oid = member.oid
        where role.rolname <> 'vortex_record_inventory'
        order by role.rolname
      ) as other_roles
    from pg_catalog.pg_policy as policy
    join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
    join pg_catalog.pg_roles as owner on owner.oid = relation.relowner
    where (select oid from pg_catalog.pg_roles where rolname = 'vortex_record_inventory')
      = any (policy.polroles)
  loop
    execute pg_catalog.format('set local role %I', entry.owner);
    if pg_catalog.cardinality(entry.other_roles) = 0 then
      execute pg_catalog.format('drop policy %I on %s', entry.polname, entry.relation);
    else
      remaining := pg_catalog.array_to_string(entry.other_roles, ', ');
      execute pg_catalog.format('alter policy %I on %s to %s', entry.polname, entry.relation, remaining);
    end if;
    reset role;
  end loop;
end
$inventory_policies$;

-- DROP OWNED cannot revoke what another role granted, so each grantor revokes the inventory role's
-- privileges on schemas, tables, columns and functions.
do $inventory_privileges$
declare
  entry record;
begin
  for entry in
    select 'schema' as kind, pg_catalog.quote_ident(n.nspname) as object, null::text as column_name,
      privilege.privilege_type, grantor.rolname as grantor
    from pg_catalog.pg_namespace as n
    cross join lateral pg_catalog.aclexplode(n.nspacl) as privilege
    join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
    join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
    where grantee.rolname = 'vortex_record_inventory'
    union all
    select case when c.relkind = 'S' then 'sequence' else 'table' end,
      pg_catalog.format('%I.%I', n.nspname, c.relname), null, privilege.privilege_type,
      grantor.rolname
    from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    cross join lateral pg_catalog.aclexplode(c.relacl) as privilege
    join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
    join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
    where c.relkind in ('r', 'p', 'v', 'm', 'S') and grantee.rolname = 'vortex_record_inventory'
    union all
    select 'column', pg_catalog.format('%I.%I', n.nspname, c.relname), a.attname::text,
      privilege.privilege_type, grantor.rolname
    from pg_catalog.pg_attribute as a
    join pg_catalog.pg_class as c on c.oid = a.attrelid
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    cross join lateral pg_catalog.aclexplode(a.attacl) as privilege
    join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
    join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
    where grantee.rolname = 'vortex_record_inventory'
    union all
    select 'function', p.oid::pg_catalog.regprocedure::text, null, privilege.privilege_type,
      grantor.rolname
    from pg_catalog.pg_proc as p
    cross join lateral pg_catalog.aclexplode(p.proacl) as privilege
    join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
    join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
    where grantee.rolname = 'vortex_record_inventory'
  loop
    execute pg_catalog.format('set local role %I', entry.grantor);
    execute case entry.kind
      when 'column' then pg_catalog.format(
        'revoke %s (%I) on table %s from vortex_record_inventory',
        entry.privilege_type, entry.column_name, entry.object
      )
      else pg_catalog.format(
        'revoke %s on %s %s from vortex_record_inventory',
        entry.privilege_type, entry.kind, entry.object
      )
    end;
    reset role;
  end loop;
end
$inventory_privileges$;

set role vortex_record_inventory;
drop owned by vortex_record_inventory;
reset role;
drop role vortex_record_inventory;
reset role;
