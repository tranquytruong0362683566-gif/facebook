-- Run once in the Supabase SQL Editor, as the project owner.
-- No secret API key or ADMIN password belongs in this file.
begin;

create schema if not exists tqt_private;
revoke all on schema tqt_private from public, anon, authenticated;

create table if not exists tqt_private.license_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.tqt_device_licenses (
  machine_key text primary key check (machine_key ~ '^TQT-[A-F0-9]{27}$'),
  credential_hash text check (credential_hash ~ '^[a-f0-9]{64}$'),
  customer_name text not null default '' check (char_length(customer_name) <= 120),
  note text not null default '' check (char_length(note) <= 1000),
  status text not null default 'pending' check (status in ('pending','approved','blocked')),
  expires_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision bigint not null default 0 check (revision >= 0)
);

create table if not exists tqt_private.license_audit (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  machine_key text not null,
  operation text not null,
  previous_values jsonb,
  next_values jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tqt_licenses_last_seen on public.tqt_device_licenses(last_seen_at desc, machine_key);
create index if not exists tqt_licenses_status on public.tqt_device_licenses(status);
alter table public.tqt_device_licenses enable row level security;
alter table tqt_private.license_admins enable row level security;
alter table tqt_private.license_audit enable row level security;
-- All app access goes through the narrow RPC functions below. No direct table access.
revoke all on public.tqt_device_licenses from public, anon, authenticated;
revoke all on tqt_private.license_admins, tqt_private.license_audit from public, anon, authenticated;

create or replace function public.tqt_is_license_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and exists(select 1 from tqt_private.license_admins a where a.user_id = auth.uid());
$$;

-- Keep the legacy second argument so extension/web 4.2.0 still works.
-- Approval belongs to the KEY; the installation token is intentionally ignored.
create or replace function public.tqt_register_device(p_machine_key text, p_device_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := upper(trim(p_machine_key));
  v_device public.tqt_device_licenses%rowtype;
  v_status text;
begin
  if v_key is null or v_key !~ '^TQT-[A-F0-9]{27}$' then
    raise exception using errcode = '22023', message = 'KEY thiết bị không hợp lệ.';
  end if;
  insert into public.tqt_device_licenses(machine_key)
    values (v_key) on conflict (machine_key) do nothing;
  select * into v_device from public.tqt_device_licenses where machine_key = v_key for update;
  if v_device.last_seen_at < now() - interval '30 seconds' then
    update public.tqt_device_licenses set last_seen_at = now() where machine_key = v_key;
  end if;
  v_status := case when v_device.status = 'approved' and v_device.expires_at is not null
    and v_device.expires_at <= now() then 'expired' else v_device.status end;
  return jsonb_build_object('authorized', v_status = 'approved', 'machineKey', v_key, 'status', v_status,
    'expiresAt', v_device.expires_at, 'message', case v_status
      when 'approved' then 'KEY đã được ADMIN cấp quyền.'
      when 'pending' then 'KEY đã gửi tới ADMIN và đang chờ duyệt. Trang sẽ tự kiểm tra lại.'
      when 'blocked' then 'KEY đã bị ADMIN khóa.'
      else 'KEY đã hết hạn sử dụng. Liên hệ ADMIN để gia hạn.' end);
end;
$$;

create or replace function public.tqt_admin_list_licenses(
  p_search text default '', p_status text default 'all', p_offset integer default 0, p_limit integer default 50
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if not public.tqt_is_license_admin() then
    raise exception using errcode = '42501', message = 'Chỉ ADMIN được xem danh sách KEY.';
  end if;
  if p_limit not between 1 and 100 or p_offset not between 0 and 1000000
    or char_length(coalesce(p_search,'')) > 120
    or p_status not in ('all','pending','approved','blocked','expired')
    or p_limit is null or p_offset is null or p_status is null then
    raise exception using errcode = '22023', message = 'Bộ lọc hoặc trang không hợp lệ.';
  end if;
  with matches as (
    select machine_key, customer_name, note, status, expires_at, first_seen_at, last_seen_at, updated_at, revision,
      case when status = 'approved' and expires_at <= now() then 'expired' else status end as effective_status
    from public.tqt_device_licenses
    where (coalesce(p_search,'') = '' or strpos(lower(machine_key),lower(p_search)) > 0
      or strpos(lower(customer_name),lower(p_search)) > 0)
  ), filtered as (
    select * from matches where p_status = 'all' or effective_status = p_status
  ), page_rows as (
    select * from filtered order by last_seen_at desc, machine_key limit p_limit offset p_offset
  )
  select jsonb_build_object('total', (select count(*) from filtered), 'rows',
    coalesce((select jsonb_agg(to_jsonb(r) order by r.last_seen_at desc, r.machine_key) from page_rows r), '[]'::jsonb))
    into v_result;
  return v_result;
end;
$$;

create or replace function public.tqt_admin_update_license(
  p_machine_key text, p_status text, p_customer_name text, p_note text,
  p_expires_at timestamptz, p_expected_revision bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old public.tqt_device_licenses%rowtype; v_new public.tqt_device_licenses%rowtype;
begin
  if not public.tqt_is_license_admin() then
    raise exception using errcode = '42501', message = 'Chỉ ADMIN được thay đổi quyền KEY.';
  end if;
  if p_status is null or p_status not in ('pending','approved','blocked')
    or p_expected_revision is null or p_expected_revision < 0
    or p_customer_name is null or char_length(p_customer_name) > 120
    or p_note is null or char_length(p_note) > 1000
    or (p_expires_at is not null and not isfinite(p_expires_at)) then
    raise exception using errcode = '22023', message = 'Thông tin cấp quyền không hợp lệ.';
  end if;
  select * into v_old from public.tqt_device_licenses where machine_key = p_machine_key for update;
  if not found then raise exception using errcode = '22023', message = 'KEY không tồn tại.'; end if;
  if v_old.revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'TQT_REVISION_CONFLICT';
  end if;
  update public.tqt_device_licenses set status = p_status, customer_name = trim(p_customer_name),
    note = p_note, expires_at = p_expires_at, updated_at = now(), revision = revision + 1
    where machine_key = p_machine_key returning * into v_new;
  insert into tqt_private.license_audit(actor_id, machine_key, operation, previous_values, next_values)
    values (auth.uid(), p_machine_key, 'update',
      to_jsonb(v_old) - 'credential_hash', to_jsonb(v_new) - 'credential_hash');
  return to_jsonb(v_new) - 'credential_hash';
end;
$$;

-- Legacy ADMIN API retained for compatibility; the new ADMIN page does not use it.
create or replace function public.tqt_admin_reset_registration(p_machine_key text, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old public.tqt_device_licenses%rowtype; v_new public.tqt_device_licenses%rowtype;
begin
  if not public.tqt_is_license_admin() then raise exception using errcode='42501', message='Chỉ ADMIN được đăng ký lại KEY.'; end if;
  select * into v_old from public.tqt_device_licenses where machine_key = p_machine_key for update;
  if not found then raise exception using errcode='22023', message='KEY không tồn tại.'; end if;
  if p_expected_revision is null or v_old.revision <> p_expected_revision then
    raise exception using errcode='P0001', message='TQT_REVISION_CONFLICT';
  end if;
  update public.tqt_device_licenses set credential_hash = null, status = 'pending', expires_at = null,
    updated_at = now(), revision = revision + 1 where machine_key = p_machine_key returning * into v_new;
  insert into tqt_private.license_audit(actor_id, machine_key, operation, previous_values, next_values)
    values (auth.uid(), p_machine_key, 'reset_registration',
      to_jsonb(v_old) - 'credential_hash', to_jsonb(v_new) - 'credential_hash');
  return to_jsonb(v_new) - 'credential_hash';
end;
$$;

revoke all on function public.tqt_is_license_admin() from public, anon, authenticated;
revoke all on function public.tqt_register_device(text,text) from public, anon, authenticated;
revoke all on function public.tqt_admin_list_licenses(text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.tqt_admin_update_license(text,text,text,text,timestamptz,bigint) from public, anon, authenticated;
revoke all on function public.tqt_admin_reset_registration(text,bigint) from public, anon, authenticated;
grant execute on function public.tqt_is_license_admin() to authenticated;
grant execute on function public.tqt_register_device(text,text) to anon, authenticated;
grant execute on function public.tqt_admin_list_licenses(text,text,integer,integer) to authenticated;
grant execute on function public.tqt_admin_update_license(text,text,text,text,timestamptz,bigint) to authenticated;
grant execute on function public.tqt_admin_reset_registration(text,bigint) to authenticated;
notify pgrst, 'reload schema';
commit;
