-- WooMap Database Schema
-- Run in Supabase SQL Editor

-- 1. Enable PostGIS
create extension if not exists postgis with schema extensions;

-- 2. Buildings table
create table if not exists public.buildings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id)
    on delete restrict,
  name text not null
    check (length(trim(name)) between 1 and 200),
  address text not null
    check (length(trim(address)) between 1 and 500),
  building_type text not null default 'Apartment'
    check (building_type in (
      'Apartment',
      'House',
      'Office',
      'Commercial building'
    )),
  height_m double precision not null default 10
    check (height_m > 0 and height_m <= 1000),
  footprint_geojson jsonb not null
    check (
      footprint_geojson->>'type' = 'Polygon'
      and jsonb_typeof(
        footprint_geojson->'coordinates'
      ) = 'array'
    ),
  footprint extensions.geometry(Polygon, 4326) not null,
  status text not null default 'draft'
    check (status in ('draft', 'published')),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Spatial and status indexes
create index if not exists buildings_footprint_gix
  on public.buildings using gist (footprint);
create index if not exists buildings_status_idx
  on public.buildings (status);

-- 3. Row Level Security (RLS)
alter table public.buildings enable row level security;
grant select on public.buildings to anon, authenticated;
grant insert, update, delete on public.buildings to authenticated;

create policy "Read published or owned buildings"
on public.buildings
for select
to anon, authenticated
using (
  status = 'published'
  or owner_id = (select auth.uid())
);

-- Note: Allows inserting both draft and published buildings for owned records
create policy "Create own buildings"
on public.buildings
for insert
to authenticated
with check (
  owner_id = (select auth.uid())
);

create policy "Update own buildings"
on public.buildings
for update
to authenticated
using (
  owner_id = (select auth.uid())
)
with check (
  owner_id = (select auth.uid())
);

create policy "Delete own buildings"
on public.buildings
for delete
to authenticated
using (
  owner_id = (select auth.uid())
);

-- 4. Geometry sync trigger function
create or replace function public.sync_building_geometry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.footprint :=
    extensions.st_setsrid(
      extensions.st_geomfromgeojson(
        new.footprint_geojson::text
      ),
      4326
    );
  if extensions.st_isempty(new.footprint)
     or not extensions.st_isvalid(new.footprint) then
    raise exception 'Invalid building footprint';
  end if;
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists buildings_geometry_trigger on public.buildings;
create trigger buildings_geometry_trigger
before insert or update on public.buildings
for each row
execute function public.sync_building_geometry();

-- 5. Revision audit table
create table if not exists public.building_revisions (
  id bigint generated always as identity primary key,
  building_id uuid not null,
  revision integer not null,
  action text not null,
  editor_id uuid,
  editor_email text,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists building_revisions_building_idx
  on public.building_revisions (building_id, revision desc);

alter table public.building_revisions enable row level security;
grant select on public.building_revisions to authenticated;

create policy "Read revisions of visible buildings"
on public.building_revisions
for select
to authenticated
using (
  exists (
    select 1
    from public.buildings b
    where b.id = building_id
      and (
        b.status = 'published'
        or b.owner_id = (select auth.uid())
      )
  )
);

-- 6. Audit trigger function
create or replace function public.audit_building_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  snapshot_data jsonb;
  next_revision integer;
  action_name text;
begin
  if tg_op = 'DELETE' then
    snapshot_data := to_jsonb(old);
    next_revision := old.revision + 1;
    action_name := 'deleted';
  else
    snapshot_data := to_jsonb(new);
    next_revision := new.revision;
    if tg_op = 'INSERT' then
      action_name := 'created';
    elsif old.status <> new.status
      and new.status = 'published' then
      action_name := 'published';
    else
      action_name := 'updated';
    end if;
  end if;

  insert into public.building_revisions (
    building_id,
    revision,
    action,
    editor_id,
    editor_email,
    snapshot
  )
  values (
    case when tg_op = 'DELETE' then old.id else new.id end,
    next_revision,
    action_name,
    (select auth.uid()),
    (select auth.jwt() ->> 'email'),
    snapshot_data
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists buildings_audit_trigger on public.buildings;
create trigger buildings_audit_trigger
after insert or update or delete on public.buildings
for each row
execute function public.audit_building_change();

-- 7. Supabase Realtime publication
do $$
begin
  if not exists (
    select 1 from pg_publication_tables 
    where pubname = 'supabase_realtime' and tablename = 'buildings'
  ) then
    alter publication supabase_realtime add table public.buildings;
  end if;
end;
$$;
