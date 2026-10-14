// ACode 原创（specs/windows-helper-producer.md §10.1/§10.7/§10.9）。
// 环境事实面：environmentProbe（交互桌面 / Session 0 / DPI awareness）与 addon Init 期的
// Per-Monitor-V2 DPI 设置。判据依据：
//   - 交互桌面 = 进程 window station 是 WinSta0 ∧ 当前 input desktop 是 Default
//     （锁屏时 input desktop 切到 Winlogon、Session 0 服务的 station 是 Service-0x…$——
//     两种非交互形态都被该双判据诚实拒绝，绝不带病派发，§10.9 preflight 门）；
//   - dpiAware = SetProcessDpiAwarenessContext(PMv2) 成功，或进程清单已是 PMv2
//     （Electron 宿主 manifest 已带 PMv2 → Set 失败但查询判定为真；裸 node 是 unaware →
//     Set 成功。DPI 虚拟化会让 WGC bounds、UIA 矩形与 SendInput 归一化坐标三者失配，
//     故失败时 environmentProbe.dpiAware=false → wire 层 preflight 拒绝，§10.7）。
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
  // 只读查询，零副作用；无取消面（瞬时完成）。
  void Execute() override {
    interactive_ = DetectInteractiveDesktop();
    sessionZero_ = DetectSessionZero();
    dpiAware_ = g_dpiAware.load();
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
  if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
    g_dpiAware.store(true);
    return;
  }
  // Set 失败的合法形态：进程 manifest 已声明 PMv2（Electron 宿主 fork 的 node 模式）——
  // 查询当前上下文，已是 PMv2 即视为达标；其余（unaware/system-aware）诚实报 false。
  DPI_AWARENESS_CONTEXT current = GetThreadDpiAwarenessContext();
  const bool already = current &&
                       AreDpiAwarenessContextsEqual(current, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  g_dpiAware.store(already);
}

Napi::Value EnvironmentProbe(const Napi::CallbackInfo& info) {
  auto* worker = new EnvironmentProbeWorker(info.Env());
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

}  // namespace ax
