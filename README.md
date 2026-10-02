# Trần Quý Trường — Web và quản trị KEY 4.2.0

Web tại `https://tranquytruong.top/` và trang đăng nhập quản trị tại `https://tranquytruong.top/admin/`. Dùng cùng extension 4.2.0. Web là HTML/CSS/JavaScript tĩnh, không cần build; Supabase xử lý đăng nhập, lưu danh sách thiết bị và kiểm tra quyền trên máy chủ.

**Chưa triển khai vào GitHub hay Supabase của bạn.** Hai giá trị Supabase trong `config/license-config.js` đang để trống. Làm theo [HUONG-DAN-ADMIN.md](HUONG-DAN-ADMIN.md) trước khi sử dụng.

## Các file chính

- `admin/`: đăng nhập email/mật khẩu; danh sách KEY, tên khách, ghi chú, Cấp quyền, Khóa, hạn sử dụng, tìm kiếm, lọc và phân trang.
- `setup/01-database.sql`: cơ sở dữ liệu, phân quyền và API đăng ký/duyệt KEY.
- `setup/02-create-admin.sql`: cấp quyền ADMIN cho tài khoản Supabase đã tạo và xác nhận email.
- `config/license-config.js`: Project URL và **Publishable key** công khai của Supabase.
- `shared/supabase-api.js`: gọi Supabase Auth/RPC, giữ phiên ADMIN trong `sessionStorage` của tab; không lưu mật khẩu.
- `scripts/license-verifier.js`: nhận KEY và định danh bản cài từ extension, đăng ký với Supabase, nhận quyền từ máy chủ.
- `scripts/license-access-controller.js`: hiển thị KEY và mở/khóa bảng điều khiển.
- `CNAME`: tên miền `tranquytruong.top` dùng cho GitHub Pages.

## Luồng khách hàng

Khách mở trang chính cùng extension. Web tự gửi KEY đến Supabase; KEY mới luôn **Chờ duyệt**. ADMIN vào `/admin/`, mở **Quản lý**, ghi tên khách rồi **Cấp quyền**. Khách bấm **Kiểm tra lại** hoặc chờ lần kiểm tra tự động.

Hạn dùng được đánh giá bằng giờ máy chủ. Web kiểm tra mỗi 30 giây khi tab đang hoạt động và trước lệnh mới; kết quả cấp quyền chỉ giữ trong bộ nhớ tối đa 15 giây. Nút **Kiểm tra lại** lấy trạng thái mới. Khóa/hết hạn/lỗi máy chủ chặn lệnh mới; tác vụ đã gửi có thể hoàn tất và cần kiểm tra trước khi chạy lại.

Chỉ ADMIN được đọc danh sách KEY, tên khách và ghi chú, hoặc sửa quyền trên máy chủ. Trang ADMIN không cần extension.

## Nâng cấp từ 4.1.0

Thiết lập Supabase và ADMIN, điền cấu hình, cập nhật toàn bộ web và extension. Giữ nguyên thư mục/ID tiện ích để giữ KEY và dữ liệu. Bản này thêm định danh ngẫu nhiên riêng cho bản cài trong `chrome.storage.local`.

**Quyền trong `keys.json` cũ không được nhập tự động.** KEY cũ đăng ký vào Supabase ở trạng thái Chờ duyệt, cần ADMIN duyệt lại. Bản này không đọc danh sách GitHub cũ; chưa cấu hình Supabase thì không cấp quyền sử dụng.

## Dữ liệu và các chức năng khác

Giao diện, kho mẫu, prompt AI, hàng đợi, nhật ký, cài đặt và điều phối vẫn nằm trên web. Extension thực hiện thao tác Facebook/Shopee và request OpenAI, FlatKey, Apify bằng mã đóng gói sẵn. Web không chứa API key ghi sẵn; người dùng nhập key riêng trong **Cài đặt API**.

Dữ liệu công cụ vẫn lưu trong trình duyệt theo địa chỉ website; Supabase ở bản này chỉ lưu đăng ký và quyền KEY. Giữ cùng tên miền và hồ sơ Chrome để tiếp tục dùng dữ liệu cũ. Chuyển dữ liệu bằng xuất/nhập JSON trong mục **Dữ liệu**. Khi chuyển từ extension cũ, mở popup → **Xuất dữ liệu extension cũ**, rồi nhập JSON trên web.

## Phạm vi bảo vệ

Phân quyền ADMIN và trạng thái KEY được kiểm tra trong PostgreSQL/Supabase. Sửa giao diện hay dữ liệu phiên trình duyệt không cấp quyền đọc/sửa danh sách trên máy chủ. Định danh bản cài được lưu dạng hash; API khách không trả tên khách, ghi chú hay danh sách KEY.

Công cụ thực hiện thao tác Facebook trong extension của khách. Người có khả năng sửa mã web/extension có thể thay cổng kiểm tra trước thao tác. Bản này chưa có bằng chứng cấp phép có chữ ký để extension tự xác minh; đây không phải cơ chế chống sửa mã tuyệt đối.

KEY giữ cách tạo mã thiết bị của bản trước. Phần cứng giống nhau có thể sinh KEY trùng; hồ sơ Chrome khác hoặc cài lại extension có thể mất định danh bản cài. Xung đột sẽ bị từ chối và yêu cầu ADMIN xử lý. Không coi KEY là số sê-ri phần cứng hay bằng chứng về một người dùng.

## Kiểm tra

Xem `TEST_REPORT.txt` và các báo cáo trong `setup/`. Kiểm tra tích hợp web/extension, phân quyền bằng PostgreSQL nhúng và giao diện Chromium. Supabase Auth/JWT được mô phỏng trong kiểm tra giao diện; chưa đăng nhập dự án Supabase thật, chưa xuất bản GitHub, chưa gửi bình luận Facebook hoặc gọi API trả phí thật.

Hướng dẫn thiết lập, tải file lên GitHub, dùng ADMIN và chạy lại kiểm tra nằm trong [HUONG-DAN-ADMIN.md](HUONG-DAN-ADMIN.md).
