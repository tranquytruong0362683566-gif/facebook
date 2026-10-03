-- Existing 4.2.0 project: run this whole file in Supabase SQL Editor.
-- Preserve every KEY, approval, customer, note, expiry and ADMIN account.
begin;

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

revoke all on function public.tqt_register_device(text, text) from public, anon, authenticated;
grant execute on function public.tqt_register_device(text, text) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
