// ACode 原创（specs/windows-helper-producer.md §10.1/§10.3/§10.4）。
// A2 native 面的跨编译单元共享设施：
//   - 全局取消旗标（§10.1 cancelOperations / §10.6 stop 中断语义）；
//   - held-input 注册表（§10.4 规则 3：native 层是被按下鼠标键/按住键的唯一事实源，
//     一切退出路径先幂等释放再 exit）；
//   - 类型化错误通道（§10.3 封闭 code 集 + dispatchStarted 二分判据——driver 侧据此
//     归类 NativeRejectedError（确定未产生副作用）/ NativeAmbiguousError（派发已启动、
//     结果不可证））；
//   - Promise AsyncWorker 基类（决策一「N-API 异步 Promise」；PNG/注入/剪贴板全部在
//     worker 线程执行，V8 主线程绝不阻塞，§10.10）。
// 纪律：错误对象只携带封闭 code 字面量与布尔事实，绝不插值窗口标题/文本内容/路径
// （§3.2 零插值红线在 native 侧的同律落实）。
#pragma once

#include <napi.h>
#include <windows.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace ax {

// ── 全局取消旗标（§10.1：cancelOperations 同步置旗；在途循环 ≤500ms 内检查并退出）──
// 语义钉死：cancelOperations 只作用于「当前正在 Execute 的操作」——每个派发类 worker 在
// Execute 入口清零旗标，故 stop 之后受理的新动作正常执行（§10.6「stop 非会话闩锁」）。
// JS 侧 admission 串行（并发=1）+ stop 先阻断出队再置旗，排除「置旗与清零竞态吃掉取消」
// 的窗口（input-session.ts 的 stop 编排注释）。
inline std::atomic<bool> g_cancelRequested{false};

// ── DPI awareness 事实（§10.7）：addon Init 设 Per-Monitor-V2，environmentProbe 回读 ──
inline std::atomic<bool> g_dpiAware{false};

// ── 类型化错误 code 封闭集（§10.3；实现不得新增，新增先改 spec）──
constexpr const char* kForegroundLost = "foreground_lost";
constexpr const char* kNonInteractiveDesktop = "non_interactive_desktop";
constexpr const char* kTargetChanged = "target_changed";
constexpr const char* kCaptureMinimized = "capture_minimized";
constexpr const char* kCaptureFailed = "capture_failed";
constexpr const char* kBudgetExceeded = "budget_exceeded";
constexpr const char* kClipboardBusy = "clipboard_busy";
constexpr const char* kClipboardDenied = "clipboard_denied";
constexpr const char* kInjectionRejected = "injection_rejected";
constexpr const char* kCanceled = "canceled";
constexpr const char* kInternalNative = "internal_native";

// ── held-input 注册表（§10.4 规则 3；鼠标键名 + VK 码）──
inline std::mutex g_heldMutex;
inline std::set<std::string> g_heldButtons;  // "left" / "right" / "middle"
inline std::set<int> g_heldKeys;             // Win32 VK 码

struct HeldSnapshot {
  std::vector<std::string> buttons;
  std::vector<int> keys;
};

// 注册/注销（注入成功后调用；锁内 O(log n)）。
inline void RegisterHeldButton(const std::string& name) {
  std::lock_guard<std::mutex> lock(g_heldMutex);
  g_heldButtons.insert(name);
}
inline void UnregisterHeldButton(const std::string& name) {
  std::lock_guard<std::mutex> lock(g_heldMutex);
  g_heldButtons.erase(name);
}
inline void RegisterHeldKey(int vk) {
  std::lock_guard<std::mutex> lock(g_heldMutex);
  g_heldKeys.insert(vk);
}
inline void UnregisterHeldKey(int vk) {
  std::lock_guard<std::mutex> lock(g_heldMutex);
  g_heldKeys.erase(vk);
}

// Win32 注入原语（pointer.cc / keyboard.cc / 释放路径共用）。
DWORD MouseFlagForButton(const std::string& name, bool down);  // pointer.cc
bool InjectMouseUpDown(DWORD flag, int x = 0, int y = 0);      // pointer.cc：单事件注入
bool InjectKeyUp(int vk);                                      // keyboard.cc：单事件注入

// held 快照与同步释放（foreground.cc 实现；释放不做前台校验——cleanup 语义，§10.1 注记 2）。
HeldSnapshot SnapshotHeld();
// 幂等释放全部 held（清空注册表后注入 UP 序列），返回 SendInput 实际插入的 UP 事件数。
size_t ReleaseHeldInputsNow();

// 派发瞬间前台校验（foreground.cc；§10.4 规则 1——校验与注入必须同一 native 调用内，
// JS 层校验跨调用 TOCTOU 不可接受）。A2 已知限制（规则 2）：ApplicationFrameHost.exe
// 承载的 packaged app 无 AUMID 修正面（A3 收口），此类目标诚实报 foreground_lost
// （fail-closed 方向）。
bool IsExpectedForeground(DWORD expectedPid);

// 交互桌面事实（environment.cc；§10.9 统一 preflight 门的 native 判据）。
bool DetectInteractiveDesktop();
bool DetectSessionZero();
void InitializeProcessDpi();

// ── Promise AsyncWorker 基类：类型化错误通道（code + dispatchStarted）──
// Execute 覆写体必须自行捕获全部异常（含 C++/WinRT hresult_error）并调 FailAx(code,
// dispatchStarted)，绝不向 AsyncWorker 框架抛——保证错误形态恒为封闭 code（§10.3），
// 不把底层系统文本带上 JS 面（§3.2）。错误 message = code 字面量本身（零插值）。
class PromiseWorker : public Napi::AsyncWorker {
 public:
  explicit PromiseWorker(const Napi::Env& env)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() const { return deferred_.Promise(); }

 protected:
  // 子类在 Execute 内标记失败（不调用 Reject——线程约束，On* 回调在主线程执行）。
  // SetError 是路由关键：AsyncWorker 框架按「errorMessage 非空」决定走 OnError 而非
  // OnOK——只记 code 不 SetError 会让失败被当成功 resolve（实现期实测踩中并修复）。
  void FailAx(const char* code, bool dispatchStarted = false) {
    if (errorCode_.empty()) {
      errorCode_ = code;
      SetError(code);
    }
    dispatchStarted_ = dispatchStarted_ || dispatchStarted;
  }
  bool Failed() const { return !errorCode_.empty(); }

  // 成功结果构造（主线程调用；缺省 resolve undefined——void 语义导出）。
  virtual Napi::Value BuildResult(const Napi::Env& env) { return env.Undefined(); }

  void OnOK() override { deferred_.Resolve(BuildResult(Env())); }

  void OnError(const Napi::Error& /*defaultError*/) override {
    const Napi::Env env = Env();
    const char* code = errorCode_.empty() ? kInternalNative : errorCode_.c_str();
    Napi::Object errorObject = Napi::Error::New(env, code).Value();
    errorObject.Set("code", Napi::String::New(env, code));
    // dispatchStarted = §10.3 二分判据的 native 侧事实源：true ⇒ driver 归类
    // NativeAmbiguousError（派发已启动、结果不可证 → possibly_sent 收据，禁止 ok:false）。
    errorObject.Set("dispatchStarted", Napi::Boolean::New(env, dispatchStarted_));
    deferred_.Reject(errorObject);
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::string errorCode_;
  bool dispatchStarted_ = false;
};

// 立即拒绝的 Deferred 帮助函数（参数校验类失败：同步判定、零派发——JS 面得到 rejected
// Promise 而非同步 throw，保持「除 probe/cancelOperations 外全部返回 Promise」的签名契约）。
inline Napi::Promise RejectedPromise(const Napi::Env& env, const char* message) {
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
  deferred.Reject(Napi::TypeError::New(env, message).Value());
  return deferred.Promise();
}

// 各编译单元的导出注册入口（addon.cc Init 汇总）。
Napi::Value EnvironmentProbe(const Napi::CallbackInfo& info);      // environment.cc
Napi::Value ForegroundPid(const Napi::CallbackInfo& info);         // foreground.cc
Napi::Value HeldInputSnapshot(const Napi::CallbackInfo& info);     // foreground.cc
Napi::Value AsyncKeyState(const Napi::CallbackInfo& info);         // foreground.cc
Napi::Value CursorPosition(const Napi::CallbackInfo& info);        // foreground.cc
Napi::Value ProcessExecutablePath(const Napi::CallbackInfo& info); // foreground.cc
Napi::Value ReleaseAllHeldInputs(const Napi::CallbackInfo& info);  // foreground.cc
Napi::Value MoveTo(const Napi::CallbackInfo& info);                // pointer.cc
Napi::Value ScrollAt(const Napi::CallbackInfo& info);              // pointer.cc
Napi::Value Drag(const Napi::CallbackInfo& info);                  // pointer.cc
Napi::Value MouseDown(const Napi::CallbackInfo& info);             // pointer.cc
Napi::Value MouseUp(const Napi::CallbackInfo& info);               // pointer.cc
Napi::Value SendText(const Napi::CallbackInfo& info);              // keyboard.cc
Napi::Value PressKeys(const Napi::CallbackInfo& info);             // keyboard.cc
Napi::Value ClipboardWriteText(const Napi::CallbackInfo& info);    // clipboard.cc
Napi::Value CaptureDisplay(const Napi::CallbackInfo& info);        // capture.cc
Napi::Value CaptureWindow(const Napi::CallbackInfo& info);         // capture.cc

}  // namespace ax
