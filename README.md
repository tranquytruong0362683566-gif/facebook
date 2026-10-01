# Facebook Auto Comment — Web GitHub Pages 4.0.0

Đây là phần web trong bộ hai phần. Mã nguồn đã đầy đủ, không cần npm hoặc bước build.

## Đưa web lên GitHub

1. Giải nén ZIP, mở thư mục `web-github`.
2. Tạo repository GitHub, ví dụ `auto-binh-luan`.
3. Đưa **nội dung bên trong** thư mục `web-github` lên thư mục gốc của repository. File `index.html` phải nằm ngay ở gốc repository, cùng với `assets`, `scripts`, `shared` và `styles`.
4. Vào **Settings → Pages → Build and deployment**.
5. Chọn **Deploy from a branch**, nhánh **main**, thư mục **/(root)**, rồi **Save**.
6. Khi GitHub báo triển khai thành công, mở URL Pages mà GitHub hiển thị.

Ví dụ, nếu dùng tài khoản có sẵn trong gói cũ và repository `auto-binh-luan`:

```text
https://tranquytruong0362683566-gif.github.io/auto-binh-luan/
```

Đây chỉ là địa chỉ mặc định cấu hình trong extension. Gói này chưa được đăng lên tài khoản GitHub của bạn. Nếu tên tài khoản, repository hoặc tên miền khác, dùng URL GitHub Pages thực tế ở bước tiếp theo.

## Kết nối extension

1. Cài phần `extension` bằng chức năng **Tải tiện ích đã giải nén** trong Chrome.
2. Mở popup extension.
3. Dán URL Pages đầy đủ vào **Địa chỉ web GitHub Pages**.
4. Bấm **Lưu địa chỉ web** và cấp quyền truy cập web khi Chrome hỏi.
5. Bấm **Mở bảng điều khiển web**. Nếu web đã mở trước khi cài/cập nhật extension, tải lại trang.
6. Web tự nhận extension, không cần dán ID extension hay sửa manifest.
7. KEY thiết bị và cơ chế cấp quyền vẫn do extension kiểm tra qua nguồn KEY của gói cũ.

## Chức năng ở phía web

- Bảng điều khiển, nhật ký, hàng đợi và kết quả.
- Kho mẫu, prompt AI, soạn bình luận AI hoặc thủ công.
- Cài đặt AI, Apify, nhóm Facebook, bộ lọc và thời gian nghỉ.
- Điều phối quét, tạo nội dung và gửi lệnh cho extension.
- Sao lưu/nhập dữ liệu trong mục **Dữ liệu**.

API key được nhập trong **Cài đặt API** trên trình duyệt đang dùng. Bản web không chứa API key được ghi sẵn trong mã. Các yêu cầu OpenAI, FlatKey và Apify được extension thực hiện bằng mã API đóng gói sẵn; web không cần backend để xử lý CORS.

Kho mẫu, cài đặt, lịch sử và key do bạn nhập được lưu cục bộ ở trình duyệt theo địa chỉ web, không lưu vào repository GitHub. Các địa chỉ web khác nhau hoặc trình duyệt khác nhau có vùng dữ liệu riêng. File sao lưu xuất ra cũng là dữ liệu riêng của bạn; không đưa nó vào repository web.

## Chuyển dữ liệu từ bản extension cũ

1. Cập nhật phần extension tại **đúng thư mục đã cài bản cũ**, giữ nguyên ID extension; xem README của extension.
2. Mở popup và bấm **Xuất dữ liệu extension cũ**.
3. Xuất file JSON. Mặc định không đưa API key/cookie vào file; có thể chọn bao gồm khi cần.
4. Mở web mới, bấm **Dữ liệu** hoặc **Nhập dữ liệu cũ**, chọn file và bấm **Nhập dữ liệu**.
5. Trang tải lại để áp dụng cài đặt và kho mẫu. Nếu không xuất key/cookie, nhập lại ở Cài đặt API/Cài đặt chạy.

## Chạy thử trên máy

Có thể phục vụ thư mục web bằng Python:

```bash
python -m http.server 8000 --directory web-github
```

Lưu `http://localhost:8000/` trong popup extension, cấp quyền khi Chrome hỏi và mở web. Không mở `index.html` bằng `file://`.

## Khi sử dụng

Giữ Chrome và tab bảng điều khiển mở trong lúc chạy. GitHub Pages phục vụ giao diện tĩnh; tiến trình tự động được điều phối từ tab web. Khi đóng tab, vòng lặp không tiếp tục nhận lệnh mới; thao tác đã gửi tới extension có thể hoàn tất.

Mất kết nối hoặc hết thời gian chờ sẽ không khiến cầu nối tự gửi lại một lệnh bình luận. Kiểm tra kết quả trên Facebook trước khi chủ động chạy lại. Các tính năng Facebook/Shopee vẫn dựa trên cơ chế của gói ban đầu và cần phiên đăng nhập còn hợp lệ.

## Kiểm tra đã thực hiện

Đã kiểm tra cú pháp JavaScript, đường dẫn tài nguyên và 14 tình huống tích hợp mô phỏng bằng mã web, content script, service worker và offscreen thực tế. Xem `TEST_REPORT.txt`.

Môi trường kiểm tra chưa chạy Chrome thật, chưa kiểm tra giao diện bằng trình duyệt và chưa gửi bình luận Facebook hoặc gọi API trả phí thật.

## Tham khảo chính thức

- [Thiết lập nguồn GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [Cơ chế nhắn tin của Chrome Extension](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Đăng ký content script](https://developer.chrome.com/docs/extensions/reference/api/scripting)
