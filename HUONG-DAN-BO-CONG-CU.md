# CODE by TQT — Bộ công cụ 5.0.0

Bản này có hai phần: **web hiển thị tại https://tranquytruong.top/** và **một extension chung chạy lõi bốn công cụ**. Extension mở web trong Side Panel native. Admin vẫn tại **https://tranquytruong.top/admin/**; ba file admin không thay đổi.

| Công cụ | Giao diện trên web | Lõi trong extension |
| --- | --- | --- |
| Auto bình luận | Soạn bình luận, kho mẫu, hàng đợi, prompt, kết quả | Quét/đọc Facebook, bình luận, API, Shopee |
| Đăng nhóm | Chọn UID, soạn bài, ảnh/video, tiến trình | Phiên Facebook, GraphQL, đăng tuần tự/đăng chéo |
| Page | Chọn Page, Reels/ảnh, nội dung, AI, thống kê | Token Ads Manager, Graph API, tải tệp, đăng bài |
| Tải TikTok & FB | Quét, lọc, kho kết quả, hàng đợi | Content script Facebook/TikTok, liên kết, Chrome Downloads |

## 1. Cập nhật web lên GitHub

1. Giải nén `CODE-by-TQT-web-v5.0.0.zip`. Bên trong có `index.html`, `admin`, `config`, `tools`, `suite`, `scripts`, `shared`, `styles`, `assets`, `CNAME` và `.nojekyll`.
2. Sao lưu repo đang dùng. **Giữ nguyên `config/license-config.js` đã điền Supabase.** File trong gói mới để trống, không ghi đè cấu hình đang chạy bằng file trống.
3. Chép các file mới vào đúng thư mục GitHub Pages đang xuất bản. `index.html` nằm ở thư mục xuất bản, không lồng thêm một thư mục ZIP.
4. Với GitHub Desktop: mở repo `facebook`, chép nội dung gói vào repo, khôi phục cấu hình Supabase đã sao lưu, xem Changes → Commit → Push origin. Với trang GitHub: Add file → Upload files, kéo **file và thư mục đã giải nén**. Gói có hơn 100 file, chia nhiều lượt tải. Tải nguyên ZIP lên repo sẽ không tạo trang web.
5. Giữ `CNAME` có nội dung `tranquytruong.top`. Nếu tên miền/admin cũ đang chạy, không cần sửa DNS iNET hoặc tạo lại Supabase.
6. Chờ Pages triển khai, mở https://tranquytruong.top/ rồi tải lại. Trang thành viên có thanh ngang bốn công cụ và menu trái theo ảnh mẫu.

Nếu cấu hình cũ bị mất, điền **Project URL** và **Publishable key công khai** của dự án đang quản lý KEY:

```javascript
(function () {
  'use strict';
  window.TqtLicenseConfig = Object.freeze({
    dashboardUrl: 'https://tranquytruong.top/',
    supabaseUrl: 'https://aaafdlzajmifgvdzdfse.supabase.co',
    supabasePublishableKey: 'THAY_BANG_PUBLISHABLE_KEY_CONG_KHAI_CUA_DU_AN'
  });
})();
```

Extension gắn với dự án KEY `aaafdlzajmifgvdzdfse`. Nếu đổi dự án, phải đổi cả `extension/src/suite/license-service.js`, host permission trong `manifest.json` và cấu hình web. Không dùng Secret key/service_role trên web.

## 2. Cập nhật extension và giữ KEY

**Cần Chrome 141 trở lên**, do API Side Panel của tiện ích tải video nguồn. Trình duyệt khác cần hỗ trợ các API tương ứng; chưa kiểm tra Firefox.

Nếu đang dùng companion 4.2.0:

1. Sao lưu thư mục extension đang được Chrome tải.
2. Giải nén `CODE-by-TQT-extension-v5.0.0.zip`.
3. Chép **nội dung bên trong thư mục `extension` mới** vào đúng thư mục extension cũ. `manifest.json` mới thay file cũ. Không tạo `extension/extension`, không gỡ rồi cài lại nếu muốn giữ dữ liệu Chrome.
4. Mở `chrome://extensions/` → bấm **Tải lại**. Tiện ích hiện `CODE by TQT · Bộ công cụ`, phiên bản **5.0.0**.
5. Tắt bốn tiện ích độc lập cũ khi dùng bộ chung để tránh thao tác trùng. Giữ thư mục/bản sao dữ liệu cũ.

Nếu cài mới: `chrome://extensions/` → bật **Chế độ dành cho nhà phát triển** → **Tải tiện ích đã giải nén** → chọn thư mục `extension` chứa `manifest.json` → ghim tiện ích → bấm biểu tượng mở Side Panel.

KEY giữ cách tạo/đọc của companion cũ. Bốn công cụ dùng chung KEY, quyền và hạn sử dụng. Xóa tiện ích, đổi hồ sơ hoặc xuất hiện KEY khác vẫn có thể cần admin duyệt lại. Bản này không tự đồng bộ dữ liệu giữa hồ sơ trình duyệt.

## 3. Sử dụng

1. Đăng nhập Facebook/TikTok trong **cùng hồ sơ Chrome** cài extension.
2. Bấm CODE by TQT. Side Panel tải giao diện web; **Mở rộng** mở cùng giao diện trong tab lớn.
3. Web tự nhận KEY và kiểm tra Supabase. KEY được duyệt mở cả bốn công cụ; KEY mới chờ admin như trước.
4. Chọn công cụ trên thanh ngang. Trong Side Panel hẹp, cuộn ngang thanh công cụ; bấm **☰** mở menu chức năng trái.
5. Với tải video, mở Facebook Reels/TikTok cần xử lý trong cùng cửa sổ Chrome trước, rồi chọn Quét Facebook/Quét TikTok.
6. Giữ web hoặc Side Panel đang chạy khi thực hiện chiến dịch. Chuyển công cụ trong cùng giao diện giữ khung và bản nháp. Đóng toàn bộ giao diện/tải lại có thể ngắt điều phối trên web; lệnh đã gửi ở nền có thể vẫn hoàn tất, kiểm tra kết quả trước khi gửi lại.

Nút **Tài khoản** ở đầu Side Panel mở trình quản lý Facebook và xuất dữ liệu auto-comment cũ. Menu Auto bình luận → **Dữ liệu / Sao lưu** mở xuất/nhập JSON. Dữ liệu của bốn tiện ích độc lập trước đây **không tự chuyển từ ID cũ sang ID chung**. Với Page/nhóm/video, giữ bản sao và thiết lập lại nếu không có chức năng xuất phù hợp. Chưa kiểm tra dữ liệu cần giữ thì chưa xóa bản cũ.

## 4. Admin và Supabase

Admin vẫn đăng nhập email/mật khẩu tại `/admin/`, xem KEY, ghi tên khách, cấp quyền, khóa và đặt hạn dùng. Không tạo lại tài khoản admin, không chạy lại SQL khởi tạo khi cập nhật giao diện.

Nếu đã áp dụng nâng cấp **4.2.1 cấp quyền theo KEY**, không cần SQL mới. Nếu còn cơ chế 4.2.0 gắn quyền theo bản cài, chạy `setup/03-share-approved-key.sql` trong đúng dự án một lần theo `HUONG-DAN-ADMIN.md` có sẵn. SQL giữ dữ liệu/quản trị hiện có.

Web và lõi kiểm tra quyền trước lệnh mới, dùng bộ nhớ đệm ngắn. Web kiểm tra định kỳ khi hiển thị. Khóa/hết hạn/lỗi máy chủ chặn lệnh mới; tác vụ đã bắt đầu có thể hoàn tất. Thao tác dừng/hủy vẫn được phép.

## 5. Khi chưa kết nối

- **Không mở Side Panel:** kiểm tra Chrome đủ phiên bản, extension 5.0.0 bật, đã Reload và có quyền với `tranquytruong.top`.
- **Side Panel trống/giao diện cũ:** thử Mở rộng, kiểm tra Pages triển khai và `index.html` nằm đúng thư mục. Website cần hoạt động và có mạng.
- **Yêu cầu extension 5.0.0:** cập nhật cả web và extension.
- **Chưa cấu hình KEY:** khôi phục `config/license-config.js` với Publishable key của dự án đang dùng.
- **Chờ duyệt/khóa/hết hạn:** copy KEY gửi admin, xử lý tại `/admin/`, bấm Kiểm tra lại.
- **Không đọc Facebook/token:** đăng nhập đúng hồ sơ, kiểm tra quyền Facebook/Ads Manager, làm mới phiên. Facebook có thể thay endpoint hoặc yêu cầu xác minh.
- **Không có tab nguồn:** mở Reels/TikTok cùng cửa sổ trước khi quét.
- **Tệp tạm hết hạn:** chọn lại tệp. Tệp hoàn tất được giữ tạm tối đa 24 giờ, tách theo phiên giao diện.

## 6. Kiểm tra và mã nguồn

Hai ZIP chứa đầy đủ mã nguồn, không cần build. Web là HTML/CSS/JavaScript tĩnh. Service worker nạp các engine đóng gói trong `extension/engines`; thao tác đặc quyền chạy từ gói extension. Web hiển thị trong iframe có origin riêng, không nạp mã web vào service worker.

Đã kiểm tra lõi/cầu nối, quyền KEY, chuyển tệp theo khối, lỗi/hủy upload, callback tiến trình và giao diện Chromium ở desktop/chiều rộng Side Panel. Chi tiết trong `TEST_REPORT.txt` và `qa`. API Chrome, Facebook, Supabase trong kiểm tra được mô phỏng.

Chưa đăng nhập Supabase/Facebook thật, chưa gửi bài/bình luận thật, chưa triển khai GitHub. Chromium kiểm tra không tải được extension desktop; Side Panel native cần kiểm tra sau khi cài Chrome thật. Kiểm tra cầu nối dùng mã worker thực và bộ mô phỏng API Chrome.

`admin/` và ba file SQL trong `setup/` giữ nguyên bản 4.2.1. Tài liệu quản trị cũ vẫn ở `HUONG-DAN-ADMIN.md`; báo cáo cũ trong `setup/` là lịch sử nâng cấp database/admin.
