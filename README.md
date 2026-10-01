# Facebook Auto Comment — Web tranquytruong.top 4.1.0

Bản web này chứa toàn bộ giao diện, điều phối và **mã kiểm tra KEY**. Không cần npm hoặc bước build. Dùng cùng extension 4.1.0.

## Tải ZIP trực tiếp lên iNET OneSite

1. Chọn **Tải lên phiên bản** trong OneSite.
2. Tải file `auto-comment-web-inet-v4.1.0.zip`. ZIP có `index.html` ngay ở gốc; không cần giải nén rồi nén lại.
3. Xem trước giao diện, rồi xuất bản cho tên miền **tranquytruong.top** khi tên miền đã được xác minh và sẵn sàng trong iNET.
4. Mở **https://tranquytruong.top/**. Extension tự kết nối tại địa chỉ này.
5. Cài hoặc cập nhật extension 4.1.0 và tải lại tab web. Nếu dùng bản web hoặc extension cũ cùng bản mới, trang yêu cầu cập nhật cả hai.

Trang Preview của iNET có thể xem giao diện; kết nối extension hoạt động ở tên miền chính thức. Gói này chưa được tải lên hay xuất bản vào tài khoản iNET của bạn.

## File kiểm tra KEY nằm ở đâu?

- `scripts/license-verifier.js`: nhận mã máy từ extension, tải danh sách KEY, đối chiếu quyền sử dụng và lưu kết quả theo ngày trên web.
- `scripts/license-access-controller.js`: hiển thị KEY, nút Copy/kiểm tra lại và khóa hoặc mở bảng điều khiển.
- `config/license-config.js`: địa chỉ danh sách KEY. Mặc định giữ nguồn cấp phép hiện có:

```text
https://tranquytruong0362683566-gif.github.io/key/keys.json
```

Extension 4.1.0 chỉ tạo/đọc mã thiết bị `TQT-...`; không tải danh sách hoặc tự xác minh quyền nữa. Mã máy cũ vẫn được dùng nếu cập nhật đúng thư mục extension đang cài.

ADMIN thêm KEY vào danh sách hiện có như trước. File JSON chấp nhận mảng KEY hoặc dạng:

```json
{
  "allowedKeys": [
    { "key": "THAY_BANG_KEY_TQT_CUA_THIET_BI", "active": true }
  ]
}
```

Thay chuỗi mẫu bằng KEY thực tế có dạng `TQT-` và 27 ký tự hex. `active: false` tắt KEY. Mảng rỗng là danh sách không cấp quyền cho máy nào.

Web kiểm tra một lần mỗi ngày và trước lệnh mới khi sang ngày mới. **Kiểm tra lại** luôn tải danh sách mới, kể cả khi KEY đã được cấp quyền. Khi danh sách không truy cập được hoặc định dạng sai, web khóa thao tác và cho phép thử lại. Khi KEY bị từ chối hoặc mất kết nối, vòng tự động dừng nhận lệnh mới. Thao tác đã gửi có thể hoàn tất; kiểm tra kết quả trước khi chạy lại.

## Nếu muốn đặt cả danh sách KEY trên web này

1. Sao chép danh sách KEY hiện đang dùng vào `license/keys.json` trong bộ web. Tạo thư mục `license` nếu chưa có.
2. Trong `config/license-config.js`, đổi `keysSourceUrl` thành `./license/keys.json`.
3. Tải lại toàn bộ ZIP web lên iNET, xuất bản và bấm **Kiểm tra lại**.

Không cần sửa hoặc tải lại extension khi đổi nội dung danh sách hay thuật toán kiểm tra trên web. Khi dùng danh sách từ tên miền khác, máy chủ danh sách phải cho phép trình duyệt đọc bằng CORS; đặt danh sách cùng web sẽ tránh yêu cầu này. Nguồn KEY thật chưa được truy cập/kiểm chứng trong môi trường tạo gói.

Đây là xác minh trong trình duyệt trên website tĩnh; mã kiểm tra và dữ liệu trình duyệt có thể bị sửa. Muốn chống vượt kiểm tra bản quyền cần xác minh trên máy chủ và cơ chế ràng buộc quyền tương ứng ở công cụ.

## Dữ liệu và các chức năng

Giao diện, kho mẫu, prompt AI, hàng đợi, nhật ký, cài đặt và điều phối nằm trên web. Extension thực hiện thao tác Facebook/Shopee và các request OpenAI, FlatKey, Apify bằng mã đóng gói sẵn. Web không chứa API key ghi sẵn; bạn nhập key riêng trong **Cài đặt API**.

Dữ liệu được lưu trên trình duyệt theo địa chỉ website. Giữ cùng tên miền và cùng hồ sơ Chrome để tiếp tục dùng dữ liệu đã lưu. Muốn chuyển dữ liệu, xuất JSON trong mục **Dữ liệu** rồi nhập ở nơi mới. File sao lưu có API key/cookie là dữ liệu riêng, không đăng công khai.

Khi chuyển từ extension cũ, cập nhật extension tại đúng thư mục đang dùng, mở popup → **Xuất dữ liệu extension cũ**, rồi nhập JSON trên web qua **Nhập dữ liệu cũ** hoặc **Dữ liệu**.

## Nếu lưu mã nguồn trên GitHub

Đưa các file/thư mục trong ZIP vào thư mục gốc repository. Có thể giữ GitHub chỉ để lưu mã và dùng iNET để phục vụ web. Nếu chọn GitHub Pages làm hosting, cấu hình custom domain `tranquytruong.top` và DNS tương ứng để web vẫn mở tại địa chỉ chính thức. Extension không kết nối với URL `github.io` hay localhost trong bản này.

## Kiểm tra

20 tình huống tích hợp mô phỏng đã đạt, cùng kiểm tra cú pháp toàn bộ JavaScript. Có kiểm tra nguồn xác minh KEY nằm ở web, cache theo ngày/mã máy/nguồn danh sách, thu hồi KEY, lỗi nguồn, kết nối lại, tên miền cố định, proxy API và sao lưu. Xem `TEST_REPORT.txt`.

Chưa cài extension trên Chrome thật, chưa kiểm tra website iNET đang chạy và chưa gửi bình luận Facebook hay gọi API trả phí thật. Giữ Chrome và tab web mở khi chạy công cụ.
