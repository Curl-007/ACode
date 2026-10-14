// ACode 原创（specs/windows-helper-producer.md §10.1/§10.4/§10.9）。
// 前台校验 + 进程身份查询 + held-input 注册表操作 + 只读投影面（foregroundPid /
// heldInputSnapshot / asyncKeyState / cursorPosition）+ releaseAllHeldInputs。
//
// 指针纪律（§10.4 规则 1）：IsExpectedForeground 供 pointer.cc/keyboard.cc 在每个注入
// 批次前调用——GetForegroundWindow → GetWindowThreadProcessId，pid 不符即拒绝、零注入；
// 校验与注入在同一 native 调用内（JS 层校验跨调用 TOCTOU 不可接受）。
// 只读投影面的用途：asyncKeyState 是「系统级」键态事实（可跨进程佐证 Helper 无遗留
// 按住键，--pointer 烟测步骤 4 的断言载体）；cursorPosition 是 moveTo 负控制
// （零注入 ⇒ 光标零移动）的断言载体（§10.4/§15.2）。
#include "ax_internal.h"

#include <algorithm>
#include <cmath>

namespace ax {
namespace {

// ── held 注册表操作（§10.4 规则 3：native 层是唯一事实源）──

class HeldSnapshotWorker final : public PromiseWorker {
 public:
  explicit HeldSnapshotWorker(const Napi::Env& env) : PromiseWorker(env) {}

 protected:
  void Execute() override { snapshot_ = SnapshotHeld(); }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    Napi::Array buttons = Napi::Array::New(env, snapshot_.buttons.size());
    for (size_t i = 0; i < snapshot_.buttons.size(); i += 1) {
      buttons.Set(static_cast<uint32_t>(i), Napi::String::New(env, snapshot_.buttons[i]));
    }
    Napi::Array keys = Napi::Array::New(env, snapshot_.keys.size());
    for (size_t i = 0; i < snapshot_.keys.size(); i += 1) {
      keys.Set(static_cast<uint32_t>(i), Napi::Number::New(env, snapshot_.keys[i]));
    }
    result.Set("buttons", buttons);
    result.Set("keys", keys);
    return result;
  }

 private:
  HeldSnapshot snapshot_;
};

class ReleaseAllHeldWorker final : public PromiseWorker {
 public:
  explicit ReleaseAllHeldWorker(const Napi::Env& env) : PromiseWorker(env) {}

 protected:
  // 幂等；不做前台校验（cleanup 语义，§10.1 设计注记 2——焦点变化后仍可释放）。
  void Execute() override { released_ = ReleaseHeldInputsNow(); }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    result.Set("released", Napi::Number::New(env, static_cast<double>(released_)));
    return result;
  }

 private:
  size_t released_ = 0;
};

class ForegroundPidWorker final : public PromiseWorker {
 public:
  explicit ForegroundPidWorker(const Napi::Env& env) : PromiseWorker(env) {}

 protected:
  void Execute() override {
    HWND foreground = GetForegroundWindow();
    if (foreground) {
      DWORD pid = 0;
      GetWindowThreadProcessId(foreground, &pid);
      pid_ = pid;
    }
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    if (pid_ > 0) {
      result.Set("pid", Napi::Number::New(env, static_cast<double>(pid_)));
    } else {
      result.Set("pid", env.Null());
    }
    return result;
  }

 private:
  DWORD pid_ = 0;
};

class AsyncKeyStateWorker final : public PromiseWorker {
 public:
  AsyncKeyStateWorker(const Napi::Env& env, int vk) : PromiseWorker(env), vk_(vk) {}

 protected:
  void Execute() override {
    // GetAsyncKeyState 只读投影（系统级事实，跨进程可见——§10.1）。
    down_ = (GetAsyncKeyState(vk_) & 0x8000) != 0;
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    result.Set("down", Napi::Boolean::New(env, down_));
    return result;
  }

 private:
  int vk_;
  bool down_ = false;
};

class CursorPositionWorker final : public PromiseWorker {
 public:
  explicit CursorPositionWorker(const Napi::Env& env) : PromiseWorker(env) {}

 protected:
  void Execute() override {
    POINT point{};
    if (!GetCursorPos(&point)) {
      FailAx(kInternalNative, false);
      return;
    }
    x_ = point.x;
    y_ = point.y;
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    result.Set("x", Napi::Number::New(env, static_cast<double>(x_)));
    result.Set("y", Napi::Number::New(env, static_cast<double>(y_)));
    return result;
  }

 private:
  LONG x_ = 0;
  LONG y_ = 0;
};

// 进程 canonical executable path 查询（§10.9 app_ref 校验：进程存活 + QueryFullProcessImageName
// 可读；死亡/不可读 → path:null → wire 层「target app is not running」字面量）。
// 路径值是身份事实，只用于存在性判定与 A3 的 _meta 展示投影——绝不进日志/错误文本（§3.2）。
class ProcessExecutablePathWorker final : public PromiseWorker {
 public:
  ProcessExecutablePathWorker(const Napi::Env& env, DWORD pid) : PromiseWorker(env), pid_(pid) {}

 protected:
  void Execute() override {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid_);
    if (!process) return;  // path_ 保持空 → {path:null}
    // 32768 wchar 上界：QueryFullProcessImageNameW 的长路径容量（MAX_PATH*4 会让深装
    // 目录的存活进程被误报「不可读」→ wire 层「target app is not running」误拒——方向
    // 虽 fail-closed 但不诚实，按 API 文档容量给足）。
    std::wstring buffer(32768, L'\0');
    DWORD size = static_cast<DWORD>(buffer.size());
    if (QueryFullProcessImageNameW(process, 0, buffer.data(), &size) && size > 0) {
      path_.assign(buffer.data(), size);
    }
    CloseHandle(process);
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    if (path_.empty()) {
      result.Set("path", env.Null());
    } else {
      result.Set("path", Napi::String::New(env, reinterpret_cast<const char16_t*>(path_.data()),
                                           path_.size()));
    }
    return result;
  }

 private:
  DWORD pid_;
  std::wstring path_;
};

}  // namespace

HeldSnapshot SnapshotHeld() {
  HeldSnapshot snapshot;
  std::lock_guard<std::mutex> lock(g_heldMutex);
  snapshot.buttons.assign(g_heldButtons.begin(), g_heldButtons.end());
  snapshot.keys.assign(g_heldKeys.begin(), g_heldKeys.end());
  return snapshot;
}

size_t ReleaseHeldInputsNow() {
  // 先摘空注册表再注入（幂等：并发释放看到空表直接返回 0；重复 UP 对 OS 是无害 no-op）。
  std::vector<std::string> buttons;
  std::vector<int> keys;
  {
    std::lock_guard<std::mutex> lock(g_heldMutex);
    buttons.assign(g_heldButtons.begin(), g_heldButtons.end());
    keys.assign(g_heldKeys.begin(), g_heldKeys.end());
    g_heldButtons.clear();
    g_heldKeys.clear();
  }
  size_t released = 0;
  // 释放顺序与按下顺序相反（LIFO），best-effort：单个失败不阻断其余（退出路径预算 ≤300ms，
  // §10.4 规则 3；宿主 shutdownTimeoutMs=1s 地板内）。
  for (auto it = buttons.rbegin(); it != buttons.rend(); ++it) {
    const DWORD upFlag = MouseFlagForButton(*it, false);
    if (upFlag != 0 && InjectMouseUpDown(upFlag)) released += 1;
  }
  for (auto it = keys.rbegin(); it != keys.rend(); ++it) {
    if (InjectKeyUp(*it)) released += 1;
  }
  return released;
}

bool IsExpectedForeground(DWORD expectedPid) {
  if (expectedPid == 0) return false;
  HWND foreground = GetForegroundWindow();
  if (!foreground) return false;  // 无前台窗口 = 无法证明 → fail-closed（§10.4）
  DWORD pid = 0;
  GetWindowThreadProcessId(foreground, &pid);
  if (pid == expectedPid) return true;
  // A3 收口（§10.4 规则 2 / §11.3 packaged 修正）：前台是 ApplicationFrameHost.exe 承载时，
  // 经 frame 窗口的 PKEY_AppUserModel_ID + 子窗口/同 AUMID 顶层窗口解析真实应用 pid 再比对；
  // 解析失败/多候选 → 判负（CorrectedForegroundPid 返回 AFH pid 或 0，均 ≠ expectedPid，
  // fail-closed 方向不变——可能误拒、绝不误放）。
  const DWORD corrected = CorrectedForegroundPid();
  return corrected != 0 && corrected == expectedPid;
}

Napi::Value ForegroundPid(const Napi::CallbackInfo& info) {
  auto* worker = new ForegroundPidWorker(info.Env());
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value HeldInputSnapshot(const Napi::CallbackInfo& info) {
  auto* worker = new HeldSnapshotWorker(info.Env());
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value AsyncKeyState(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    return RejectedPromise(env, "asyncKeyState requires a numeric vk code");
  }
  const int vk = info[0].As<Napi::Number>().Int32Value();
  if (vk <= 0 || vk > 0xFFFF) {
    return RejectedPromise(env, "asyncKeyState vk is out of range");
  }
  auto* worker = new AsyncKeyStateWorker(env, vk);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value CursorPosition(const Napi::CallbackInfo& info) {
  auto* worker = new CursorPositionWorker(info.Env());
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value ProcessExecutablePath(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    return RejectedPromise(env, "processExecutablePath requires a numeric pid");
  }
  const double pidValue = info[0].As<Napi::Number>().DoubleValue();
  if (!(pidValue >= 1) || pidValue > 0xFFFFFFFF || pidValue != std::floor(pidValue)) {
    return RejectedPromise(env, "processExecutablePath requires a positive integer pid");
  }
  auto* worker = new ProcessExecutablePathWorker(env, static_cast<DWORD>(pidValue));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value ReleaseAllHeldInputs(const Napi::CallbackInfo& info) {
  auto* worker = new ReleaseAllHeldWorker(info.Env());
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

}  // namespace ax
