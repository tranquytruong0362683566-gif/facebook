# Quyền riêng tư

Facebook Reels Scanner lưu phiên quét, thiết lập và hàng đợi trong `chrome.storage.local` của extension.

- Extension không thu thập mật khẩu hoặc cookie Facebook.
- Mô tả, tiêu đề và danh sách quét không được gửi cho nhà phát triển.
- Khi người dùng bấm tải, permalink công khai của Reel được gửi tới `fsave.net` để lấy danh sách chất lượng và render MP4.
- Service worker lấy token phiên trực tiếp từ luồng công khai của FSave; token chỉ được giữ tạm trong bộ nhớ và không lưu vào thiết lập.
- Extension không tự mở tab FSave; tối đa 5 permalink đã chọn có thể được xử lý đồng thời trong nền.
- URL tệp hoàn tất do FSave trả về được chuyển cho trình quản lý tải xuống của Chrome.
- Chính sách xử lý URL, log và dữ liệu phía máy chủ thuộc về FSave.
- Khi xóa kết quả, phiên quét và hàng đợi bị xóa khỏi bộ nhớ extension; video đã tải về máy không bị xóa.

Extension không chứa quảng cáo, mã theo dõi riêng, API key, máy chủ cục bộ hoặc công cụ xử lý video cài trên máy.
