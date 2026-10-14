// ACode 原创（specs/windows-helper-producer.md §10.1/§10.2/§10.4/§10.6/§10.9）。
// 键盘注入面：sendText（KEYEVENTF_UNICODE，布局无关——不依赖目标键盘布局）与
// pressKeys（VK 序列，chord→VK 解析在 JS 侧 keymap.ts 封闭映射表，native 只注入）。
//
// 指针纪律同律适用于键盘（§10.4 规则 1；上游机制：键盘只在证明 app_ref.pid 唯一前台后
// 才转全局 SendInput，windows-source-development.md:268/:355-359）：
//   - sendText 按 ≤64 code units 分 chunk 注入，每个 chunk 注入前重新前台校验 + 检查取消
//     旗标（≤500ms 中断响应，§10.6）；chunk 边界绝不在 UTF-16 代理对中间切分；
//   - pressKeys 的每个业务段（down 段/hold 等待/up 段）注入前前台校验；hold 等待环
//     100ms 粒度检查取消；
//   - 中途失败/取消 → 先 cleanup 释放本调用已按下的键（规则 4「不续注入」+ 规则 5
//     「动作内收口释放」；cleanup 免前台校验），再如实收口：已注入量进结果
//     （injected/total、canceled），绝不为凑完整重试补注入。
// 前台校验失败的 delivery-state 分流（§10.3 二分判据）：0 注入 → foreground_lost
// (dispatchStarted=false → driver 归类 Rejected → ok:false foreground_required)；
// 已有注入 → foreground_lost(dispatchStarted=true → Ambiguous → possibly_sent 收据)。
#include "ax_internal.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <thread>

namespace ax {
namespace {

constexpr size_t kTextChunkCodeUnits = 64;  // §10.9：type.text 按 ≤64 code units 分 chunk
constexpr int kHoldCheckSliceMs = 100;      // hold 等待环的取消检查粒度（≤500ms 契约内）

bool IsHighSurrogate(char16_t unit) { return unit >= 0xD800 && unit <= 0xDBFF; }

// 单事件键注入原语（foreground.cc 的释放路径共用；KEYEVENTF_KEYUP 无前台校验——cleanup 语义）。
bool InjectKeyRaw(WORD vk, bool up, bool unicode, char16_t scan) {
  INPUT input{};
  input.type = INPUT_KEYBOARD;
  if (unicode) {
    input.ki.wScan = scan;
    input.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
  } else {
    input.ki.wVk = vk;
    input.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
  }
  return SendInput(1, &input, sizeof(INPUT)) == 1;
}

// ── sendText ──────────────────────────────────────────────────────────────────
class SendTextWorker final : public PromiseWorker {
 public:
  SendTextWorker(const Napi::Env& env, std::u16string text, DWORD expectedPid)
      : PromiseWorker(env), text_(std::move(text)), expectedPid_(expectedPid) {}

 protected:
  void Execute() override {
    g_cancelRequested.store(false);
    total_ = text_.size();
    size_t pos = 0;
    while (pos < total_) {
      if (g_cancelRequested.load()) {
        canceled_ = true;
        break;  // 规则 4：停止后续业务段；injected 如实进结果 → interrupted 收据（§10.6）
      }
      if (!IsExpectedForeground(expectedPid_)) {
        if (injected_ == 0) {
          FailAx(kForegroundLost, false);  // 零注入，确定未派发（§10.3）
          return;
        }
        // 已注入部分文本：副作用已发生、序列未完成——不上报 foreground_lost 的
        // Rejected 形态（那会谎称「确定未派发」）；以 injected<total 的部分事实收口
        // （backend 映射 interrupted 收据 accepted+action_sent:true，§10.12 行 3）。
        break;
      }
      // chunk 边界绝不在代理对中间切分（UTF-16 完整性，§10.9）：若边界落在高代理之后、
      // 低代理之前，把边界回退 1（高代理随下一 chunk 注入）。
      size_t end = std::min(pos + kTextChunkCodeUnits, total_);
      if (end < total_ && end > pos && IsHighSurrogate(text_[end - 1])) end -= 1;
      // 每 code unit 一对 down/up 事件（Unicode 注入无 held 残留面：批内成对）。
      std::vector<INPUT> batch;
      batch.reserve((end - pos) * 2);
      for (size_t i = pos; i < end; i += 1) {
        batch.push_back(INPUT{});
        INPUT& down = batch.back();
        down.type = INPUT_KEYBOARD;
        down.ki.wScan = text_[i];
        down.ki.dwFlags = KEYEVENTF_UNICODE;
        batch.push_back(INPUT{});
        INPUT& up = batch.back();
        up.type = INPUT_KEYBOARD;
        up.ki.wScan = text_[i];
        up.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      }
      const UINT expected = static_cast<UINT>(batch.size());
      const UINT sent = SendInput(expected, batch.data(), sizeof(INPUT));
      if (sent != expected) {
        // 部分/零注入（UIPI 等）：若 sent 为奇数，最后一个 down 无配对 up——立即补发
        // 该 code unit 的 up（cleanup，防幻影按住键跨动作残留，§10.4 规则 5）。
        if (sent % 2 == 1) {
          const size_t strayIndex = pos + (sent / 2);
          if (strayIndex < end) InjectKeyRaw(0, true, true, text_[strayIndex]);
        }
        injected_ += static_cast<size_t>(sent / 2);
        FailAx(kInjectionRejected, true);  // 注入面不可证 → Ambiguous → possibly_sent（§10.3）
        return;
      }
      injected_ += end - pos;
      pos = end;
    }
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    result.Set("injected", Napi::Number::New(env, static_cast<double>(injected_)));
    result.Set("total", Napi::Number::New(env, static_cast<double>(total_)));
    result.Set("canceled", Napi::Boolean::New(env, canceled_));
    return result;
  }

 private:
  std::u16string text_;
  DWORD expectedPid_;
  size_t injected_ = 0;
  size_t total_ = 0;
  bool canceled_ = false;
};

// ── pressKeys ─────────────────────────────────────────────────────────────────
struct KeyEntry {
  int vk;
  bool up;
};

class PressKeysWorker final : public PromiseWorker {
 public:
  PressKeysWorker(const Napi::Env& env, std::vector<KeyEntry> keys, DWORD expectedPid,
                  double holdMs)
      : PromiseWorker(env), keys_(std::move(keys)), expectedPid_(expectedPid), holdMs_(holdMs) {}

 protected:
  void Execute() override {
    g_cancelRequested.store(false);
    bool holdDone = holdMs_ <= 0.0;
    for (const KeyEntry& entry : keys_) {
      if (g_cancelRequested.load()) {
        CleanupMine();
        canceled_ = true;
        return;  // → {canceled:true} → interrupted 收据（§10.6）
      }
      if (!entry.up) {
        if (!IsExpectedForeground(expectedPid_)) {
          if (!dispatchStarted_) {
            FailAx(kForegroundLost, false);  // 零注入，确定未派发
          } else {
            // 已注入 down 段：cleanup 释放后按「派发已启动、结果不可证」上报
            // （dispatchStarted=true → driver 归类 Ambiguous → possibly_sent，§10.3/§10.12）。
            CleanupMine();
            FailAx(kForegroundLost, true);
          }
          return;
        }
        if (!InjectKeyRaw(static_cast<WORD>(entry.vk), false, false, 0)) {
          CleanupMine();
          FailAx(kInjectionRejected, true);
          return;
        }
        dispatchStarted_ = true;
        RegisterHeldKey(entry.vk);
        mine_.push_back(entry.vk);
      } else {
        // hold 等待发生在 down 段与 up 段之间（backend 保证序列形态 [downs…, ups…]，
        // keymap.ts；hold_seconds ∈ [0,30] → holdMs ≤ 30000）。
        if (!holdDone) {
          holdDone = true;
          if (!WaitHold()) {
            CleanupMine();
            canceled_ = true;
            return;
          }
        }
        // up 段是业务段（chord 的修饰键 up，§10.2）：同样先前台校验。
        if (!IsExpectedForeground(expectedPid_)) {
          CleanupMine();
          FailAx(kForegroundLost, true);
          return;
        }
        if (!InjectKeyRaw(static_cast<WORD>(entry.vk), true, false, 0)) {
          CleanupMine();
          FailAx(kInjectionRejected, true);
          return;
        }
        UnregisterHeldKey(entry.vk);
        mine_.erase(std::remove(mine_.begin(), mine_.end(), entry.vk), mine_.end());
      }
    }
    // 全 down 序列（无 up 段，如 mouseDown 式的显式 hold 原语用法）也要履行 hold 等待。
    if (!holdDone) {
      holdDone = true;
      if (!WaitHold()) {
        CleanupMine();
        canceled_ = true;
        return;
      }
    }
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    result.Set("canceled", Napi::Boolean::New(env, canceled_));
    return result;
  }

 private:
  // hold 等待环：100ms 粒度检查取消旗标（§10.6：≤500ms 中断响应）。true=等满，false=被取消。
  bool WaitHold() {
    const auto deadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(static_cast<long long>(holdMs_));
    for (;;) {
      if (g_cancelRequested.load()) return false;
      const auto now = std::chrono::steady_clock::now();
      if (now >= deadline) return true;
      const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
      const int slice = static_cast<int>(std::min<long long>(remaining.count(), kHoldCheckSliceMs));
      std::this_thread::sleep_for(std::chrono::milliseconds(std::max(1, slice)));
    }
  }

  // 规则 5「动作内收口释放」：本调用按下的键全部 cleanup 释放（免前台校验、LIFO），
  // 释放先于失败收口——幻影修饰键绝不跨动作残留（§10.4 规则 5 的典型场景论证）。
  void CleanupMine() {
    for (auto it = mine_.rbegin(); it != mine_.rend(); ++it) {
      InjectKeyRaw(static_cast<WORD>(*it), true, false, 0);  // best-effort
      UnregisterHeldKey(*it);
    }
    mine_.clear();
  }

  std::vector<KeyEntry> keys_;
  DWORD expectedPid_;
  double holdMs_;
  std::vector<int> mine_;
  bool dispatchStarted_ = false;
  bool canceled_ = false;
};

}  // namespace

bool InjectKeyUp(int vk) { return InjectKeyRaw(static_cast<WORD>(vk), true, false, 0); }

Napi::Value SendText(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString()) {
    return RejectedPromise(env, "sendText requires a text string");
  }
  DWORD expectedPid = 0;
  if (!info[1].IsObject()) {
    return RejectedPromise(env, "sendText requires an options object");
  }
  const Napi::Object options = info[1].As<Napi::Object>();
  if (!options.Has("expectedForegroundPid") || !options.Get("expectedForegroundPid").IsNumber()) {
    return RejectedPromise(env, "sendText requires opts.expectedForegroundPid");
  }
  const double pid = options.Get("expectedForegroundPid").As<Napi::Number>().DoubleValue();
  if (!(pid >= 1) || pid > 0xFFFFFFFF || pid != std::floor(pid)) {
    return RejectedPromise(env, "opts.expectedForegroundPid must be a positive integer");
  }
  expectedPid = static_cast<DWORD>(pid);
  // wire 层已按 §10.2 限 32,768 code units；native 防御性同限（超限 = 调用方违约，
  // 参数校验先于任何派发——零副作用拒绝）。
  const std::u16string text = info[0].As<Napi::String>().Utf16Value();
  if (text.size() > 32768) {
    return RejectedPromise(env, "sendText text exceeds 32768 UTF-16 code units");
  }
  auto* worker = new SendTextWorker(env, text, expectedPid);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value PressKeys(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsObject()) {
    return RejectedPromise(env, "pressKeys requires a keys array and an options object");
  }
  const Napi::Array array = info[0].As<Napi::Array>();
  if (array.Length() == 0 || array.Length() > 64) {
    // 封闭上界：chord 序列（修饰 down/up + 主键）远小于 64；防御异常调用。
    return RejectedPromise(env, "pressKeys requires 1..64 key entries");
  }
  std::vector<KeyEntry> keys;
  keys.reserve(array.Length());
  for (uint32_t i = 0; i < array.Length(); i += 1) {
    const Napi::Value item = array.Get(i);
    if (!item.IsObject()) {
      return RejectedPromise(env, "pressKeys entries must be objects of {vk, up}");
    }
    const Napi::Object entry = item.As<Napi::Object>();
    if (!entry.Has("vk") || !entry.Get("vk").IsNumber() || !entry.Has("up") ||
        !entry.Get("up").IsBoolean()) {
      return RejectedPromise(env, "pressKeys entries must be objects of {vk, up}");
    }
    const double vk = entry.Get("vk").As<Napi::Number>().DoubleValue();
    if (!(vk >= 1) || vk > 0xFFFF || vk != std::floor(vk)) {
      return RejectedPromise(env, "pressKeys vk must be an integer in 1..65535");
    }
    keys.push_back(KeyEntry{static_cast<int>(vk), entry.Get("up").As<Napi::Boolean>().Value()});
  }
  const Napi::Object options = info[1].As<Napi::Object>();
  if (!options.Has("expectedForegroundPid") || !options.Get("expectedForegroundPid").IsNumber()) {
    return RejectedPromise(env, "pressKeys requires opts.expectedForegroundPid");
  }
  const double pid = options.Get("expectedForegroundPid").As<Napi::Number>().DoubleValue();
  if (!(pid >= 1) || pid > 0xFFFFFFFF || pid != std::floor(pid)) {
    return RejectedPromise(env, "opts.expectedForegroundPid must be a positive integer");
  }
  double holdMs = 0;
  if (options.Has("holdMs") && !options.Get("holdMs").IsUndefined() &&
      !options.Get("holdMs").IsNull()) {
    if (!options.Get("holdMs").IsNumber()) {
      return RejectedPromise(env, "pressKeys holdMs must be a number");
    }
    holdMs = options.Get("holdMs").As<Napi::Number>().DoubleValue();
    // wire 层 hold_seconds ∈ [0,30]（§10.2）→ holdMs ≤ 30000；native 防御性同限。
    if (!std::isfinite(holdMs) || holdMs < 0 || holdMs > 30000) {
      return RejectedPromise(env, "pressKeys holdMs must be within 0..30000");
    }
  }
  auto* worker = new PressKeysWorker(env, std::move(keys), static_cast<DWORD>(pid), holdMs);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

}  // namespace ax
