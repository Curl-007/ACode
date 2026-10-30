// ACode 原创（specs/windows-helper-producer.md §10.1/§10.7/§10.9）。
// 环境事实面：environmentProbe（交互桌面 / Session 0 / DPI awareness）、addon Init 期的
// 进程级 Per-Monitor-V2 尝试、线程级 PMv2 override 共用辅助。判据依据：
//   - 交互桌面 = 进程 window station 是 WinSta0 ∧ 当前 input desktop 是 Default
//     （锁屏时 input desktop 切到 Winlogon、Session 0 服务的 station 是 Service-0x…$——
//     两种非交互形态都被该双判据诚实拒绝，绝不带病派发，§10.9 preflight 门）；
//   - dpiAware = 探针 worker 的线程级 PMv2 复核（§10.7 R 裁决）：electron fork 宿主
//     manifest 预设非 PMv2 意识，进程级 Set 恒被拒、旧查询兜底恒判 false（产品链
//     永不可用的实证缺陷）；线程级 SetThreadDpiAwarenessContext(PMv2) 是该场景的
//     文档化 override 通道，复核失败 = 线程未达真 PMv2 → dpiAware=false → wire 层
//     preflight 拒绝（DPI 虚拟化会让 WGC bounds、UIA 矩形与 SendInput 归一化坐标
//     三者失配，绝不带病派发）。
#include "ax_internal.h"

#include <userenv.h>

#include <string>

namespace ax {
namespace {

// 查询 desktop/window station 的 UOI_NAME（失败返回 false；缓冲区按两阶段查询分配）。
bool QueryObjectName(HANDLE handle, std::wstring& out) {
  DWORD needed = 0;
  GetUserObjectInformationW(handle, UOI_NAME, nullptr, 0, &needed);
  if (needed == 0) return false;
  std::wstring buffer(needed / sizeof(wchar_t) + 2, L'\0');
  DWORD written = 0;
  if (!GetUserObjectInformationW(handle, UOI_NAME, buffer.data(),
                                 static_cast<DWORD>(buffer.size() * sizeof(wchar_t)), &written)) {
    return false;
  }
  out.assign(buffer.c_str());
  return !out.empty();
}

bool EqualsIgnoreCase(const std::wstring& left, const wchar_t* right) {
  return _wcsicmp(left.c_str(), right) == 0;
}

class EnvironmentProbeWorker final : public PromiseWorker {
 public:
  explicit EnvironmentProbeWorker(const Napi::Env& env) : PromiseWorker(env) {}

 protected:
  // 只读查询 + 探针线程的 PMv2 提升（override 是线程态事实，不改变其它线程/进程语义，
  // 与「probe 不缓存、每次实测」的 §10.9 纪律同律）；无取消面（瞬时完成）。
  void Execute() override {
    interactive_ = DetectInteractiveDesktop();
    sessionZero_ = DetectSessionZero();
    // 门禁事实源 = 线程级复核（§10.7 R 裁决）：不再读进程级全局——electron fork 下
    // 进程级 Set 恒被拒、旧全局恒 false 曾让产品链整体 fail-closed。
    dpiAware_ = EnsureThreadDpiPerMonitorV2();
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    result.Set("interactiveDesktop", Napi::Boolean::New(env, interactive_));
    result.Set("sessionZero", Napi::Boolean::New(env, sessionZero_));
    result.Set("dpiAware", Napi::Boolean::New(env, dpiAware_));
    return result;
  }

 private:
  bool interactive_ = false;
  bool sessionZero_ = false;
  bool dpiAware_ = false;
};

}  // namespace

bool DetectInteractiveDesktop() {
  // 判据一：进程 window station 必须是交互站 WinSta0（Session 0 服务是 Service-0x…$）。
  HWINSTA station = GetProcessWindowStation();
  if (!station) return false;
  std::wstring stationName;
  if (!QueryObjectName(station, stationName) || !EqualsIgnoreCase(stationName, L"WinSta0")) {
    return false;
  }
  // 判据二：当前 input desktop 必须是 Default（锁屏时为 Winlogon；OpenInputDesktop
  // 在非交互场景通常直接失败——两个形态都判非交互，fail-closed 方向）。
  HDESK input = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!input) return false;
  std::wstring desktopName;
  const bool ok = QueryObjectName(input, desktopName) && EqualsIgnoreCase(desktopName, L"Default");
  CloseDesktop(input);
  return ok;
}

bool DetectSessionZero() {
  DWORD sessionId = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &sessionId)) return false;
  return sessionId == 0;
}

void InitializeProcessDpi() {
  // 地板 17763 > 1703 保证 SetProcessDpiAwarenessContext API 存在（§10.7）。
  // 进程级 Set 是 plain node 形态的最优路径：成功后进程默认意识即 PMv2，此后创建的
  // 全部线程缺省 PMv2，触点 worker 的线程复核恒快路径通过。electron fork 下 manifest
  // 已预设非 PMv2 意识 → 本调用被拒（ERROR_ACCESS_DENIED）属预期形态，不再据以判定
  // 门禁——门禁归触点线程级复核（§10.7 R 裁决），故成败均可忽略返回值。
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
}

bool EnsureThreadDpiPerMonitorV2() {
  // 线程级 PMv2 override（§10.7 R 裁决）：manifest 预设意识后进程级 Set 被拒是文档化
  // 行为，线程级 Set 不受其限（地板 17763 > 14393 保证同族 API 存在，spec 地板核对）。
  SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  // 复核而非信任 Set 返回（旧上下文句柄不证明新状态；旧回退分支的 PMv2 比较语义由本
  // 复核承载）：当前线程上下文必须真 PMv2，否则诚实报 false → 调用方 fail-closed。
  DPI_AWARENESS_CONTEXT current = GetThreadDpiAwarenessContext();
  return current &&
         AreDpiAwarenessContextsEqual(current, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
}

Napi::Value EnvironmentProbe(const Napi::CallbackInfo& info) {
  auto* worker = new EnvironmentProbeWorker(info.Env());
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

}  // namespace ax
