# CODE by TQT — Web 5.0.0

Trang thành viên tại **https://tranquytruong.top/** hiển thị Auto bình luận, Đăng nhóm, Page và Tải TikTok & FB trong giao diện theo ảnh mẫu. Dùng cùng extension CODE by TQT 5.0.0: web hiển thị/điều phối, extension chạy lõi. Admin tại `/admin/` giữ nguyên.

Web HTML/CSS/JavaScript tĩnh, không cần build. Giải nén rồi cập nhật nội dung vào thư mục GitHub Pages đang xuất bản. **Giữ nguyên `config/license-config.js` đã điền Supabase; file trong gói để trống.** Giữ `CNAME`, `.nojekyll` và cấu hình Pages hiện tại.

Hướng dẫn đầy đủ: [HUONG-DAN-BO-CONG-CU.md](HUONG-DAN-BO-CONG-CU.md). Quản trị hiện có: [HUONG-DAN-ADMIN.md](HUONG-DAN-ADMIN.md). Đã nâng cấp quyền theo KEY 4.2.1 thì không cần SQL mới. Không chạy lại SQL khởi tạo để cập nhật giao diện.

Các khung công cụ được giữ khi chuyển menu. Dữ liệu công cụ lưu trong trình duyệt; Supabase lưu quyền KEY/quản trị như trước. Dữ liệu từ ID của bốn extension độc lập cũ không tự chuyển sang ID chung.

Kiểm tra 5.0.0: `TEST_REPORT.txt` và `qa/`. Báo cáo trong `setup/` thuộc nâng cấp database/admin 4.2.1, được giữ làm lịch sử. Chưa triển khai GitHub/Supabase hoặc thao tác Facebook thật.
