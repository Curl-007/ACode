// ACode 原创（specs/windows-helper-producer.md §10.1/§10.7）。
// WGC 截图面：captureDisplay（显示器按 HMONITOR）+ captureWindow（A2 桩，见下）。
// 机制（决策一钉死）：C++/WinRT + D3D11 + WIC；N-API 异步 Promise；捕获、缩放与
// PNG/JPEG 编码全部在同一后台 worker 线程执行（WinRT MTA apartment），V8 主线程绝不
// 阻塞（§10.10）；PNG 为 8-bit BGRA→SDR 语义、保留系统默认 capture border、不承诺
// HDR/色彩管理保真（上游机制记载 windows-source-development.md:268）。
//
// 截图诚实（§10.7 红线）：锁屏/Session 0/非默认输入桌面/DPI 未达标 → non_interactive_desktop；
// WGC 拒绝（含更高完整性级别目标）/帧等待 5s 超时 → capture_failed；预算阶梯穷尽 →
// budget_exceeded；绝不用空白像素或任何 fallback 冒充成功，失败类别也绝不伪报成
// 「成功但空图」。取消（stop/cancelOperations）在帧等待环内 ≤50ms 粒度检查 → canceled。
//
// 预算阶梯（§10.7 钉死；producer 自持 byte budget，不得要求模型计算）：
//   原生分辨率捕获 → 最长边缩放至 ≤maxDimension(2000) → PNG → base64 折算
//   ≤inlineBase64BudgetBytes(200 KiB)？否 → 最长边 1600→1280→1024 逐级重编 PNG →
//   仍超 → JPEG q80→q60（同尺寸，有损但几何不变——坐标投影仍成立）→ 仍超 →
//   budget_exceeded 诚实失败。
//
// captureWindow（A2 桩）：windowToken 的解析依赖 A3 的窗口注册表（§5.3 window_registry.cc
// 属 A3；token→HWND+身份快照+前后双复核 §10.7 均以注册表为前提）。A2 无观察面 ⇒ 不存在
// 任何合法 token ⇒ 任何 token 一律 target_changed（wire → element_unavailable「observation
// state is stale; observe the application again.」——诚实 fail-closed，绝不拿裸 HWND 猜测
// 身份绕过双复核）。A3 落地注册表后收口为真实现。
#include "ax_internal.h"

#include <d3d11.h>
#include <dxgi.h>
#include <unknwn.h>
#include <wincodec.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.h>
#include <winrt/base.h>
#include <Windows.Graphics.Capture.Interop.h>
#include <Windows.Graphics.DirectX.Direct3D11.Interop.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <mutex>
#include <vector>

namespace ax {
namespace {

namespace capture_ns = winrt::Windows::Graphics::Capture;
namespace directx_ns = winrt::Windows::Graphics::DirectX;

constexpr DWORD kFrameWaitTimeoutMs = 5000;  // 帧等待有界 5s（§10.7）→ capture_failed
constexpr DWORD kFrameWaitSliceMs = 50;      // 取消检查粒度（≤500ms 中断契约的捕获面）

// ── 显示器枚举（确定性顺序：主显 = index 0，其余按 (left, top) 升序）──
struct MonitorEntry {
  HMONITOR handle = nullptr;
  RECT rect{};
  bool primary = false;
};

// 显示器拓扑指纹（§10.7 世代对照的事实源）：「monitor 集合 + 各 bounds」序列化串。
// captureDisplay 每次捕获顺带产出（CaptureResult.topologyFingerprint，spec §10.1 回写
// 登记）——A2 无常驻监听面，frame-registry 的拓扑换代判定以捕获时指纹为准。
std::string MonitorsFingerprint(const std::vector<MonitorEntry>& monitors) {
  std::string fingerprint;
  for (const MonitorEntry& entry : monitors) {
    fingerprint += std::to_string(entry.rect.left) + "," + std::to_string(entry.rect.top) + "," +
                   std::to_string(entry.rect.right) + "," + std::to_string(entry.rect.bottom) + ";";
  }
  return fingerprint;
}

std::vector<MonitorEntry> EnumerateMonitors() {
  std::vector<MonitorEntry> monitors;
  EnumDisplayMonitors(
      nullptr, nullptr,
      [](HMONITOR handle, HDC, LPRECT, LPARAM data) -> BOOL {
        auto* list = reinterpret_cast<std::vector<MonitorEntry>*>(data);
        MONITORINFOEXW info{};
        info.cbSize = sizeof(info);
        if (GetMonitorInfoW(handle, &info)) {
          MonitorEntry entry;
          entry.handle = handle;
          entry.rect = info.rcMonitor;
          entry.primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0;
          list->push_back(entry);
        }
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&monitors));
  std::stable_sort(monitors.begin(), monitors.end(),
                   [](const MonitorEntry& a, const MonitorEntry& b) {
                     if (a.primary != b.primary) return a.primary;
                     if (a.rect.left != b.rect.left) return a.rect.left < b.rect.left;
                     return a.rect.top < b.rect.top;
                   });
  return monitors;
}

long long IntersectionArea(const RECT& a, const RECT& b) {
  const long long w = std::min<long long>(a.right, b.right) - std::max<long long>(a.left, b.left);
  const long long h = std::min<long long>(a.bottom, b.bottom) - std::max<long long>(a.top, b.top);
  return (w > 0 && h > 0) ? w * h : 0;
}

// ── WinRT MTA apartment（每 Execute 一次；libuv 线程池线程无既有 STA）──
// 注：本 SDK（10.0.26100）的 winrt::init_apartment 返回 void（无 apartment_token 形态），
// uninit_apartment() 无参——RAII 包装按该签名落地。
struct MtaApartment {
  bool valid = false;
  MtaApartment() {
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
      valid = true;
    } catch (const winrt::hresult_error&) {
      valid = false;  // 环境异常 → Execute 侧以 capture_failed 诚实失败
    }
  }
  ~MtaApartment() {
    if (valid) winrt::uninit_apartment();
  }
  MtaApartment(const MtaApartment&) = delete;
  MtaApartment& operator=(const MtaApartment&) = delete;
};

// ── WIC 编码（缩放 + PNG/JPEG；同一 worker 线程）──
struct EncodedImage {
  std::vector<uint8_t> bytes;
  int width = 0;
  int height = 0;
  bool jpeg = false;
};

bool Base64Fits(size_t byteCount, long long budgetBytes) {
  // base64 折算长度 = ceil(n/3)*4（不含换行；宿主 image-normalization 同口径）。
  const long long encoded = static_cast<long long>((byteCount + 2) / 3) * 4;
  return encoded <= budgetBytes;
}

// 从 BGRA 像素缓冲编码一帧；scaleTo ∈ (0, max(w,h)) 时按最长边等比缩放（Fant 插值）。
bool EncodeFrame(IWICImagingFactory* factory, const std::vector<uint8_t>& pixels, int width,
                 int height, int scaleTo, bool jpeg, float quality, EncodedImage& out) {
  if (factory == nullptr || pixels.empty() || width <= 0 || height <= 0) return false;
  winrt::com_ptr<IWICBitmap> bitmap;
  if (FAILED(factory->CreateBitmapFromMemory(
          static_cast<UINT>(width), static_cast<UINT>(height), GUID_WICPixelFormat32bppBGRA,
          static_cast<UINT>(width) * 4, static_cast<UINT>(pixels.size()),
          const_cast<BYTE*>(pixels.data()), bitmap.put()))) {
    return false;
  }

  winrt::com_ptr<IWICBitmapSource> source;
  bitmap.as(source);
  int outWidth = width;
  int outHeight = height;
  winrt::com_ptr<IWICBitmapScaler> scaler;
  if (scaleTo > 0 && scaleTo < std::max(width, height)) {
    const double ratio =
        static_cast<double>(scaleTo) / static_cast<double>(std::max(width, height));
    outWidth = std::max(1, static_cast<int>(std::lround(width * ratio)));
    outHeight = std::max(1, static_cast<int>(std::lround(height * ratio)));
    if (FAILED(factory->CreateBitmapScaler(scaler.put()))) return false;
    if (FAILED(scaler->Initialize(bitmap.get(), static_cast<UINT>(outWidth),
                                  static_cast<UINT>(outHeight),
                                  WICBitmapInterpolationModeFant))) {
      return false;
    }
    source = nullptr;
    scaler.as(source);
  }

  // JPEG 编码器要 24bppRGB 源（BGRA→RGB 显式转换；PNG 直接吃 32bppBGRA）。
  winrt::com_ptr<IWICFormatConverter> converter;
  if (jpeg) {
    if (FAILED(factory->CreateFormatConverter(converter.put()))) return false;
    if (FAILED(converter->Initialize(source.get(), GUID_WICPixelFormat24bppRGB,
                                     WICBitmapDitherTypeNone, nullptr, 0.0,
                                     WICBitmapPaletteTypeCustom))) {
      return false;
    }
    source = nullptr;
    converter.as(source);
  }

  winrt::com_ptr<IStream> stream;
  if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, stream.put()))) return false;
  winrt::com_ptr<IWICBitmapEncoder> encoder;
  if (FAILED(factory->CreateEncoder(jpeg ? GUID_ContainerFormatJpeg : GUID_ContainerFormatPng,
                                    nullptr, encoder.put()))) {
    return false;
  }
  if (FAILED(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache))) return false;

  winrt::com_ptr<IWICBitmapFrameEncode> frameEncode;
  winrt::com_ptr<IPropertyBag2> propertyBag;
  if (FAILED(encoder->CreateNewFrame(frameEncode.put(), propertyBag.put()))) return false;
  if (jpeg && propertyBag) {
    PROPBAG2 option{};
    option.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
    VARIANT value{};
    value.vt = VT_R4;
    value.fltVal = quality;
    if (FAILED(propertyBag->Write(1, &option, &value))) return false;
  }
  if (FAILED(frameEncode->Initialize(propertyBag.get()))) return false;
  if (FAILED(frameEncode->SetSize(static_cast<UINT>(outWidth), static_cast<UINT>(outHeight)))) {
    return false;
  }
  WICPixelFormatGUID pixelFormat =
      jpeg ? GUID_WICPixelFormat24bppRGB : GUID_WICPixelFormat32bppBGRA;
  if (FAILED(frameEncode->SetPixelFormat(&pixelFormat))) return false;
  if (FAILED(frameEncode->WriteSource(source.get(), nullptr))) return false;
  if (FAILED(frameEncode->Commit())) return false;
  if (FAILED(encoder->Commit())) return false;

  HGLOBAL global = nullptr;
  if (FAILED(GetHGlobalFromStream(stream.get(), &global)) || !global) return false;
  const SIZE_T size = GlobalSize(global);
  void* locked = GlobalLock(global);
  if (!locked || size == 0) {
    if (locked) GlobalUnlock(global);
    return false;
  }
  out.bytes.resize(size);
  memcpy(out.bytes.data(), locked, size);
  GlobalUnlock(global);
  out.width = outWidth;
  out.height = outHeight;
  out.jpeg = jpeg;
  return true;
}

// 帧到达共享态（回调可能在线程池上执行；shared_ptr 保证 revoke 后 in-flight 回调
// 触及的状态与事件句柄仍存活——悬空引用/句柄复用的结构性排除）。
struct FrameArrivalState {
  std::mutex mutex;
  HANDLE event = nullptr;
  capture_ns::Direct3D11CaptureFrame frame{nullptr};
  ~FrameArrivalState() {
    if (event) CloseHandle(event);
  }
};

// ── captureDisplay worker ─────────────────────────────────────────────────────
struct DisplayTarget {
  bool byBounds = false;
  int monitorIndex = 0;
  RECT bounds{};  // byBounds 时的虚拟桌面物理像素矩形
};

class CaptureDisplayWorker final : public PromiseWorker {
 public:
  CaptureDisplayWorker(const Napi::Env& env, DisplayTarget target, int maxDimension,
                       long long budgetBytes)
      : PromiseWorker(env), target_(target), maxDimension_(maxDimension), budgetBytes_(budgetBytes) {}

 protected:
  void Execute() override;

  Napi::Value BuildResult(const Napi::Env& env) override {
    // image = Uint8Array（§10.1 CaptureResult.image）；字节只经返回值上 JS 面，
    // 绝不落盘/打印（屏幕内容是隐私面，§10.11 用例表纪律）。
    Napi::Object result = Napi::Object::New(env);
    result.Set("image", Napi::Buffer<uint8_t>::Copy(env, image_.data(), image_.size()));
    result.Set("encoding", Napi::String::New(env, jpeg_ ? "jpeg" : "png"));
    result.Set("width", Napi::Number::New(env, static_cast<double>(width_)));
    result.Set("height", Napi::Number::New(env, static_cast<double>(height_)));
    Napi::Object bounds = Napi::Object::New(env);
    bounds.Set("x", Napi::Number::New(env, static_cast<double>(boundsRect_.left)));
    bounds.Set("y", Napi::Number::New(env, static_cast<double>(boundsRect_.top)));
    bounds.Set("width",
               Napi::Number::New(env, static_cast<double>(boundsRect_.right - boundsRect_.left)));
    bounds.Set("height",
               Napi::Number::New(env, static_cast<double>(boundsRect_.bottom - boundsRect_.top)));
    result.Set("bounds", bounds);
    result.Set("scaled", Napi::Boolean::New(env, scaled_));
    // budgetFit 恒 true：超预算的路径是 budget_exceeded 类型化失败，绝不「成功但超预算」。
    result.Set("budgetFit", Napi::Boolean::New(env, true));
    result.Set("topologyFingerprint", Napi::String::New(env, topologyFingerprint_));
    return result;
  }

 private:
  bool CaptureMonitorPixels(const MonitorEntry& monitor, std::vector<uint8_t>& pixels, int& width,
                            int& height);
  bool RunBudgetLadder(const std::vector<uint8_t>& pixels, int width, int height);
  void CommitEncoded(const EncodedImage& encoded, int capturedWidth, int capturedHeight) {
    image_ = encoded.bytes;
    jpeg_ = encoded.jpeg;
    width_ = encoded.width;
    height_ = encoded.height;
    scaled_ = (encoded.width != capturedWidth || encoded.height != capturedHeight);
  }

  DisplayTarget target_;
  int maxDimension_;
  long long budgetBytes_;
  // 结果事实（BuildResult 在主线程读取；AsyncWorker 的 Queue→OnOK 时序保证可见性）。
  std::vector<uint8_t> image_;
  bool jpeg_ = false;
  int width_ = 0;
  int height_ = 0;
  RECT boundsRect_{};
  bool scaled_ = false;
  std::string topologyFingerprint_;
};

void CaptureDisplayWorker::Execute() {
  // stop 非闩锁（§10.6）：新捕获在入口清零取消旗标；帧等待环内检查取消（≤50ms 粒度）。
  g_cancelRequested.store(false);

  // 截图诚实 preflight（§10.7/§10.9）：锁屏/Session 0/非默认输入桌面/DPI 未达标一律
  // 固定失败关闭——DPI 虚拟化会让 bounds 与栅格失配，绝不带病捕获。
  if (!DetectInteractiveDesktop() || DetectSessionZero() || !g_dpiAware.load()) {
    FailAx(kNonInteractiveDesktop, false);
    return;
  }

  MtaApartment apartment;
  if (!apartment.valid) {
    FailAx(kCaptureFailed, false);
    return;
  }

  // 目标解析：monitorIndex → 枚举序（主显 = 0）；bounds → 相交面积最大的显示器 + 裁剪。
  const std::vector<MonitorEntry> monitors = EnumerateMonitors();
  if (monitors.empty()) {
    FailAx(kCaptureFailed, false);
    return;
  }
  topologyFingerprint_ = MonitorsFingerprint(monitors);
  const MonitorEntry* chosen = nullptr;
  RECT crop{};
  bool useCrop = false;
  if (!target_.byBounds) {
    if (target_.monitorIndex < 0 || static_cast<size_t>(target_.monitorIndex) >= monitors.size()) {
      FailAx(kCaptureFailed, false);  // 索引越界 = 目标不存在，诚实失败（不猜主显）
      return;
    }
    chosen = &monitors[static_cast<size_t>(target_.monitorIndex)];
    crop = chosen->rect;
  } else {
    long long bestArea = 0;
    for (const MonitorEntry& entry : monitors) {
      const long long area = IntersectionArea(entry.rect, target_.bounds);
      if (area > bestArea) {
        bestArea = area;
        chosen = &entry;
      }
    }
    if (!chosen || bestArea <= 0) {
      FailAx(kCaptureFailed, false);  // bounds 不与任何显示器相交
      return;
    }
    crop.left = std::max(chosen->rect.left, target_.bounds.left);
    crop.top = std::max(chosen->rect.top, target_.bounds.top);
    crop.right = std::min(chosen->rect.right, target_.bounds.right);
    crop.bottom = std::min(chosen->rect.bottom, target_.bounds.bottom);
    useCrop = true;
  }

  std::vector<uint8_t> pixels;
  int capturedWidth = 0;
  int capturedHeight = 0;
  if (!CaptureMonitorPixels(*chosen, pixels, capturedWidth, capturedHeight)) {
    return;  // FailAx 已由内层设置
  }

  // bounds 形态：裁剪到相交矩形（全链一致虚拟桌面空间，§10.7 副屏负坐标合法）。
  if (useCrop) {
    const int cropX = crop.left - chosen->rect.left;
    const int cropY = crop.top - chosen->rect.top;
    const int cropW = crop.right - crop.left;
    const int cropH = crop.bottom - crop.top;
    if (cropX < 0 || cropY < 0 || cropW <= 0 || cropH <= 0 || cropX + cropW > capturedWidth ||
        cropY + cropH > capturedHeight) {
      FailAx(kCaptureFailed, false);  // 栅格与显示器几何失配（DPI 异常等）——诚实失败
      return;
    }
    std::vector<uint8_t> cropped(static_cast<size_t>(cropW) * cropH * 4);
    for (int row = 0; row < cropH; row += 1) {
      memcpy(cropped.data() + static_cast<size_t>(row) * cropW * 4,
             pixels.data() + (static_cast<size_t>(cropY + row) * capturedWidth + cropX) * 4,
             static_cast<size_t>(cropW) * 4);
    }
    pixels = std::move(cropped);
    capturedWidth = cropW;
    capturedHeight = cropH;
  }
  boundsRect_ = crop;

  RunBudgetLadder(pixels, capturedWidth, capturedHeight);  // 失败路径已 FailAx
}

bool CaptureDisplayWorker::CaptureMonitorPixels(const MonitorEntry& monitor,
                                                std::vector<uint8_t>& pixels, int& width,
                                                int& height) {
  using winrt::com_ptr;
  // D3D11 设备（硬件优先，WARP 兜底——虚拟机/无硬件适配器场景仍是 WGC 合法管线，
  // 不是「空白像素 fallback」；两条驱动路径都失败才 capture_failed）。
  com_ptr<ID3D11Device> device;
  com_ptr<ID3D11DeviceContext> context;
  const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, nullptr, 0,
                                 D3D11_SDK_VERSION, device.put(), nullptr, context.put());
  if (FAILED(hr)) {
    device = nullptr;
    context = nullptr;
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags, nullptr, 0,
                           D3D11_SDK_VERSION, device.put(), nullptr, context.put());
  }
  if (FAILED(hr)) {
    FailAx(kCaptureFailed, false);
    return false;
  }

  com_ptr<IDXGIDevice> dxgiDevice;
  if (FAILED(device->QueryInterface(IID_PPV_ARGS(dxgiDevice.put())))) {
    FailAx(kCaptureFailed, false);
    return false;
  }
  com_ptr<::IInspectable> inspectable;
  if (FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.get(), inspectable.put()))) {
    FailAx(kCaptureFailed, false);
    return false;
  }
  const directx_ns::Direct3D11::IDirect3DDevice winrtDevice =
      inspectable.as<directx_ns::Direct3D11::IDirect3DDevice>();

  if (!capture_ns::GraphicsCaptureSession::IsSupported()) {
    FailAx(kCaptureFailed, false);  // WGC 不可用（策略禁用等）——诚实失败，无 fallback
    return false;
  }

  // IGraphicsCaptureItemInterop（WinRT 激活工厂 QI；保守形态：get_abi + QueryInterface）。
  com_ptr<IGraphicsCaptureItemInterop> interop;
  {
    const auto activationFactory = winrt::get_activation_factory<capture_ns::GraphicsCaptureItem>();
    hr = reinterpret_cast<::IUnknown*>(winrt::get_abi(activationFactory))
             ->QueryInterface(IID_PPV_ARGS(interop.put()));
    if (FAILED(hr) || !interop) {
      FailAx(kCaptureFailed, false);
      return false;
    }
  }

  capture_ns::GraphicsCaptureItem item{nullptr};
  try {
    winrt::check_hresult(interop->CreateForMonitor(
        monitor.handle, winrt::guid_of<capture_ns::GraphicsCaptureItem>(), winrt::put_abi(item)));
  } catch (const winrt::hresult_error&) {
    FailAx(kCaptureFailed, false);  // WGC 拒绝（含更高完整性级别目标等，§10.7）
    return false;
  }
  if (!item) {
    FailAx(kCaptureFailed, false);
    return false;
  }

  // 帧池 + 会话（free-threaded：回调走线程池，worker 阻塞等待不自锁）。
  // 注：CreateFreeThreaded 需 Win10 1903+（18362）；17763–18361 区间此处抛 hresult →
  // capture_failed 诚实失败（§12.3 地板论证覆盖的 EOL 边际区间，spec 回写登记）。
  const winrt::Windows::Graphics::SizeInt32 itemSize = item.Size();
  if (itemSize.Width <= 0 || itemSize.Height <= 0) {
    FailAx(kCaptureFailed, false);
    return false;
  }
  auto arrival = std::make_shared<FrameArrivalState>();
  arrival->event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!arrival->event) {
    FailAx(kInternalNative, false);
    return false;
  }
  capture_ns::Direct3D11CaptureFramePool pool{nullptr};
  capture_ns::GraphicsCaptureSession session{nullptr};
  winrt::event_token arrivedToken{};
  bool gotFrame = false;
  try {
    pool = capture_ns::Direct3D11CaptureFramePool::CreateFreeThreaded(
        winrtDevice, directx_ns::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, itemSize);
    session = pool.CreateCaptureSession(item);
    arrivedToken = pool.FrameArrived(
        [arrival](capture_ns::Direct3D11CaptureFramePool const& sender,
                  winrt::Windows::Foundation::IInspectable const&) {
          std::lock_guard<std::mutex> lock(arrival->mutex);
          if (arrival->frame != nullptr) return;
          capture_ns::Direct3D11CaptureFrame arrivedFrame = sender.TryGetNextFrame();
          if (arrivedFrame) {
            arrival->frame = arrivedFrame;
            SetEvent(arrival->event);
          }
        });
    session.StartCapture();

    // 帧等待有界 5s + 取消切片（§10.6/§10.7）。
    const ULONGLONG deadline = GetTickCount64() + kFrameWaitTimeoutMs;
    for (;;) {
      {
        std::lock_guard<std::mutex> lock(arrival->mutex);
        if (arrival->frame != nullptr) {
          gotFrame = true;
          break;
        }
      }
      if (g_cancelRequested.load()) {
        FailAx(kCanceled, false);  // 只读观察被 stop 中断（driver 归类 Rejected）
        break;
      }
      if (GetTickCount64() >= deadline) {
        FailAx(kCaptureFailed, false);  // 超时 = capture_failed（只读，retry 安全，§10.7）
        break;
      }
      WaitForSingleObject(arrival->event, kFrameWaitSliceMs);
    }
  } catch (const winrt::hresult_error&) {
    FailAx(kCaptureFailed, false);
    gotFrame = false;
  }

  // 拆除顺序：撤回调 → 摘帧 → 关会话/帧池（in-flight 回调由 shared_ptr + mutex 保护）。
  if (pool && arrivedToken.value != 0) pool.FrameArrived(arrivedToken);
  capture_ns::Direct3D11CaptureFrame captured{nullptr};
  {
    std::lock_guard<std::mutex> lock(arrival->mutex);
    captured = arrival->frame;
    arrival->frame = nullptr;
  }
  if (session) session.Close();
  if (pool) pool.Close();
  if (!gotFrame || !captured) {
    if (!Failed()) FailAx(kCaptureFailed, false);
    return false;
  }

  // 帧 surface → staging texture → CPU BGRA 读回（全程同一 worker，§10.7）。
  try {
    // WGC 帧 surface 的 WinRT 包装不直接暴露 IDXGISurface（本机 26300 实测 QI =
    // E_NOINTERFACE）；规范通道是 IDirect3DDxgiInterfaceAccess::GetInterface
    // （windows.graphics.directx.direct3d11.interop.h 记载的官方互操作面；该接口在
    // 原始 ::Windows::Graphics::DirectX::Direct3D11 命名空间，非 winrt:: 投影空间）。
    const auto frameSurface = captured.Surface();
    winrt::com_ptr<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>
        surfaceAccess;
    hr = reinterpret_cast<::IUnknown*>(winrt::get_abi(frameSurface))
             ->QueryInterface(IID_PPV_ARGS(surfaceAccess.put()));
    if (FAILED(hr) || !surfaceAccess) {
      captured.Close();
      FailAx(kCaptureFailed, false);
      return false;
    }
    com_ptr<ID3D11Texture2D> texture;
    hr = surfaceAccess->GetInterface(IID_PPV_ARGS(texture.put()));
    if (FAILED(hr) || !texture) {
      captured.Close();
      FailAx(kCaptureFailed, false);
      return false;
    }
    D3D11_TEXTURE2D_DESC desc{};
    texture->GetDesc(&desc);
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.MiscFlags = 0;
    com_ptr<ID3D11Texture2D> staging;
    if (FAILED(device->CreateTexture2D(&desc, nullptr, staging.put()))) {
      captured.Close();
      FailAx(kCaptureFailed, false);
      return false;
    }
    context->CopyResource(staging.get(), texture.get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped))) {
      captured.Close();
      FailAx(kCaptureFailed, false);
      return false;
    }
    const int w = static_cast<int>(desc.Width);
    const int h = static_cast<int>(desc.Height);
    // PMv2 awareness 下 WGC 显示器栅格 = rcMonitor 物理像素；失配 = 环境异常，诚实失败。
    const int monitorW = monitor.rect.right - monitor.rect.left;
    const int monitorH = monitor.rect.bottom - monitor.rect.top;
    if (w != monitorW || h != monitorH || w <= 0 || h <= 0) {
      context->Unmap(staging.get(), 0);
      captured.Close();
      FailAx(kCaptureFailed, false);
      return false;
    }
    pixels.resize(static_cast<size_t>(w) * h * 4);
    for (int row = 0; row < h; row += 1) {
      memcpy(pixels.data() + static_cast<size_t>(row) * w * 4,
             static_cast<const uint8_t*>(mapped.pData) + static_cast<size_t>(row) * mapped.RowPitch,
             static_cast<size_t>(w) * 4);
    }
    context->Unmap(staging.get(), 0);
    width = w;
    height = h;
  } catch (const winrt::hresult_error&) {
    FailAx(kCaptureFailed, false);
    return false;
  }
  captured.Close();
  return true;
}

bool CaptureDisplayWorker::RunBudgetLadder(const std::vector<uint8_t>& pixels, int width,
                                           int height) {
  winrt::com_ptr<IWICImagingFactory> factory;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(factory.put())))) {
    FailAx(kCaptureFailed, false);
    return false;
  }

  const int longest = std::max(width, height);
  EncodedImage encoded;
  int currentDim = longest;  // 当前阶梯档的最长边

  // 档 1：最长边缩放至 ≤maxDimension → PNG。
  const int firstDim = std::min(longest, maxDimension_);
  if (!EncodeFrame(factory.get(), pixels, width, height, firstDim, false, 0.0f, encoded)) {
    FailAx(kCaptureFailed, false);
    return false;
  }
  currentDim = firstDim;
  if (Base64Fits(encoded.bytes.size(), budgetBytes_)) {
    CommitEncoded(encoded, width, height);
    return true;
  }
  // 档 2：1600 → 1280 → 1024 逐级重编 PNG（只对小于当前档的档位重编；从原始栅格缩放，
  // 不叠加重采样）。
  for (const int dim : {1600, 1280, 1024}) {
    if (dim >= currentDim) continue;
    EncodedImage step;
    if (!EncodeFrame(factory.get(), pixels, width, height, dim, false, 0.0f, step)) {
      FailAx(kCaptureFailed, false);
      return false;
    }
    currentDim = dim;
    encoded = std::move(step);
    if (Base64Fits(encoded.bytes.size(), budgetBytes_)) {
      CommitEncoded(encoded, width, height);
      return true;
    }
  }
  // 档 3：JPEG q80 → q60（同尺寸——几何不变，坐标投影仍成立，§10.7）。
  for (const float quality : {0.8f, 0.6f}) {
    EncodedImage step;
    if (!EncodeFrame(factory.get(), pixels, width, height, currentDim, true, quality, step)) {
      FailAx(kCaptureFailed, false);
      return false;
    }
    if (Base64Fits(step.bytes.size(), budgetBytes_)) {
      CommitEncoded(step, width, height);
      return true;
    }
  }
  // 阶梯穷尽 → budget_exceeded 诚实失败（绝不降质冒充、绝不 image_ref 落盘——§10.7/oQ9）。
  FailAx(kBudgetExceeded, false);
  return false;
}

// ── captureWindow（A2 桩，见文件头注释）──────────────────────────────────────
class CaptureWindowWorker final : public PromiseWorker {
 public:
  explicit CaptureWindowWorker(const Napi::Env& env) : PromiseWorker(env) {}

 protected:
  void Execute() override {
    // A2 无窗口注册表（A3 window_registry.cc）：任何 token 都不可解析 → target_changed
    // （wire → element_unavailable stale 字面量）。绝不拿裸数值当 HWND 猜测身份——
    // 窗口捕获的前后双复核（§10.7）以注册表身份快照为前提。
    FailAx(kTargetChanged, false);
  }
};

}  // namespace

Napi::Value CaptureDisplay(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsObject()) {
    return RejectedPromise(env, "captureDisplay requires a target object and a budget object");
  }
  const Napi::Object target = info[0].As<Napi::Object>();
  DisplayTarget parsed{};
  const bool hasMonitorIndex = target.Has("monitorIndex");
  const bool hasBounds = target.Has("bounds");
  if (hasMonitorIndex == hasBounds) {
    return RejectedPromise(env, "captureDisplay target must be {monitorIndex} xor {bounds}");
  }
  if (hasMonitorIndex) {
    if (!target.Get("monitorIndex").IsNumber()) {
      return RejectedPromise(env, "captureDisplay monitorIndex must be a number");
    }
    const double index = target.Get("monitorIndex").As<Napi::Number>().DoubleValue();
    if (!(index >= 0) || index != std::floor(index) || index > 64) {
      return RejectedPromise(env, "captureDisplay monitorIndex must be an integer >= 0");
    }
    parsed.byBounds = false;
    parsed.monitorIndex = static_cast<int>(index);
  } else {
    const Napi::Value boundsValue = target.Get("bounds");
    if (!boundsValue.IsObject()) {
      return RejectedPromise(env, "captureDisplay bounds must be an object");
    }
    const Napi::Object bounds = boundsValue.As<Napi::Object>();
    double values[4] = {0, 0, 0, 0};
    const char* keys[4] = {"x", "y", "width", "height"};
    for (int i = 0; i < 4; i += 1) {
      if (!bounds.Has(keys[i]) || !bounds.Get(keys[i]).IsNumber()) {
        return RejectedPromise(env, "captureDisplay bounds must carry finite x/y/width/height");
      }
      values[i] = bounds.Get(keys[i]).As<Napi::Number>().DoubleValue();
      if (!std::isfinite(values[i])) {
        return RejectedPromise(env, "captureDisplay bounds must carry finite x/y/width/height");
      }
    }
    if (values[2] <= 0 || values[3] <= 0) {
      return RejectedPromise(env, "captureDisplay bounds width/height must be > 0");
    }
    parsed.byBounds = true;
    parsed.bounds.left = static_cast<LONG>(std::floor(values[0]));
    parsed.bounds.top = static_cast<LONG>(std::floor(values[1]));
    parsed.bounds.right = parsed.bounds.left + static_cast<LONG>(std::ceil(values[2]));
    parsed.bounds.bottom = parsed.bounds.top + static_cast<LONG>(std::ceil(values[3]));
  }

  const Napi::Object budget = info[1].As<Napi::Object>();
  if (!budget.Has("maxDimension") || !budget.Get("maxDimension").IsNumber() ||
      !budget.Has("inlineBase64BudgetBytes") ||
      !budget.Get("inlineBase64BudgetBytes").IsNumber()) {
    return RejectedPromise(env,
                           "captureDisplay budget requires maxDimension and inlineBase64BudgetBytes");
  }
  const double maxDimension = budget.Get("maxDimension").As<Napi::Number>().DoubleValue();
  const double budgetBytes = budget.Get("inlineBase64BudgetBytes").As<Napi::Number>().DoubleValue();
  if (!(maxDimension >= 16) || maxDimension > 16384 || maxDimension != std::floor(maxDimension)) {
    return RejectedPromise(env, "captureDisplay maxDimension must be an integer in 16..16384");
  }
  if (!(budgetBytes >= 1024) || budgetBytes > 256.0 * 1024 * 1024 ||
      budgetBytes != std::floor(budgetBytes)) {
    return RejectedPromise(env, "captureDisplay inlineBase64BudgetBytes is out of range");
  }

  auto* worker = new CaptureDisplayWorker(env, parsed, static_cast<int>(maxDimension),
                                          static_cast<long long>(budgetBytes));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value CaptureWindow(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
    return RejectedPromise(env, "captureWindow requires a numeric windowToken and a budget object");
  }
  auto* worker = new CaptureWindowWorker(env);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

}  // namespace ax
