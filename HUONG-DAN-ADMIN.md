# Tạo tài khoản quản trị cho tranquytruong.top

Trang đăng nhập có sẵn trong `admin/`. Để đăng nhập được, tạo dự án Supabase và cấp quyền ADMIN theo các bước dưới đây. Không cần VPS hoặc PHP trên GitHub Pages. Bộ này chưa được triển khai vào tài khoản của bạn và không có mật khẩu mặc định.

## 1. Tạo dự án và cơ sở dữ liệu

1. Mở [Supabase Dashboard](https://supabase.com/dashboard), đăng nhập và tạo **New project**.
2. Đặt tên dự án, chọn vùng, tự đặt mật khẩu cơ sở dữ liệu. Giữ mật khẩu riêng, không đưa vào mã web.
3. Khi dự án sẵn sàng, mở **SQL Editor → New query**.
4. Mở `setup/01-database.sql` trong bộ web, sao chép **toàn bộ** nội dung vào SQL Editor và bấm **Run**.

File tạo bảng KEY, danh sách ADMIN riêng và API quản lý. Không cần tạo thêm bảng hay policy bằng tay. Chạy lại file sẽ giữ dữ liệu KEY hiện có. Không bật truy cập trực tiếp bảng cho khách; ứng dụng dùng các hàm RPC có sẵn trong file.

## 2. Tạo email/mật khẩu và cấp quyền ADMIN

1. Trong dự án Supabase, mở **Authentication → Users**.
2. Chọn **Add user → Create new user** (tên nút có thể thay đổi theo giao diện).
3. Nhập email của bạn, tự đặt mật khẩu. Chọn **Auto Confirm User** nếu có tùy chọn này, hoặc xác nhận email trước bước sau.
4. Mở `setup/02-create-admin.sql`, thay `THAY_EMAIL_ADMIN_CUA_BAN` bằng đúng email vừa tạo. Giữ dấu nháy đơn quanh email.
5. Sao chép toàn bộ file SQL đã sửa vào query mới trong **SQL Editor** và bấm **Run**.

Ví dụ dòng cần sửa:

```sql
where lower(email) = lower('email-cua-ban@example.com')
```

Đây là tài khoản trong **Authentication → Users** của dự án, không phải tài khoản bạn đăng nhập trang quản lý Supabase. SQL chỉ cấp quyền ADMIN, không tạo mật khẩu. Nếu báo chưa tìm thấy tài khoản, kiểm tra email và trạng thái xác nhận.

Trang web không có nút tự đăng ký ADMIN. Tạo thêm quản trị viên bằng cách tạo user rồi chạy lại `02-create-admin.sql` với email mới. Tài khoản thường không có quyền xem/sửa danh sách KEY.

## 3. Điền hai giá trị công khai vào web

1. Mở **Connect** của dự án để lấy **Project URL** và **Publishable key**. Có thể xem/tạo Publishable key trong **Settings → API Keys**.
2. Mở `config/license-config.js` trong bộ web.
3. Thay hai giá trị trống bằng dữ liệu dự án. File hoàn chỉnh có dạng:

```javascript
(function () {
  'use strict';
  window.TqtLicenseConfig = Object.freeze({
    dashboardUrl: 'https://tranquytruong.top/',
    supabaseUrl: 'https://MA_DU_AN_CUA_BAN.supabase.co',
    supabasePublishableKey: 'sb_publishable_GIA_TRI_CUA_BAN'
  });
})();
```

Thay toàn bộ URL/key mẫu bằng giá trị thật. Bản này nhận URL `https://...supabase.co` và Publishable key bắt đầu bằng `sb_publishable_`.

**Chỉ điền Publishable key công khai.** Không đưa Secret key, `service_role`, mật khẩu cơ sở dữ liệu hay mật khẩu ADMIN vào web/GitHub. Publishable key xác định ứng dụng; quyền ADMIN do phiên đăng nhập và máy chủ kiểm tra.

Không cần điền Supabase vào extension. Extension gắn với `https://tranquytruong.top/`; web gọi cơ sở dữ liệu.

## 4. Đưa web lên GitHub Pages

1. Giải nén ZIP web. `index.html` nằm ngay gốc, cùng `admin`, `config`, `shared`, `scripts`, `styles`, `assets` và `setup`.
2. Mở [repository facebook](https://github.com/tranquytruong0362683566-gif/facebook).
3. Chọn **Add file → Upload files**, kéo các file/thư mục **bên trong** bộ web vào gốc repository và commit. Giữ đầy đủ thư mục con, không chỉ tải riêng `index.html` hay ZIP.
4. Mở **Settings → Pages**. Nếu xuất bản từ nhánh, chọn nhánh đang dùng và **/(root)**. Custom domain là `tranquytruong.top`; bật **Enforce HTTPS** khi GitHub cho phép.
5. Giữ file `CNAME` ở gốc với một dòng `tranquytruong.top`. DNS ở iNET phải trỏ tới GitHub Pages theo phần thiết lập tên miền trước đó.
6. Sau khi GitHub triển khai xong, mở [trang quản trị](https://tranquytruong.top/admin/) và đăng nhập bằng email/mật khẩu ở bước 2.

Đặt file ở gốc để địa chỉ là `/admin/`, không phải `/facebook/admin/` hay `/web-github/admin/` trên tên miền riêng. Extension chỉ kết nối tại tên miền chính thức. Nếu chọn iNET phục vụ web, dùng toàn bộ bộ web đã điền cấu hình; Supabase vẫn lưu đăng nhập và KEY.

## 5. Cập nhật extension và duyệt KEY

1. Giải nén ZIP extension 4.2.0.
2. Đang dùng bản cũ: chép nội dung mới vào đúng thư mục Chrome đang tải, giữ thư mục/ID; không gỡ tiện ích. Bấm **Tải lại** tại `chrome://extensions/`.
3. Cài mới: bật **Chế độ dành cho nhà phát triển → Tải tiện ích đã giải nén**, chọn thư mục `extension` có `manifest.json`.
4. Khách mở [tranquytruong.top](https://tranquytruong.top/) trong cùng hồ sơ Chrome với extension. KEY tự đăng ký và hiện **Chờ duyệt**.
5. Bạn vào `/admin/`, bấm **Tải lại** nếu cần, mở **Quản lý** tại KEY của khách.
6. Ghi **Tên khách hàng**, đặt **Hạn sử dụng** nếu cần, bấm **Cấp quyền**. Để trống hạn nếu không giới hạn thời gian.
7. Khách bấm **Kiểm tra lại** hoặc chờ trang tự kiểm tra để mở bảng điều khiển.

Quyền trong danh sách `keys.json` cũ không được chuyển tự động. KEY cũ vẫn giữ nếu dữ liệu extension còn, nhưng cần ADMIN duyệt lại trong Supabase.

## Quản lý hàng ngày

| Việc cần làm | Thao tác |
| --- | --- |
| Ghi tên/ghi chú khách | Tìm KEY/tên → Quản lý → nhập thông tin → Lưu thay đổi |
| Cấp quyền | Quản lý → Cấp quyền |
| Khóa | Quản lý → Khóa KEY |
| Gia hạn | Quản lý → chọn hạn trong tương lai → Cấp quyền hoặc Lưu thay đổi |
| Không giới hạn hạn dùng | Xóa ô Hạn sử dụng → Cấp quyền hoặc Lưu thay đổi |
| Xem KEY hết hạn | Chọn bộ lọc Hết hạn |
| Khách cài lại và bị xung đột | Xác minh khách/KEY → Quản lý → Đăng ký lại extension → Cho phép đăng ký lại; khách mở lại web, ADMIN duyệt lại |
| Đăng xuất | Bấm Đăng xuất ở đầu trang |

Hạn hiển thị theo múi giờ máy quản trị, lưu UTC, được kiểm tra bằng giờ máy chủ. Đăng ký lại hủy quyền cũ; bản cài tiếp theo gắn định danh với KEY nhưng vẫn chờ duyệt. Nếu phần cứng hai máy sinh cùng KEY, cần xử lý mã định danh riêng, không đặt lại liên tục để duyệt cả hai.

Danh sách tự cập nhật mỗi 30 giây khi tab hoạt động. Nếu hai ADMIN sửa cùng KEY, lần lưu dữ liệu cũ bị từ chối: đóng hộp sửa, tải lại rồi mở lại KEY.

## Thu hồi quyền ADMIN

Trong Supabase SQL Editor, thay email và chạy:

```sql
delete from tqt_private.license_admins
where user_id in (
  select id from auth.users where lower(email) = lower('email-can-go@example.com')
);
```

Không xóa danh sách KEY. Mỗi API quản trị kiểm tra quyền, nên người bị gỡ quyền không tiếp tục sửa KEY bằng phiên cũ.

## Lỗi thường gặp

| Tình trạng | Kiểm tra |
| --- | --- |
| Chưa cấu hình Supabase | Điền `config/license-config.js`, commit và tải lại web |
| Sai email/mật khẩu | Dùng tài khoản Authentication của dự án, kiểm tra xác nhận email và mật khẩu tự đặt |
| Chưa được cấp quyền ADMIN | Chạy `02-create-admin.sql` cho đúng email/dự án |
| Không tìm thấy RPC | Chạy đủ `01-database.sql`, kiểm tra Project URL |
| Chưa có KEY | Khách cần mở trang chính với extension 4.2.0; vào `/admin/` không tự tạo KEY |
| KEY gắn với bản cài khác | Xác minh khách trước khi dùng Đăng ký lại extension |
| Chưa kết nối extension | Đúng `https://tranquytruong.top/`, cùng hồ sơ Chrome; tải lại extension/tab |
| `/admin/` báo 404 | Kiểm tra `admin/index.html`, nhánh/thư mục xuất bản và trạng thái triển khai GitHub Pages |
| Lỗi mạng/hết thời gian khi lưu | Tải lại danh sách xem đã lưu chưa, rồi mới thử lại |

## Chạy lại kiểm tra

Website không cần các gói Node để hoạt động. Để kiểm tra bằng Node.js 24 trở lên, giữ `web-github` cạnh `extension`:

```bash
node --experimental-vm-modules extension/tests/verify.mjs
```

Vào thư mục `web-github/setup` để kiểm tra SQL/giao diện:

```bash
npm install
npm run test:database
npx playwright install chromium
npm run test:browser
```

SQL dùng PostgreSQL nhúng, không nối dự án thật. Test trình duyệt gọi SQL thật trong fixture nhưng mô phỏng Supabase Auth/JWT. Không dùng tài khoản Facebook, email, mật khẩu hay key dự án thật trong các test.

## Tài liệu chính thức

- [GitHub Pages là hosting tĩnh](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [Đăng nhập email/mật khẩu Supabase](https://supabase.com/docs/guides/auth/passwords)
- [Publishable key và Secret key](https://supabase.com/docs/guides/getting-started/api-keys)
- [Hàm cơ sở dữ liệu và quyền thực thi](https://supabase.com/docs/guides/database/functions)
- [Phân quyền hàng dữ liệu](https://supabase.com/docs/guides/database/postgres/row-level-security)
