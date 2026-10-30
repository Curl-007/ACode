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
#include <functional>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

// UIA COM 接口前置声明——必须在全局作用域（namespace ax 内声明会被视为 ax 的成员类型，
// 遮蔽 ::IUIAutomationElement 真身导致「未定义类型」编译错，A3 实现期实测踩中）。
struct IUIAutomation;
struct IUIAutomationElement;

namespace ax {

// ── 全局取消旗标（§10.1：cancelOperations 同步置旗；在途循环 ≤500ms 内检查并退出）──
// 语义钉死：cancelOperations 只作用于「当前正在 Execute 的操作」——每个派发类 worker 在
// Execute 入口清零旗标，故 stop 之后受理的新动作正常执行（§10.6「stop 非会话闩锁」）。
// JS 侧 admission 串行（并发=1）+ stop 先阻断出队再置旗，排除「置旗与清零竞态吃掉取消」
// 的窗口（input-session.ts 的 stop 编排注释）。
inline std::atomic<bool> g_cancelRequested{false};

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
// A3 码位（§10.3 封闭集预留行；实现不得新增，新增先改 spec）。
constexpr const char* kUiaTimeout = "uia_timeout";
constexpr const char* kStale = "stale";
constexpr const char* kNotSettable = "not_settable";
constexpr const char* kNotSelectable = "not_selectable";
constexpr const char* kActionUnavailable = "action_unavailable";

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
// 线程级 PMv2 override（environment.cc；§10.7 R 裁决）：manifest 抢占宿主（electron
// fork）下进程级 Set 恒被拒，坐标/栅格触点 worker 的 Execute 前奏以此把当前线程提升为
// 真 PMv2 并复核；false = 本线程未达 PMv2 → 调用方按既有 fail-closed 码收口。
bool EnsureThreadDpiPerMonitorV2();

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
Napi::Value ListApplications(const Napi::CallbackInfo& info);      // uia_tree.cc
Napi::Value ListWindows(const Napi::CallbackInfo& info);           // uia_tree.cc
Napi::Value CaptureUiTree(const Napi::CallbackInfo& info);         // uia_tree.cc
Napi::Value ReleaseStateToken(const Napi::CallbackInfo& info);     // uia_tree.cc
Napi::Value UiaWorkerStats(const Napi::CallbackInfo& info);        // uia_tree.cc
Napi::Value ElementSetValue(const Napi::CallbackInfo& info);       // uia_patterns.cc
Napi::Value ElementSelectText(const Napi::CallbackInfo& info);     // uia_patterns.cc
Napi::Value ElementPerformAction(const Napi::CallbackInfo& info);  // uia_patterns.cc
Napi::Value ElementClickablePoint(const Napi::CallbackInfo& info); // uia_patterns.cc
Napi::Value ElementInvoke(const Napi::CallbackInfo& info);         // uia_patterns.cc
Napi::Value ElementScroll(const Napi::CallbackInfo& info);         // uia_patterns.cc

// ── A3：窗口枚举与 token 注册表（window_registry.cc；§11.5「window_id = native 窗口
// 注册表不透明整数 token，Helper 代内单调、不复用；使用前复验」）─────────────────
struct WindowIdentity {
  HWND hwnd = nullptr;
  DWORD pid = 0;             // 窗口宿主进程（AFH 承载时 = AFH pid——复验判据用宿主事实）
  std::wstring exePath;      // 宿主进程 canonical exe（§10.7 前后双复核的身份快照）
};

struct TopLevelWindowFact {
  HWND hwnd = nullptr;
  DWORD pid = 0;             // 归属 pid（AFH → 真实应用修正后，§11.3）
  DWORD hostPid = 0;         // 窗口宿主进程 pid（AFH 承载时 ≠ pid）
  std::wstring aumid;        // 窗口 AUMID（PKEY_AppUserModel_ID；可空）
  std::wstring title;
  RECT bounds{};
  bool minimized = false;
};

std::vector<TopLevelWindowFact> EnumerateVisibleTopLevelWindows();
std::wstring QueryProcessExePath(DWORD pid);
std::wstring WindowAumid(HWND hwnd);
bool IsApplicationFrameHostPid(DWORD pid);
// AFH 承载的 packaged app：frame 窗口 → 真实应用 pid（AUMID/子窗口双路径，唯一候选
// 纪律；0 = 不可解析 → fail-closed，§11.3/§10.4 规则 2）。
DWORD ResolveFrameHostedAppPid(HWND frameHwnd);
// 前台 pid（AFH 修正后；0 = 无前台/不可解析）。
DWORD CorrectedForegroundPid();
uint32_t RegisterWindowToken(HWND hwnd, DWORD hostPid, const std::wstring& hostExePath);
bool ResolveWindowToken(uint32_t token, WindowIdentity& out);

// ── A3：UIA 专属常驻 MTA worker（uia_worker.cc；§11.1 卡死隔离 poison-detach-rebuild）──

struct UiaTaskSlot {
  std::function<void()> body;          // 在 MTA worker 上执行；内部自捕获全部异常
  std::atomic<bool> abandoned{false};  // 等待方已提前离开（取消/超时）——body 提交前检查
  HANDLE doneEvent = nullptr;          // 由 RunUiaTask 创建；slot 析构关闭（shared_ptr 双持有）
  ~UiaTaskSlot() {
    if (doneEvent) CloseHandle(doneEvent);
  }
};

enum class UiaTaskOutcome { completed, timed_out, canceled, internal };

// 在 UIA worker 上跑一个任务并等待结果：deadlineMs 到期 → poison-detach-rebuild（不等
// COM 返回，§11.1）→ timed_out；cancelable 且取消旗置位 → 等待方离开 → canceled（只读
// 观察面专属——变更类 pattern 调用是单个原子 COM 调用，等到 deadline 内报真实结果，
// 绝不提前弃等谎称「确定未派发」）。
UiaTaskOutcome RunUiaTask(const std::shared_ptr<UiaTaskSlot>& slot, DWORD deadlineMs,
                          bool cancelable);
uint32_t UiaPoisonedCount();
uint64_t UiaWorkerGeneration();
// 协作式停止（同步、幂等；entry 统一退出收口点调用——CUA-A3-SHUTDOWN-CRASH 评审修复，
// spec §19 第 14 条）：置停止旗 + 广播 cv，parked worker 退出循环，teardown 期不留线程。
void StopUiaWorker();
// worker 线程专属：每代 worker 缓存一个 IUIAutomation 实例（CoCreateInstance 一次）。
IUIAutomation* AcquireUiaAutomation();

// ── A3：冻结元素注册表（uia_tree.cc；COM 引用不出 native，JS 只持不透明 token，§11.5）──
// elements 的所有权转移进注册表（调用方已 AddRef；ReleaseFrozenState/代际孤儿清理配对
// Release）。generation = 提交时的 worker 代——孤儿代（poison-detach 后）的条目查找即
// stale fail-closed，绝不跨代触碰 COM 指针。
uint32_t CommitFrozenElements(std::vector<IUIAutomationElement*> elements,
                              std::vector<std::vector<int>> runtimeIds, uint64_t generation);
bool LookupFrozenElement(uint32_t stateToken, size_t index, uint64_t& generationOut,
                         IUIAutomationElement** elementOut,
                         const std::vector<int>** runtimeIdOut);
void ReleaseFrozenState(uint32_t stateToken);
// RuntimeId 快照/复验共用助手（uia_tree.cc 实现；COM API 只有 GetRuntimeId 无 cached
// 变体——冻结与复验两侧同源走它）。
std::vector<int> RuntimeIdVector(IUIAutomationElement* element);

}  // namespace ax
