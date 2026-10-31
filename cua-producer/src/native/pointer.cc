// ACode 原创（specs/windows-helper-producer.md §10.1/§10.4/§10.6）。
// 指针注入面：moveTo / scrollAt / drag / mouseDown / mouseUp。
//
// 指针纪律（§10.4，全部硬性）：
//   1. 派发瞬间前台校验——每个注入批次在同一 native 调用内先 IsExpectedForeground，
//      pid 不符 → foreground_lost、零注入（跨调用 TOCTOU 不可接受）；
//   3. held 零遗留——mouseDown 成功即注册 held 注册表；drag 中途失败/取消先 cleanup
//      释放本动作 held（免前台校验）再收口；退出路径经 releaseAllHeldInputs 幂等释放；
//   4. 部分失败不续注入——drag 插值段任一失败/取消即停止后续业务段，已注入点数如实
//      进结果（injectedPoints），绝不重试补注入（重试 = 重放，C08 红线）；
//   5. 动作内收口释放——cleanup 释放不推进动作语义、只把输入状态归零。
//
// 坐标空间恒为虚拟桌面物理像素（主显左上原点，副屏负坐标合法，§10.1）；SendInput 用
// MOUSEEVENTF_VIRTUALDESK + 0..65535 归一化（上游机制：负坐标副屏使用 virtual desktop
// 映射，windows-source-development.md:268）。滚轮 delta 单位 = WHEEL_DELTA(120) 倍数
// （wire 层换算 1 页 = 360，§10.2）；水平滚动走 HWHEEL。
// 取消语义（§10.6）：drag 插值循环每步检查 g_cancelRequested（步间 sleep 4ms，中断响应
// ≤500ms 契约满足）；取消 → cleanup 释放 → {injectedPoints, canceled:true}。
#include "ax_internal.h"

#include <algorithm>
#include <cmath>
#include <thread>

namespace ax {
namespace {

constexpr DWORD kInvalidFlag = 0;
constexpr int kDragStepSleepMs = 4;    // 插值步间隔（取消检查粒度）
constexpr int kDragMaxSteps = 512;     // 插值步上限（长距离拖拽的时长上界 ~2s）
constexpr int kDragMinSteps = 8;       // 插值步下限（短距离也有可观察的中间点）
constexpr double kDragPixelsPerStep = 8.0;

bool ParseButton(const Napi::Value& value, std::string& out) {
  if (!value.IsString()) return false;
  const std::string name = value.As<Napi::String>().Utf8Value();
  if (name != "left" && name != "right" && name != "middle") return false;
  out = name;
  return true;
}

// 解析 opts.expectedForegroundPid（§10.1：必现、无缺省——指针纪律的结构化落点）。
// 失败时置 errorMessage（固定字面量、零插值），调用方转 rejected Promise。
bool ParseExpectedPid(const Napi::Value& options, DWORD& out, const char*& errorMessage) {
  if (!options.IsObject()) {
    errorMessage = "pointer operations require an options object";
    return false;
  }
  const Napi::Object object = options.As<Napi::Object>();
  if (!object.Has("expectedForegroundPid") || !object.Get("expectedForegroundPid").IsNumber()) {
    errorMessage = "pointer operations require opts.expectedForegroundPid";
    return false;
  }
  const double pid = object.Get("expectedForegroundPid").As<Napi::Number>().DoubleValue();
  if (!(pid >= 1) || pid > 0xFFFFFFFF || pid != std::floor(pid)) {
    errorMessage = "opts.expectedForegroundPid must be a positive integer";
    return false;
  }
  out = static_cast<DWORD>(pid);
  return true;
}

bool ParseFiniteNumber(const Napi::Value& value, double& out) {
  if (!value.IsNumber()) return false;
  out = value.As<Napi::Number>().DoubleValue();
  return std::isfinite(out);
}

// 虚拟桌面物理像素 → SendInput 归一化坐标（0..65535，MOUSEEVENTF_VIRTUALDESK 语义）。
void MakeAbsoluteMoveInput(double x, double y, INPUT& out) {
  const int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const int vw = std::max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
  const int vh = std::max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
  // 归一化：左上角 (vx,vy) → 0；右下角 (vx+vw-1, vy+vh-1) → 65535；越界 clamp（物理事实
  // 上光标本就在虚拟桌面内，clamp 只防御异常入参，不改变合法坐标的投影）。
  const double nx = (x - static_cast<double>(vx)) * 65535.0 / static_cast<double>(std::max(1, vw - 1));
  const double ny = (y - static_cast<double>(vy)) * 65535.0 / static_cast<double>(std::max(1, vh - 1));
  const auto clampNorm = [](double v) -> LONG {
    return static_cast<LONG>(std::clamp(v, 0.0, 65535.0) + 0.5);
  };
  out = INPUT{};
  out.type = INPUT_MOUSE;
  out.mi.dx = clampNorm(nx);
  out.mi.dy = clampNorm(ny);
  out.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
}

UINT InjectBatch(std::vector<INPUT>& inputs) {
  if (inputs.empty()) return 0;
  return SendInput(static_cast<UINT>(inputs.size()), inputs.data(), sizeof(INPUT));
}

// ── moveTo ────────────────────────────────────────────────────────────────────
class MoveToWorker final : public PromiseWorker {
 public:
  MoveToWorker(const Napi::Env& env, double x, double y, DWORD expectedPid)
      : PromiseWorker(env), x_(x), y_(y), expectedPid_(expectedPid) {}

 protected:
  void Execute() override {
    // stop 非闩锁（§10.6）：新派发在入口清零取消旗标；cancelOperations 只作用于
    // 「当前正在 Execute 的操作」。admission 串行 + stop 先阻断出队再置旗（JS 侧），
    // 排除竞态窗口（input-session.ts 注释）。
    g_cancelRequested.store(false);
    // 坐标触点（§10.7 R 裁决）：GetSystemMetrics/SendInput 归一化在本 worker 线程执行，
    // 线程必须是真 PMv2——electron fork 下进程级 Set 恒被拒，门禁归线程级复核；
    // 失败即既有 fail-closed（零注入，确定未派发）。
    if (!EnsureThreadDpiPerMonitorV2()) {
      FailAx(kNonInteractiveDesktop, false);
      return;
    }
    if (!IsExpectedForeground(expectedPid_)) {
      FailAx(kForegroundLost, false);  // 零注入，确定未派发（§10.3）
      return;
    }
    INPUT input{};
    MakeAbsoluteMoveInput(x_, y_, input);
    std::vector<INPUT> batch{input};
    if (InjectBatch(batch) != 1) {
      FailAx(kInjectionRejected, true);  // SendInput 报告 0 条注入（UIPI 等）→ 注入面不可证
    }
  }

 private:
  double x_;
  double y_;
  DWORD expectedPid_;
};

// ── scrollAt ──────────────────────────────────────────────────────────────────
class ScrollAtWorker final : public PromiseWorker {
 public:
  ScrollAtWorker(const Napi::Env& env, double x, double y, double deltaX, double deltaY,
                 DWORD expectedPid)
      : PromiseWorker(env), x_(x), y_(y), deltaX_(deltaX), deltaY_(deltaY),
        expectedPid_(expectedPid) {}

 protected:
  void Execute() override {
    g_cancelRequested.store(false);
    // 坐标触点（§10.7 R 裁决）：线程级 PMv2 复核先于任何注入（同 MoveToWorker）。
    if (!EnsureThreadDpiPerMonitorV2()) {
      FailAx(kNonInteractiveDesktop, false);
      return;
    }
    if (!IsExpectedForeground(expectedPid_)) {
      FailAx(kForegroundLost, false);
      return;
    }
    // 单批原子注入：先定位光标（滚轮事件命中光标下窗口），再 WHEEL/HWHEEL。
    // delta 单位 = WHEEL_DELTA(120) 倍数（§10.1；wire 层 1 页 = 360）。零 delta = 零滚轮
    // 事件（--pointer 烟测的无副作用探针形态，§15.2 步骤 3）。
    std::vector<INPUT> batch;
    INPUT move{};
    MakeAbsoluteMoveInput(x_, y_, move);
    batch.push_back(move);
    const auto wheelDelta = [](double v) -> DWORD {
      return static_cast<DWORD>(static_cast<int>(std::lround(v)));
    };
    if (deltaY_ != 0.0) {
      INPUT wheel{};
      wheel.type = INPUT_MOUSE;
      wheel.mi.dwFlags = MOUSEEVENTF_WHEEL;
      wheel.mi.mouseData = wheelDelta(deltaY_);
      batch.push_back(wheel);
    }
    if (deltaX_ != 0.0) {
      INPUT hwheel{};
      hwheel.type = INPUT_MOUSE;
      hwheel.mi.dwFlags = MOUSEEVENTF_HWHEEL;
      hwheel.mi.mouseData = wheelDelta(deltaX_);
      batch.push_back(hwheel);
    }
    const UINT expected = static_cast<UINT>(batch.size());
    if (InjectBatch(batch) != expected) {
      FailAx(kInjectionRejected, true);
    }
  }

 private:
  double x_;
  double y_;
  double deltaX_;
  double deltaY_;
  DWORD expectedPid_;
};

// ── drag ──────────────────────────────────────────────────────────────────────
class DragWorker final : public PromiseWorker {
 public:
  DragWorker(const Napi::Env& env, double fromX, double fromY, double toX, double toY,
             std::string button, DWORD expectedPid)
      : PromiseWorker(env), fromX_(fromX), fromY_(fromY), toX_(toX), toY_(toY),
        button_(std::move(button)), expectedPid_(expectedPid) {}

 protected:
  void Execute() override {
    g_cancelRequested.store(false);
    // 坐标触点（§10.7 R 裁决）：线程级 PMv2 复核先于任何注入（同 MoveToWorker）。
    if (!EnsureThreadDpiPerMonitorV2()) {
      FailAx(kNonInteractiveDesktop, false);
      return;
    }
    if (!IsExpectedForeground(expectedPid_)) {
      FailAx(kForegroundLost, false);
      return;
    }
    const DWORD downFlag = MouseFlagForButton(button_, true);
    const DWORD upFlag = MouseFlagForButton(button_, false);

    // 起点按下（注册 held——部分失败/取消/进程退出都不遗留，§10.4 规则 3/5）。
    INPUT move{};
    MakeAbsoluteMoveInput(fromX_, fromY_, move);
    INPUT down{};
    down.type = INPUT_MOUSE;
    down.mi.dwFlags = downFlag;
    std::vector<INPUT> downBatch{move, down};
    if (InjectBatch(downBatch) != 2) {
      FailAx(kInjectionRejected, true);
      return;  // 按下未证明成功 → 不注册 held（无可释放项）
    }
    RegisterHeldButton(button_);

    // 插值移动（每步检查取消；步间 sleep 使取消响应 ≤500ms，§10.6）。
    const double distance = std::max(std::abs(toX_ - fromX_), std::abs(toY_ - fromY_));
    const int steps = static_cast<int>(
        std::clamp(distance / kDragPixelsPerStep, static_cast<double>(kDragMinSteps),
                   static_cast<double>(kDragMaxSteps)));
    bool canceled = false;
    for (int step = 1; step <= steps; step += 1) {
      if (g_cancelRequested.load()) {
        canceled = true;
        break;  // 规则 4：停止后续业务段；已注入点数如实进结果
      }
      const double t = static_cast<double>(step) / static_cast<double>(steps);
      INPUT stepMove{};
      MakeAbsoluteMoveInput(fromX_ + (toX_ - fromX_) * t, fromY_ + (toY_ - fromY_) * t, stepMove);
      std::vector<INPUT> stepBatch{stepMove};
      if (InjectBatch(stepBatch) != 1) {
        // 中途注入失败：cleanup 释放（免前台校验）后如实上报——注入面不可证 → Ambiguous
        // （driver 按 dispatchStarted=true 归类 possibly_sent，§10.3）。
        ReleaseDragButton(upFlag);
        FailAx(kInjectionRejected, true);
        return;
      }
      injectedPoints_ += 1;
      if (step < steps) std::this_thread::sleep_for(std::chrono::milliseconds(kDragStepSleepMs));
    }

    // 终点抬起：取消路径走 cleanup 释放（不推进动作语义）；正常路径抬起是业务段收尾。
    ReleaseDragButton(upFlag);
    canceled_ = canceled;
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    result.Set("injectedPoints", Napi::Number::New(env, static_cast<double>(injectedPoints_)));
    result.Set("canceled", Napi::Boolean::New(env, canceled_));
    return result;
  }

 private:
  void ReleaseDragButton(DWORD upFlag) {
    INPUT up{};
    up.type = INPUT_MOUSE;
    up.mi.dwFlags = upFlag;
    std::vector<INPUT> upBatch{up};
    InjectBatch(upBatch);  // best-effort：释放失败不掩盖原始失败类别（注册表已清）
    UnregisterHeldButton(button_);
  }

  double fromX_;
  double fromY_;
  double toX_;
  double toY_;
  std::string button_;
  DWORD expectedPid_;
  int injectedPoints_ = 0;
  bool canceled_ = false;
};

// ── mouseDown / mouseUp ───────────────────────────────────────────────────────
class MouseDownWorker final : public PromiseWorker {
 public:
  MouseDownWorker(const Napi::Env& env, std::string button, DWORD expectedPid)
      : PromiseWorker(env), button_(std::move(button)), expectedPid_(expectedPid) {}

 protected:
  void Execute() override {
    g_cancelRequested.store(false);
    if (!IsExpectedForeground(expectedPid_)) {
      FailAx(kForegroundLost, false);
      return;
    }
    INPUT down{};
    down.type = INPUT_MOUSE;
    down.mi.dwFlags = MouseFlagForButton(button_, true);
    std::vector<INPUT> batch{down};
    if (InjectBatch(batch) != 1) {
      FailAx(kInjectionRejected, true);
      return;
    }
    RegisterHeldButton(button_);  // held 注册表 = 退出路径释放的事实源（§10.4 规则 3）
  }

 private:
  std::string button_;
  DWORD expectedPid_;
};

class MouseUpWorker final : public PromiseWorker {
 public:
  MouseUpWorker(const Napi::Env& env, std::string button, bool cleanupMode, DWORD expectedPid)
      : PromiseWorker(env), button_(std::move(button)), cleanupMode_(cleanupMode),
        expectedPid_(expectedPid) {}

 protected:
  void Execute() override {
    g_cancelRequested.store(false);
    // mode:"cleanup" 不做前台校验（§10.1 设计注记 2：left_mouse_up 仅作已按下键的清理，
    // 可在焦点变化后释放——上游机制 windows-source-development.md:268）。
    if (!cleanupMode_ && !IsExpectedForeground(expectedPid_)) {
      FailAx(kForegroundLost, false);
      return;
    }
    INPUT up{};
    up.type = INPUT_MOUSE;
    up.mi.dwFlags = MouseFlagForButton(button_, false);
    std::vector<INPUT> batch{up};
    const UINT sent = InjectBatch(batch);
    // 注销无条件执行（即便注入未证明成功：注册表语义是「本进程认为按下的键」，UP 已尽力
    // 发出；保留条目会让退出路径重复释放——幂等但误导诊断面）。
    UnregisterHeldButton(button_);
    if (sent != 1 && !cleanupMode_) {
      FailAx(kInjectionRejected, true);
    }
    // cleanup 模式的注入失败不上报错误（best-effort 语义：释放路径的失败不得掩盖调用方
    // 的原始收口目的；系统级键态由 asyncKeyState 佐证，§15.2）。
  }

 private:
  std::string button_;
  bool cleanupMode_;
  DWORD expectedPid_;
};

}  // namespace

DWORD MouseFlagForButton(const std::string& name, bool down) {
  if (name == "left") return down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
  if (name == "right") return down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
  if (name == "middle") return down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
  return kInvalidFlag;
}

bool InjectMouseUpDown(DWORD flag, int /*x*/, int /*y*/) {
  INPUT input{};
  input.type = INPUT_MOUSE;
  input.mi.dwFlags = flag;
  std::vector<INPUT> batch{input};
  return InjectBatch(batch) == 1;
}

Napi::Value MoveTo(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  double x = 0;
  double y = 0;
  if (info.Length() < 3 || !ParseFiniteNumber(info[0], x) || !ParseFiniteNumber(info[1], y)) {
    return RejectedPromise(env, "moveTo requires finite numeric x and y");
  }
  DWORD expectedPid = 0;
  const char* errorMessage = nullptr;
  if (!ParseExpectedPid(info[2], expectedPid, errorMessage)) return RejectedPromise(env, errorMessage);
  auto* worker = new MoveToWorker(env, x, y, expectedPid);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value ScrollAt(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  double x = 0;
  double y = 0;
  double deltaX = 0;
  double deltaY = 0;
  if (info.Length() < 5 || !ParseFiniteNumber(info[0], x) || !ParseFiniteNumber(info[1], y) ||
      !ParseFiniteNumber(info[2], deltaX) || !ParseFiniteNumber(info[3], deltaY)) {
    return RejectedPromise(env, "scrollAt requires finite numeric x, y, deltaX and deltaY");
  }
  DWORD expectedPid = 0;
  const char* errorMessage = nullptr;
  if (!ParseExpectedPid(info[4], expectedPid, errorMessage)) return RejectedPromise(env, errorMessage);
  auto* worker = new ScrollAtWorker(env, x, y, deltaX, deltaY, expectedPid);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value Drag(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  double fromX = 0;
  double fromY = 0;
  double toX = 0;
  double toY = 0;
  if (info.Length() < 5 || !ParseFiniteNumber(info[0], fromX) || !ParseFiniteNumber(info[1], fromY) ||
      !ParseFiniteNumber(info[2], toX) || !ParseFiniteNumber(info[3], toY)) {
    return RejectedPromise(env, "drag requires finite numeric fromX, fromY, toX and toY");
  }
  DWORD expectedPid = 0;
  const char* errorMessage = nullptr;
  if (!ParseExpectedPid(info[4], expectedPid, errorMessage)) return RejectedPromise(env, errorMessage);
  std::string button = "left";  // 缺省 left（§10.1）
  const Napi::Object options = info[4].As<Napi::Object>();
  if (options.Has("button") && !options.Get("button").IsUndefined() &&
      !options.Get("button").IsNull()) {
    if (!ParseButton(options.Get("button"), button)) {
      return RejectedPromise(env, "drag button must be left, right or middle");
    }
  }
  auto* worker = new DragWorker(env, fromX, fromY, toX, toY, button, expectedPid);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value MouseDown(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  std::string button;
  if (info.Length() < 1 || !ParseButton(info[0], button)) {
    return RejectedPromise(env, "mouseDown requires button left, right or middle");
  }
  if (info.Length() < 2) {
    return RejectedPromise(env, "mouseDown requires an options object");
  }
  DWORD expectedPid = 0;
  const char* errorMessage = nullptr;
  if (!ParseExpectedPid(info[1], expectedPid, errorMessage)) return RejectedPromise(env, errorMessage);
  auto* worker = new MouseDownWorker(env, button, expectedPid);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value MouseUp(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  std::string button;
  if (info.Length() < 1 || !ParseButton(info[0], button)) {
    return RejectedPromise(env, "mouseUp requires button left, right or middle");
  }
  if (info.Length() < 2 || !info[1].IsObject()) {
    return RejectedPromise(env, "mouseUp requires an options object");
  }
  const Napi::Object options = info[1].As<Napi::Object>();
  const std::string mode =
      options.Has("mode") && options.Get("mode").IsString()
          ? options.Get("mode").As<Napi::String>().Utf8Value()
          : "action";  // 缺省 action（cleanup 必须显式声明——释放语义是纪律例外）
  if (mode != "action" && mode != "cleanup") {
    return RejectedPromise(env, "mouseUp mode must be action or cleanup");
  }
  const bool cleanupMode = mode == "cleanup";
  DWORD expectedPid = 0;
  if (!cleanupMode) {
    const char* errorMessage = nullptr;
    if (!ParseExpectedPid(options, expectedPid, errorMessage)) return RejectedPromise(env, errorMessage);
  }
  auto* worker = new MouseUpWorker(env, button, cleanupMode, expectedPid);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

}  // namespace ax
