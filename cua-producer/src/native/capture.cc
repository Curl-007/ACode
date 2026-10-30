// ACode 原创（specs/windows-helper-producer.md §10.1/§10.7/§11）。
// WGC 截图面：captureDisplay（显示器按 HMONITOR）+ captureWindow（窗口按注册表 token）。
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
//   ≤inlineBase64BudgetBytes(200 KiB)？否 → 最长边 1600→1280→1024 逐级重编 →
//   仍超 → JPEG q80→q60（同尺寸，有损但几何不变——坐标投影仍成立）→ 仍超 →
//   budget_exceeded 诚实失败。
//
// captureWindow（A3 实装；A2 曾是恒 target_changed 的诚实桩）：windowToken 经
// window_registry 解析（IsWindow + 宿主 pid 复验，失效 → target_changed =「observation
// state is stale」语义）；捕获前后双复核（HWND 存活 + pid + canonical exe + bounds，
// §10.7）不一致 → target_changed；IsIconic 为真后才判定最小化 → capture_minimized。
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
// 每次捕获顺带产出（CaptureResult.topologyFingerprint，spec §10.1 回写登记）——无常驻
// 监听面，frame-registry 的拓扑换代判定以捕获时指纹为准。
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
                                     WICBitmapDitherTypeNone, nullptr, 0,
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

// ── 共享捕获管线（A3 重构抽出：display 与 window 两路复用，A2 行为逐项保持）────────
struct CaptureDeviceSet {
  winrt::com_ptr<ID3D11Device> device;
  winrt::com_ptr<ID3D11DeviceContext> context;
  directx_ns::Direct3D11::IDirect3DDevice winrtDevice{nullptr};
  winrt::com_ptr<IGraphicsCaptureItemInterop> interop;
};

// D3D11 设备（硬件优先，WARP 兜底——虚拟机/无硬件适配器场景仍是 WGC 合法管线，不是
// 「空白像素 fallback」；两条驱动路径都失败才 capture_failed）+ WinRT 设备 + interop 工厂。
bool CreateCaptureDevices(CaptureDeviceSet& out) {
  const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, nullptr, 0,
                                 D3D11_SDK_VERSION, out.device.put(), nullptr, out.context.put());
  if (FAILED(hr)) {
    out.device = nullptr;
    out.context = nullptr;
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags, nullptr, 0,
                           D3D11_SDK_VERSION, out.device.put(), nullptr, out.context.put());
  }
  if (FAILED(hr)) return false;

  winrt::com_ptr<IDXGIDevice> dxgiDevice;
  if (FAILED(out.device->QueryInterface(IID_PPV_ARGS(dxgiDevice.put())))) return false;
  winrt::com_ptr<::IInspectable> inspectable;
  if (FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.get(), inspectable.put()))) {
    return false;
  }
  out.winrtDevice = inspectable.as<directx_ns::Direct3D11::IDirect3DDevice>();

  if (!capture_ns::GraphicsCaptureSession::IsSupported()) return false;  // WGC 不可用（策略禁用等）

  // IGraphicsCaptureItemInterop（WinRT 激活工厂 QI；保守形态：get_abi + QueryInterface）。
  const auto activationFactory = winrt::get_activation_factory<capture_ns::GraphicsCaptureItem>();
  hr = reinterpret_cast<::IUnknown*>(winrt::get_abi(activationFactory))
           ->QueryInterface(IID_PPV_ARGS(out.interop.put()));
  return SUCCEEDED(hr) && out.interop;
}

// item → 帧池（free-threaded）→ 会话 → 有界 5s 等待（取消切片 ≤50ms）→ staging 读回 BGRA。
// 失败时 *failCode 置封闭码（kCanceled/kCaptureFailed/kInternalNative）。
bool CaptureItemPixels(const CaptureDeviceSet& devices, const capture_ns::GraphicsCaptureItem& item,
                       std::vector<uint8_t>& pixels, int& width, int& height,
                       const char** failCode) {
  *failCode = kCaptureFailed;
  const winrt::Windows::Graphics::SizeInt32 itemSize = item.Size();
  if (itemSize.Width <= 0 || itemSize.Height <= 0) return false;
  auto arrival = std::make_shared<FrameArrivalState>();
  arrival->event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!arrival->event) {
    *failCode = kInternalNative;
    return false;
  }
  capture_ns::Direct3D11CaptureFramePool pool{nullptr};
  capture_ns::GraphicsCaptureSession session{nullptr};
  winrt::event_token arrivedToken{};
  bool gotFrame = false;
  try {
    pool = capture_ns::Direct3D11CaptureFramePool::CreateFreeThreaded(
        devices.winrtDevice, directx_ns::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, itemSize);
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
        *failCode = kCanceled;  // 只读观察被 stop 中断（driver 归类 Rejected）
        break;
      }
      if (GetTickCount64() >= deadline) {
        *failCode = kCaptureFailed;  // 超时 = capture_failed（只读，retry 安全，§10.7）
        break;
      }
      WaitForSingleObject(arrival->event, kFrameWaitSliceMs);
    }
  } catch (const winrt::hresult_error&) {
    *failCode = kCaptureFailed;
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
  if (!gotFrame || !captured) return false;

  // 帧 surface → staging texture → CPU BGRA 读回（全程同一 worker，§10.7）。
  try {
    // WGC 帧 surface 的 WinRT 包装不直接暴露 IDXGISurface（本机 26300 实测 QI =
    // E_NOINTERFACE）；规范通道是 IDirect3DDxgiInterfaceAccess::GetInterface
    //（windows.graphics.directx.direct3d11.interop.h 记载的官方互操作面；该接口在
    // 原始 ::Windows::Graphics::DirectX::Direct3D11 命名空间，非 winrt:: 投影空间）。
    const auto frameSurface = captured.Surface();
    winrt::com_ptr<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>
        surfaceAccess;
    HRESULT hr = reinterpret_cast<::IUnknown*>(winrt::get_abi(frameSurface))
                     ->QueryInterface(IID_PPV_ARGS(surfaceAccess.put()));
    if (FAILED(hr) || !surfaceAccess) {
      captured.Close();
      return false;
    }
    winrt::com_ptr<ID3D11Texture2D> texture;
    hr = surfaceAccess->GetInterface(IID_PPV_ARGS(texture.put()));
    if (FAILED(hr) || !texture) {
      captured.Close();
      return false;
    }
    D3D11_TEXTURE2D_DESC desc{};
    texture->GetDesc(&desc);
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.MiscFlags = 0;
    winrt::com_ptr<ID3D11Texture2D> staging;
    if (FAILED(devices.device->CreateTexture2D(&desc, nullptr, staging.put()))) {
      captured.Close();
      return false;
    }
    devices.context->CopyResource(staging.get(), texture.get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(devices.context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped))) {
      captured.Close();
      return false;
    }
    const int w = static_cast<int>(desc.Width);
    const int h = static_cast<int>(desc.Height);
    pixels.resize(static_cast<size_t>(w) * h * 4);
    for (int row = 0; row < h; row += 1) {
      memcpy(pixels.data() + static_cast<size_t>(row) * w * 4,
             static_cast<const uint8_t*>(mapped.pData) + static_cast<size_t>(row) * mapped.RowPitch,
             static_cast<size_t>(w) * 4);
    }
    devices.context->Unmap(staging.get(), 0);
    width = w;
    height = h;
  } catch (const winrt::hresult_error&) {
    captured.Close();
    return false;
  }
  captured.Close();
  return true;
}

// 预算阶梯（§10.7 钉死；A3 重构抽出为共享静态——display/window 两路同一阶梯）。
enum class LadderOutcome { ok, encode_failed, exceeded };

LadderOutcome RunBudgetLadderShared(const std::vector<uint8_t>& pixels, int width, int height,
                                    int maxDimension, long long budgetBytes, EncodedImage& encoded) {
  winrt::com_ptr<IWICImagingFactory> factory;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(factory.put())))) {
    return LadderOutcome::encode_failed;
  }

  const int longest = std::max(width, height);
  int currentDim = std::min(longest, maxDimension);  // 档 1：最长边缩放至 ≤maxDimension → PNG

  EncodedImage step;
  if (!EncodeFrame(factory.get(), pixels, width, height, currentDim, false, 0.0f, step)) {
    return LadderOutcome::encode_failed;
  }
  if (Base64Fits(step.bytes.size(), budgetBytes)) {
    encoded = std::move(step);
    return LadderOutcome::ok;
  }
  // 档 2：1600 → 1280 → 1024 逐级重编 PNG（只对小于当前档的档位重编；从原始栅格缩放，
  // 不叠加重采样）。
  for (const int dim : {1600, 1280, 1024}) {
    if (dim >= currentDim) continue;
    EncodedImage candidate;
    if (!EncodeFrame(factory.get(), pixels, width, height, dim, false, 0.0f, candidate)) {
      return LadderOutcome::encode_failed;
    }
    currentDim = dim;
    step = std::move(candidate);
    if (Base64Fits(step.bytes.size(), budgetBytes)) {
      encoded = std::move(step);
      return LadderOutcome::ok;
    }
  }
  // 档 3：JPEG q80 → q60（同尺寸——几何不变，坐标投影仍成立，§10.7）。
  for (const float quality : {0.8f, 0.6f}) {
    EncodedImage candidate;
    if (!EncodeFrame(factory.get(), pixels, width, height, currentDim, true, quality, candidate)) {
      return LadderOutcome::encode_failed;
    }
    step = std::move(candidate);
    if (Base64Fits(step.bytes.size(), budgetBytes)) {
      encoded = std::move(step);
      return LadderOutcome::ok;
    }
  }
  // 阶梯穷尽 → budget_exceeded 诚实失败（绝不降质冒充、绝不 image_ref 落盘——§10.7/oQ9）。
  return LadderOutcome::exceeded;
}

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
  // 固定失败关闭——DPI 虚拟化会让 bounds 与栅格失配，绝不带病捕获。DPI 判据 = 本 worker
  // 线程的 PMv2 override 复核（§10.7 R 裁决：electron fork 下进程级 Set 恒被拒，门禁
  // 归线程级）。
  if (!DetectInteractiveDesktop() || DetectSessionZero() || !EnsureThreadDpiPerMonitorV2()) {
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

  CaptureDeviceSet devices;
  if (!CreateCaptureDevices(devices)) {
    FailAx(kCaptureFailed, false);
    return;
  }
  capture_ns::GraphicsCaptureItem item{nullptr};
  try {
    winrt::check_hresult(devices.interop->CreateForMonitor(
        chosen->handle, winrt::guid_of<capture_ns::GraphicsCaptureItem>(), winrt::put_abi(item)));
  } catch (const winrt::hresult_error&) {
    FailAx(kCaptureFailed, false);  // WGC 拒绝（含更高完整性级别目标等，§10.7）
    return;
  }
  if (!item) {
    FailAx(kCaptureFailed, false);
    return;
  }

  std::vector<uint8_t> pixels;
  int capturedWidth = 0;
  int capturedHeight = 0;
  const char* failCode = kCaptureFailed;
  if (!CaptureItemPixels(devices, item, pixels, capturedWidth, capturedHeight, &failCode)) {
    FailAx(failCode, false);
    return;
  }
  // PMv2 awareness 下 WGC 显示器栅格 = rcMonitor 物理像素；失配 = 环境异常，诚实失败。
  const int monitorW = chosen->rect.right - chosen->rect.left;
  const int monitorH = chosen->rect.bottom - chosen->rect.top;
  if (capturedWidth != monitorW || capturedHeight != monitorH || capturedWidth <= 0 ||
      capturedHeight <= 0) {
    FailAx(kCaptureFailed, false);
    return;
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
             pixels.data() + static_cast<size_t>((cropY + row) * capturedWidth + cropX) * 4,
             static_cast<size_t>(cropW) * 4);
    }
    pixels = std::move(cropped);
    capturedWidth = cropW;
    capturedHeight = cropH;
  }
  boundsRect_ = crop;

  EncodedImage encoded;
  const LadderOutcome ladder =
      RunBudgetLadderShared(pixels, capturedWidth, capturedHeight, maxDimension_, budgetBytes_,
                            encoded);
  if (ladder == LadderOutcome::encode_failed) {
    FailAx(kCaptureFailed, false);
    return;
  }
  if (ladder == LadderOutcome::exceeded) {
    FailAx(kBudgetExceeded, false);
    return;
  }
  image_ = std::move(encoded.bytes);
  jpeg_ = encoded.jpeg;
  width_ = encoded.width;
  height_ = encoded.height;
  scaled_ = (encoded.width != capturedWidth || encoded.height != capturedHeight);
}

// ── captureWindow worker（A3 实装；token → window_registry，前后双复核 §10.7）──────
class CaptureWindowWorker final : public PromiseWorker {
 public:
  CaptureWindowWorker(const Napi::Env& env, uint32_t token, int maxDimension, long long budgetBytes)
      : PromiseWorker(env), token_(token), maxDimension_(maxDimension), budgetBytes_(budgetBytes) {}

 protected:
  void Execute() override;

  Napi::Value BuildResult(const Napi::Env& env) override {
    // 与 captureDisplay 同构的 CaptureResult（driver-contract.ts）。
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
    result.Set("budgetFit", Napi::Boolean::New(env, true));
    result.Set("topologyFingerprint", Napi::String::New(env, topologyFingerprint_));
    return result;
  }

 private:
  uint32_t token_;
  int maxDimension_;
  long long budgetBytes_;
  std::vector<uint8_t> image_;
  bool jpeg_ = false;
  int width_ = 0;
  int height_ = 0;
  RECT boundsRect_{};
  bool scaled_ = false;
  std::string topologyFingerprint_;
};

void CaptureWindowWorker::Execute() {
  g_cancelRequested.store(false);
  // DPI 判据 = 线程级 PMv2 复核（§10.7 R 裁决，与 CaptureDisplayWorker 同律）。
  if (!DetectInteractiveDesktop() || DetectSessionZero() || !EnsureThreadDpiPerMonitorV2()) {
    FailAx(kNonInteractiveDesktop, false);
    return;
  }

  // token 解析（§11.5：IsWindow + 宿主 pid 复验；失效 → target_changed =「observation
  // state is stale」语义——绝不拿裸数值当 HWND 猜测身份）。
  WindowIdentity identity;
  if (!ResolveWindowToken(token_, identity)) {
    FailAx(kTargetChanged, false);
    return;
  }
  // 最小化判定（§10.7：IsIconic 为真后才判定——不得用「信号已消费」代替 Win32 状态事实）。
  if (IsIconic(identity.hwnd)) {
    FailAx(kCaptureMinimized, false);
    return;
  }
  // 前置身份复核：canonical exe 与注册时快照一致（进程替换/HWND 复用 → target_changed）。
  const std::wstring exeNow = QueryProcessExePath(identity.pid);
  if (exeNow.empty() || exeNow != identity.exePath) {
    FailAx(kTargetChanged, false);
    return;
  }
  RECT before{};
  if (!GetWindowRect(identity.hwnd, &before)) {
    FailAx(kTargetChanged, false);
    return;
  }

  MtaApartment apartment;
  if (!apartment.valid) {
    FailAx(kCaptureFailed, false);
    return;
  }
  const std::vector<MonitorEntry> monitors = EnumerateMonitors();
  if (monitors.empty()) {
    FailAx(kCaptureFailed, false);
    return;
  }
  topologyFingerprint_ = MonitorsFingerprint(monitors);

  CaptureDeviceSet devices;
  if (!CreateCaptureDevices(devices)) {
    FailAx(kCaptureFailed, false);
    return;
  }
  capture_ns::GraphicsCaptureItem item{nullptr};
  try {
    winrt::check_hresult(devices.interop->CreateForWindow(
        identity.hwnd, winrt::guid_of<capture_ns::GraphicsCaptureItem>(), winrt::put_abi(item)));
  } catch (const winrt::hresult_error&) {
    FailAx(kCaptureFailed, false);  // WGC 拒绝（含更高完整性级别目标）
    return;
  }
  if (!item) {
    FailAx(kCaptureFailed, false);
    return;
  }

  std::vector<uint8_t> pixels;
  int capturedWidth = 0;
  int capturedHeight = 0;
  const char* failCode = kCaptureFailed;
  if (!CaptureItemPixels(devices, item, pixels, capturedWidth, capturedHeight, &failCode)) {
    FailAx(failCode, false);
    return;
  }

  // 后置复核（§10.7 前后双复核）：HWND 存活 + pid + canonical exe + bounds 全一致；
  // 不一致 → target_changed（捕获到的是「另一个窗口状态」，坐标投影不可信）。
  if (!IsWindow(identity.hwnd)) {
    FailAx(kTargetChanged, false);
    return;
  }
  DWORD pidAfter = 0;
  GetWindowThreadProcessId(identity.hwnd, &pidAfter);
  RECT after{};
  if (pidAfter != identity.pid || !GetWindowRect(identity.hwnd, &after) ||
      after.left != before.left || after.top != before.top || after.right != before.right ||
      after.bottom != before.bottom) {
    FailAx(kTargetChanged, false);
    return;
  }
  const std::wstring exeAfter = QueryProcessExePath(identity.pid);
  if (exeAfter != identity.exePath) {
    FailAx(kTargetChanged, false);
    return;
  }
  boundsRect_ = before;  // 全链一致虚拟桌面物理像素（§10.7）

  EncodedImage encoded;
  const LadderOutcome ladder =
      RunBudgetLadderShared(pixels, capturedWidth, capturedHeight, maxDimension_, budgetBytes_,
                            encoded);
  if (ladder == LadderOutcome::encode_failed) {
    FailAx(kCaptureFailed, false);
    return;
  }
  if (ladder == LadderOutcome::exceeded) {
    FailAx(kBudgetExceeded, false);
    return;
  }
  image_ = std::move(encoded.bytes);
  jpeg_ = encoded.jpeg;
  width_ = encoded.width;
  height_ = encoded.height;
  scaled_ = (encoded.width != capturedWidth || encoded.height != capturedHeight);
}

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
      !budget.Has("inlineBase64BudgetBytes") || !budget.Get("inlineBase64BudgetBytes").IsNumber()) {
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
  const double token = info[0].As<Napi::Number>().DoubleValue();
  if (!(token >= 1) || token > 0xFFFFFFFF || token != std::floor(token)) {
    return RejectedPromise(env, "captureWindow windowToken must be a positive integer");
  }
  const Napi::Object budget = info[1].As<Napi::Object>();
  if (!budget.Has("maxDimension") || !budget.Get("maxDimension").IsNumber() ||
      !budget.Has("inlineBase64BudgetBytes") || !budget.Get("inlineBase64BudgetBytes").IsNumber()) {
    return RejectedPromise(env,
                           "captureWindow budget requires maxDimension and inlineBase64BudgetBytes");
  }
  const double maxDimension = budget.Get("maxDimension").As<Napi::Number>().DoubleValue();
  const double budgetBytes = budget.Get("inlineBase64BudgetBytes").As<Napi::Number>().DoubleValue();
  if (!(maxDimension >= 16) || maxDimension > 16384 || maxDimension != std::floor(maxDimension)) {
    return RejectedPromise(env, "captureWindow maxDimension must be an integer in 16..16384");
  }
  if (!(budgetBytes >= 1024) || budgetBytes > 256.0 * 1024 * 1024 ||
      budgetBytes != std::floor(budgetBytes)) {
    return RejectedPromise(env, "captureWindow inlineBase64BudgetBytes is out of range");
  }
  auto* worker = new CaptureWindowWorker(env, static_cast<uint32_t>(token),
                                         static_cast<int>(maxDimension),
                                         static_cast<long long>(budgetBytes));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

}  // namespace ax
