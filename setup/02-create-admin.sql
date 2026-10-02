-- FIRST: In Supabase Authentication -> Users, create your email/password user
-- and confirm its email. Then replace the email below and run this file.
do $$
declare v_user uuid;
begin
  select id into v_user from auth.users
    where lower(email) = lower('tranquytruong0362683566@gmail.com')
      and email_confirmed_at is not null and coalesce(is_anonymous, false) = false;
  if v_user is null then
    raise exception 'Chưa tìm thấy tài khoản email ADMIN đã xác nhận. Tạo tài khoản trong Authentication -> Users trước.';
  end if;
  insert into tqt_private.license_admins(user_id) values (v_user) on conflict do nothing;
end;
$$;
