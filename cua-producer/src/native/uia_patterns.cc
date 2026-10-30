// ACode 原创（specs/windows-helper-producer.md §11.2/§10.3/§10.12）。
// UIA pattern 动作面：elementSetValue / elementSelectText / elementPerformAction /
// elementClickablePoint / elementInvoke / elementScroll。
//
// 统一前置（§11.2「元素活性复验——一切 element 动作的统一前置」）：动作执行前在 MTA
// worker 上取 CurrentRuntimeId 与冻结快照对比 + IsOffscreen 检查 → 不一致/消失 →
// stale（fail-closed；与 SDK「索引在观察时冻结、元素消失由 Helper fail-closed」契约一致）。
// 复验与 pattern 调用同一 worker 任务内（不跨任务留窗口）。孤儿代（poison-detach 后）的
// 冻结 token 查找即 stale——绝不跨代触碰 COM 指针（§11.1）。
//
// delivery-state（§10.3/§10.12 铁律 1 的 native 侧事实源）：pattern 调用发起前置
// dispatchStarted=true——此后任何失败（含超时毒化）→ driver 归类 Ambiguous →
// possibly_sent 收据；pattern 缺失/活性复验失败发生在派发前 → Rejected → ok:false 安全区。
// 变更类 pattern 任务不可取消等待（单个原子 COM 调用不可中断——等到 3s 预算内报真实
// 结果，绝不提前弃等谎称「确定未派发」，§11.1 A3 实现批次裁决）；clickable point 是
// 只读观察，可取消。
#include "ax_internal.h"

// WIN32_LEAN_AND_MEAN 排除 ole2 系头——COM 前置依赖显式引入（uia_tree.cc 同由）。
#include <objbase.h>
#include <oleacc.h>  // STATE_SYSTEM_READONLY（LegacyIAccessible 只读判定位）
#include <oleauto.h>
// uiautomation.h 伞形头（UIAutomationCore.h + Client.h + CoreApi.h）：枚举/常量/接口全在其内。
#include <uiautomation.h>
#include <winrt/base.h>

#include <algorithm>
#include <cmath>
#include <string>

namespace ax {
namespace {

constexpr DWORD kPatternDeadlineMs = 3000;  // §11.1 单 pattern 调用预算

// UIA_E_ELEMENTNOTAVAILABLE 常量在本 SDK 头零命中——按文档值本地补（元素已不可达）。
constexpr HRESULT kHrElementNotAvailable = static_cast<HRESULT>(0x80040200L);

std::wstring WideFromUtf8(const std::string& text) {
  if (text.empty()) return std::wstring();
  const int needed = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()),
                                         nullptr, 0);
  if (needed <= 0) return std::wstring();
  std::wstring result(static_cast<size_t>(needed), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), result.data(),
                      needed);
  return result;
}

// 活性复验 + 冻结元素取得（只许在 UIA worker 任务体内调用——COM 指针不出 worker）。
// 返回 false 时 *errorCode 已置（kStale）；成功返回持有独立引用的 com_ptr。
bool AcquireLiveElement(uint32_t stateToken, int index,
                        winrt::com_ptr<IUIAutomationElement>& out, const char** errorCode) {
  uint64_t generation = 0;
  IUIAutomationElement* raw = nullptr;
  const std::vector<int>* frozenRuntimeId = nullptr;
  if (!LookupFrozenElement(stateToken, static_cast<size_t>(index), generation, &raw,
                           &frozenRuntimeId)) {
    *errorCode = kStale;  // token 未知/索引越界/已释放 → element_unavailable（fail-closed）
    return false;
  }
  if (generation != UiaWorkerGeneration()) {
    *errorCode = kStale;  // 孤儿代：不触碰 COM 指针（§11.1 泄漏登记的对应读取面）
    return false;
  }
  raw->AddRef();  // 本任务持有独立引用（注册表的所有权不受影响）
  winrt::com_ptr<IUIAutomationElement> element;
  element.attach(raw);
  // RuntimeId 复验（冻结快照可得时）：不一致 = 元素已被替换/消失 → stale。
  if (!frozenRuntimeId->empty()) {
    const std::vector<int> current = RuntimeIdVector(element.get());
    if (current.empty() || current != *frozenRuntimeId) {
      *errorCode = kStale;
      return false;
    }
  }
  BOOL offscreen = FALSE;
  if (SUCCEEDED(element->get_CurrentIsOffscreen(&offscreen)) && offscreen != FALSE) {
    *errorCode = kStale;  // 离屏 = 观察时冻结的可达性已失效（§11.2 复验判据）
    return false;
  }
  out = element;
  return true;
}

// pattern 类任务统一外壳：slot 构造 → RunUiaTask（3s、变更类不可取消）→ 结果归口。
// TBody 泛型（lambda 直收——std::function 参数形态在 MSVC 下模板推导失败，实测）。
template <typename TState, typename TBody>
UiaTaskOutcome RunPatternTask(const std::shared_ptr<TState>& state, TBody&& body,
                              bool cancelable = false) {
  auto slot = std::make_shared<UiaTaskSlot>();
  std::function<void(const std::shared_ptr<TState>&)> wrapped(std::forward<TBody>(body));
  slot->body = [state, wrapped] { wrapped(state); };
  return RunUiaTask(slot, kPatternDeadlineMs, cancelable);
}

struct SetValueState {
  uint32_t token = 0;
  int index = 0;
  std::wstring value;
  const char* errorCode = nullptr;
  bool dispatchStarted = false;
  bool verified = false;
};

class ElementSetValueWorker final : public PromiseWorker {
 public:
  ElementSetValueWorker(const Napi::Env& env, uint32_t token, int index, std::wstring value)
      : PromiseWorker(env), state_(std::make_shared<SetValueState>()) {
    state_->token = token;
    state_->index = index;
    state_->value = std::move(value);
  }

 protected:
  void Execute() override {
    g_cancelRequested.store(false);
    auto state = state_;
    const UiaTaskOutcome outcome = RunPatternTask(state, [](const std::shared_ptr<SetValueState>& s) {
      winrt::com_ptr<IUIAutomationElement> element;
      if (!AcquireLiveElement(s->token, s->index, element, &s->errorCode)) return;
      winrt::com_ptr<IUIAutomationValuePattern> valuePattern;
      element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&valuePattern));
      bool readOnly = false;
      if (valuePattern) {
        BOOL isReadOnly = FALSE;
        if (SUCCEEDED(valuePattern->get_CurrentIsReadOnly(&isReadOnly))) {
          readOnly = isReadOnly != FALSE;
        }
      }
      winrt::com_ptr<IUIAutomationLegacyIAccessiblePattern> legacy;
      if (!valuePattern) {
        element->GetCurrentPatternAs(UIA_LegacyIAccessiblePatternId, IID_PPV_ARGS(&legacy));
        if (legacy) {
          // LegacyIAccessible 的只读判定走 state 位（派发前确定拒绝，绝不误入 possibly_sent）。
          DWORD legacyState = 0;
          if (SUCCEEDED(legacy->get_CurrentState(&legacyState)) &&
              (legacyState & STATE_SYSTEM_READONLY) != 0) {
            readOnly = true;
          }
        }
      }
      if (readOnly || (!valuePattern && !legacy)) {
        s->errorCode = kNotSettable;  // pattern 缺失/只读 → not_settable（§11.2，派发前）
        return;
      }
      s->dispatchStarted = true;
      const BSTR value = SysAllocString(s->value.c_str());
      HRESULT hr = E_FAIL;
      if (valuePattern) {
        hr = valuePattern->SetValue(value);
      } else {
        hr = legacy->SetValue(value);
      }
      SysFreeString(value);
      if (FAILED(hr)) {
        s->errorCode = kInternalNative;
        return;
      }
      // 写后读回验证（§11.2）：不一致 → verified=false（写已发生——JS 产 isError 收据
      // code internal + action_sent:true，诚实上报，绝不谎称成功也绝不 ok:false）。
      BSTR current = nullptr;
      if (valuePattern) {
        hr = valuePattern->get_CurrentValue(&current);
      } else {
        hr = legacy->get_CurrentValue(&current);
      }
      if (SUCCEEDED(hr) && current) {
        s->verified = s->value == std::wstring(current, SysStringLen(current));
        SysFreeString(current);
      } else {
        s->verified = false;  // 读回不可得 = 无法证明一致 → 诚实报未验证
      }
    });
    if (outcome == UiaTaskOutcome::timed_out) {
      FailAx(kUiaTimeout, state->dispatchStarted);  // 变更类超时 → possibly_sent（§11.1 分流）
      return;
    }
    if (outcome == UiaTaskOutcome::internal) {
      FailAx(kInternalNative, state->dispatchStarted);
      return;
    }
    if (outcome == UiaTaskOutcome::canceled) {
      FailAx(kCanceled, state->dispatchStarted);
      return;
    }
    if (state->errorCode) {
      FailAx(state->errorCode, state->dispatchStarted);
    }
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    result.Set("verified", Napi::Boolean::New(env, state_->verified));
    return result;
  }

 private:
  std::shared_ptr<SetValueState> state_;
};

struct SelectTextState {
  uint32_t token = 0;
  int index = 0;
  int start = 0;
  int length = 0;
  const char* errorCode = nullptr;
  bool dispatchStarted = false;
  bool rangeInvalid = false;
};

class ElementSelectTextWorker final : public PromiseWorker {
 public:
  ElementSelectTextWorker(const Napi::Env& env, uint32_t token, int index, int start, int length)
      : PromiseWorker(env), state_(std::make_shared<SelectTextState>()) {
    state_->token = token;
    state_->index = index;
    state_->start = start;
    state_->length = length;
  }

 protected:
  void Execute() override {
    g_cancelRequested.store(false);
    auto state = state_;
    const UiaTaskOutcome outcome =
        RunPatternTask(state, [](const std::shared_ptr<SelectTextState>& s) {
          winrt::com_ptr<IUIAutomationElement> element;
          if (!AcquireLiveElement(s->token, s->index, element, &s->errorCode)) return;
          winrt::com_ptr<IUIAutomationTextPattern> textPattern;
          element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&textPattern));
          if (!textPattern) {
            s->errorCode = kNotSelectable;  // TextPattern 缺失 → not_selectable（派发前）
            return;
          }
          winrt::com_ptr<IUIAutomationTextRange> document;
          if (FAILED(textPattern->get_DocumentRange(document.put())) || !document) {
            s->errorCode = kInternalNative;
            return;
          }
          winrt::com_ptr<IUIAutomationTextRange> range;
          if (FAILED(document->Clone(range.put())) || !range) {
            s->errorCode = kInternalNative;
            return;
          }
          // 折叠到文档起点：客户端 API 无 Collapse（SDK 实测）——End 端点移到 Start 端点
          // 即空 range（语义等价）。
          if (FAILED(range->MoveEndpointByRange(TextPatternRangeEndpoint_End, range.get(),
                                                TextPatternRangeEndpoint_Start))) {
            s->errorCode = kInternalNative;
            return;
          }
          int moved = 0;
          if (FAILED(range->Move(TextUnit_Character, s->start, &moved))) {
            s->errorCode = kInternalNative;
            return;
          }
          if (moved < s->start) {
            // start 越出元素文本长度 = 确定性参数错、未派发（§11.2 → invalid_request）。
            s->rangeInvalid = true;
            return;
          }
          if (s->length > 0) {
            int movedEnd = 0;
            if (FAILED(range->MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character,
                                                 s->length, &movedEnd))) {
              s->errorCode = kInternalNative;
              return;
            }
            // movedEnd < length = 文档末尾 clamp（合法，诚实选择；不视为参数错）。
          }
          s->dispatchStarted = true;
          if (FAILED(range->Select())) {
            s->errorCode = kInternalNative;
          }
        });
    if (outcome == UiaTaskOutcome::timed_out) {
      FailAx(kUiaTimeout, state->dispatchStarted);
      return;
    }
    if (outcome == UiaTaskOutcome::internal) {
      FailAx(kInternalNative, state->dispatchStarted);
      return;
    }
    if (outcome == UiaTaskOutcome::canceled) {
      FailAx(kCanceled, state->dispatchStarted);
      return;
    }
    if (state->errorCode) {
      FailAx(state->errorCode, state->dispatchStarted);
    }
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    result.Set("outcome",
               Napi::String::New(env, state_->rangeInvalid ? "range-invalid" : "selected"));
    return result;
  }

 private:
  std::shared_ptr<SelectTextState> state_;
};

struct PerformActionState {
  uint32_t token = 0;
  int index = 0;
  int action = 0;  // 0 invoke / 1 toggle / 2 expand / 3 collapse / 4 select / 5 focus
  const char* errorCode = nullptr;
  bool dispatchStarted = false;
};

class ElementPerformActionWorker final : public PromiseWorker {
 public:
  ElementPerformActionWorker(const Napi::Env& env, uint32_t token, int index, int action)
      : PromiseWorker(env), state_(std::make_shared<PerformActionState>()) {
    state_->token = token;
    state_->index = index;
    state_->action = action;
  }

 protected:
  void Execute() override {
    g_cancelRequested.store(false);
    auto state = state_;
    const UiaTaskOutcome outcome =
        RunPatternTask(state, [](const std::shared_ptr<PerformActionState>& s) {
          winrt::com_ptr<IUIAutomationElement> element;
          if (!AcquireLiveElement(s->token, s->index, element, &s->errorCode)) return;
          HRESULT hr = E_FAIL;
          switch (s->action) {
            case 0: {
              winrt::com_ptr<IUIAutomationInvokePattern> pattern;
              element->GetCurrentPatternAs(UIA_InvokePatternId, IID_PPV_ARGS(&pattern));
              if (!pattern) { s->errorCode = kActionUnavailable; return; }
              s->dispatchStarted = true;
              hr = pattern->Invoke();
              break;
            }
            case 1: {
              winrt::com_ptr<IUIAutomationTogglePattern> pattern;
              element->GetCurrentPatternAs(UIA_TogglePatternId, IID_PPV_ARGS(&pattern));
              if (!pattern) { s->errorCode = kActionUnavailable; return; }
              s->dispatchStarted = true;
              hr = pattern->Toggle();
              break;
            }
            case 2:
            case 3: {
              winrt::com_ptr<IUIAutomationExpandCollapsePattern> pattern;
              element->GetCurrentPatternAs(UIA_ExpandCollapsePatternId, IID_PPV_ARGS(&pattern));
              if (!pattern) { s->errorCode = kActionUnavailable; return; }
              s->dispatchStarted = true;
              hr = s->action == 2 ? pattern->Expand() : pattern->Collapse();
              break;
            }
            case 4: {
              winrt::com_ptr<IUIAutomationSelectionItemPattern> pattern;
              element->GetCurrentPatternAs(UIA_SelectionItemPatternId, IID_PPV_ARGS(&pattern));
              if (!pattern) { s->errorCode = kActionUnavailable; return; }
              s->dispatchStarted = true;
              hr = pattern->Select();
              break;
            }
            default: {  // 5 = focus（IUIAutomationElement.SetFocus，无 pattern 前置）
              s->dispatchStarted = true;
              hr = element->SetFocus();
              break;
            }
          }
          if (FAILED(hr)) s->errorCode = kInternalNative;
        });
    if (outcome == UiaTaskOutcome::timed_out) {
      FailAx(kUiaTimeout, state->dispatchStarted);
      return;
    }
    if (outcome == UiaTaskOutcome::internal) {
      FailAx(kInternalNative, state->dispatchStarted);
      return;
    }
    if (outcome == UiaTaskOutcome::canceled) {
      FailAx(kCanceled, state->dispatchStarted);
      return;
    }
    if (state->errorCode) {
      FailAx(state->errorCode, state->dispatchStarted);
    }
  }

 private:
  std::shared_ptr<PerformActionState> state_;
};

struct ClickablePointState {
  uint32_t token = 0;
  int index = 0;
  const char* errorCode = nullptr;
  bool found = false;
  double x = 0;
  double y = 0;
};

class ElementClickablePointWorker final : public PromiseWorker {
 public:
  ElementClickablePointWorker(const Napi::Env& env, uint32_t token, int index)
      : PromiseWorker(env), state_(std::make_shared<ClickablePointState>()) {
    state_->token = token;
    state_->index = index;
  }

 protected:
  void Execute() override {
    g_cancelRequested.store(false);
    // clickable point 是屏幕坐标产出面（§10.7 R 裁决触点）：本 worker 线程先过线程级
    // PMv2 复核，失败即既有 fail-closed（只读观察 → dispatchStarted=false）。
    if (!EnsureThreadDpiPerMonitorV2()) {
      FailAx(kNonInteractiveDesktop, false);
      return;
    }
    auto state = state_;
    // 只读观察（无副作用）：可取消等待。
    const UiaTaskOutcome outcome =
        RunPatternTask(
            state,
            [](const std::shared_ptr<ClickablePointState>& s) {
              // 任务体前奏：GetClickablePoint 在 MTA 线程执行，该线程必须是真 PMv2
              // （虚拟化坐标与 capture/SendInput 失配，绝不带病产出）。
              if (!EnsureThreadDpiPerMonitorV2()) {
                s->errorCode = kNonInteractiveDesktop;
                return;
              }
              winrt::com_ptr<IUIAutomationElement> element;
              if (!AcquireLiveElement(s->token, s->index, element, &s->errorCode)) return;
              POINT point{};
              BOOL found = FALSE;
              const HRESULT hr = element->GetClickablePoint(&point, &found);
              if (FAILED(hr)) {
                // 元素已不可达（UIA_E_ELEMENTNOTAVAILABLE 等）→ stale；其余 → internal。
                s->errorCode = hr == kHrElementNotAvailable ? kStale : kInternalNative;
                return;
              }
              s->found = found != FALSE;
              s->x = point.x;
              s->y = point.y;
            },
            /*cancelable=*/true);
    if (outcome == UiaTaskOutcome::timed_out) {
      FailAx(kUiaTimeout, false);  // 只读 → ok:false timeout（重试安全）
      return;
    }
    if (outcome == UiaTaskOutcome::canceled) {
      FailAx(kCanceled, false);
      return;
    }
    if (outcome == UiaTaskOutcome::internal) {
      FailAx(kInternalNative, false);
      return;
    }
    if (state->errorCode) {
      FailAx(state->errorCode, false);
    }
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    if (state_->found) {
      Napi::Object point = Napi::Object::New(env);
      point.Set("x", Napi::Number::New(env, state_->x));
      point.Set("y", Napi::Number::New(env, state_->y));
      result.Set("point", point);
    } else {
      result.Set("point", env.Null());  // 无 clickable point → JS 走 action_unavailable（§11.2 ③）
    }
    return result;
  }

 private:
  std::shared_ptr<ClickablePointState> state_;
};

struct InvokeState {
  uint32_t token = 0;
  int index = 0;
  const char* errorCode = nullptr;
  bool dispatchStarted = false;
  bool invoked = false;
};

class ElementInvokeWorker final : public PromiseWorker {
 public:
  ElementInvokeWorker(const Napi::Env& env, uint32_t token, int index)
      : PromiseWorker(env), state_(std::make_shared<InvokeState>()) {
    state_->token = token;
    state_->index = index;
  }

 protected:
  void Execute() override {
    g_cancelRequested.store(false);
    auto state = state_;
    const UiaTaskOutcome outcome = RunPatternTask(state, [](const std::shared_ptr<InvokeState>& s) {
      winrt::com_ptr<IUIAutomationElement> element;
      if (!AcquireLiveElement(s->token, s->index, element, &s->errorCode)) return;
      winrt::com_ptr<IUIAutomationInvokePattern> pattern;
      element->GetCurrentPatternAs(UIA_InvokePatternId, IID_PPV_ARGS(&pattern));
      if (!pattern) {
        s->invoked = false;  // 无 InvokePattern = 事实（JS 走 clickable point 兜底，§11.2 ①→②）
        return;
      }
      s->dispatchStarted = true;
      if (FAILED(pattern->Invoke())) {
        s->errorCode = kInternalNative;
        return;
      }
      s->invoked = true;
    });
    if (outcome == UiaTaskOutcome::timed_out) {
      FailAx(kUiaTimeout, state->dispatchStarted);
      return;
    }
    if (outcome == UiaTaskOutcome::internal) {
      FailAx(kInternalNative, state->dispatchStarted);
      return;
    }
    if (outcome == UiaTaskOutcome::canceled) {
      FailAx(kCanceled, state->dispatchStarted);
      return;
    }
    if (state->errorCode) {
      FailAx(state->errorCode, state->dispatchStarted);
    }
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    result.Set("invoked", Napi::Boolean::New(env, state_->invoked));
    return result;
  }

 private:
  std::shared_ptr<InvokeState> state_;
};

struct ScrollElementState {
  uint32_t token = 0;
  int index = 0;
  int deltaX = 0;
  int deltaY = 0;
  const char* errorCode = nullptr;
  bool dispatchStarted = false;
  bool scrolled = false;
};

class ElementScrollWorker final : public PromiseWorker {
 public:
  ElementScrollWorker(const Napi::Env& env, uint32_t token, int index, int deltaX, int deltaY)
      : PromiseWorker(env), state_(std::make_shared<ScrollElementState>()) {
    state_->token = token;
    state_->index = index;
    state_->deltaX = deltaX;
    state_->deltaY = deltaY;
  }

 protected:
  void Execute() override {
    g_cancelRequested.store(false);
    auto state = state_;
    const UiaTaskOutcome outcome =
        RunPatternTask(state, [](const std::shared_ptr<ScrollElementState>& s) {
          winrt::com_ptr<IUIAutomationElement> element;
          if (!AcquireLiveElement(s->token, s->index, element, &s->errorCode)) return;
          // SDK 10.0.26100 实测：IUIAutomationScrollPattern2 不存在（细粒度 ScrollByAmount
          // 不可用）——用 v1 ScrollPattern 的粗粒度枚举。映射（A3 实现批次裁决，spec 回写）：
          // wire delta 以 WHEEL_DELTA(120) 为单位（1 页 = 360，§10.2）；|delta|≥360 →
          // Large 档 × round(pages)（总步数上限 12，防无界 scroll_amount）；不足一页 →
          // Small 档 × round(ticks)（1..3）。方向：wire up/right 为正；UIA Increment =
          // right/down 为正 → 垂直轴取反映射。
          winrt::com_ptr<IUIAutomationScrollPattern> pattern;
          element->GetCurrentPatternAs(UIA_ScrollPatternId, IID_PPV_ARGS(&pattern));
          if (!pattern) {
            s->scrolled = false;  // 无 ScrollPattern = 事实（JS 走 clickable point + 物理滚轮）
            return;
          }
          const int magnitude = std::max(std::abs(s->deltaX), std::abs(s->deltaY));
          if (magnitude == 0) {
            s->scrolled = true;  // 零滚动量 = 无害 no-op（--pointer 烟测探针同语义）
            return;
          }
          const bool large = magnitude >= 360;
          int steps = large ? static_cast<int>(std::lround(magnitude / 360.0))
                            : static_cast<int>(std::lround(magnitude / 120.0));
          steps = std::max(1, std::min(steps, large ? 12 : 3));
          const auto axis = [large](int delta, bool vertical) -> ScrollAmount {
            if (delta == 0) return ScrollAmount_NoAmount;
            // 垂直：wire up(+) → UIA Decrement；水平：wire right(+) → UIA Increment。
            const bool increment = vertical ? delta < 0 : delta > 0;
            if (large) return increment ? ScrollAmount_LargeIncrement : ScrollAmount_LargeDecrement;
            return increment ? ScrollAmount_SmallIncrement : ScrollAmount_SmallDecrement;
          };
          const ScrollAmount horizontal = axis(s->deltaX, false);
          const ScrollAmount vertical = axis(s->deltaY, true);
          s->dispatchStarted = true;
          for (int step = 0; step < steps; step += 1) {
            if (FAILED(pattern->Scroll(horizontal, vertical))) {
              s->errorCode = kInternalNative;
              return;
            }
          }
          s->scrolled = true;
        });
    if (outcome == UiaTaskOutcome::timed_out) {
      FailAx(kUiaTimeout, state->dispatchStarted);
      return;
    }
    if (outcome == UiaTaskOutcome::internal) {
      FailAx(kInternalNative, state->dispatchStarted);
      return;
    }
    if (outcome == UiaTaskOutcome::canceled) {
      FailAx(kCanceled, state->dispatchStarted);
      return;
    }
    if (state->errorCode) {
      FailAx(state->errorCode, state->dispatchStarted);
    }
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    result.Set("scrolled", Napi::Boolean::New(env, state_->scrolled));
    return result;
  }

 private:
  std::shared_ptr<ScrollElementState> state_;
};

// ── NAPI 入口参数校验（同步判定、零派发 → RejectedPromise，§10.1 签名契约）──────

bool ParseTokenIndex(const Napi::CallbackInfo& info, uint32_t& token, int& index) {
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) return false;
  const double tokenValue = info[0].As<Napi::Number>().DoubleValue();
  const double indexValue = info[1].As<Napi::Number>().DoubleValue();
  if (!(tokenValue >= 1) || tokenValue > 0xFFFFFFFF || tokenValue != std::floor(tokenValue)) {
    return false;
  }
  if (!(indexValue >= 0) || indexValue > 0x7FFFFFFF || indexValue != std::floor(indexValue)) {
    return false;
  }
  token = static_cast<uint32_t>(tokenValue);
  index = static_cast<int>(indexValue);
  return true;
}

}  // namespace

Napi::Value ElementSetValue(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  uint32_t token = 0;
  int index = 0;
  if (!ParseTokenIndex(info, token, index)) {
    return RejectedPromise(env, "elementSetValue requires a numeric stateToken and index");
  }
  if (info.Length() < 3 || !info[2].IsString()) {
    return RejectedPromise(env, "elementSetValue requires a string value");
  }
  const std::string value = info[2].As<Napi::String>().Utf8Value();
  auto* worker = new ElementSetValueWorker(env, token, index, WideFromUtf8(value));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value ElementSelectText(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  uint32_t token = 0;
  int index = 0;
  if (!ParseTokenIndex(info, token, index)) {
    return RejectedPromise(env, "elementSelectText requires a numeric stateToken and index");
  }
  if (info.Length() < 4 || !info[2].IsNumber() || !info[3].IsNumber()) {
    return RejectedPromise(env, "elementSelectText requires numeric start and length");
  }
  const double start = info[2].As<Napi::Number>().DoubleValue();
  const double length = info[3].As<Napi::Number>().DoubleValue();
  if (!(start >= 0) || start > 0x7FFFFFFF || start != std::floor(start) || !(length >= 0) ||
      length > 0x7FFFFFFF || length != std::floor(length)) {
    return RejectedPromise(env, "elementSelectText start/length must be non-negative integers");
  }
  auto* worker = new ElementSelectTextWorker(env, token, index, static_cast<int>(start),
                                             static_cast<int>(length));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value ElementPerformAction(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  uint32_t token = 0;
  int index = 0;
  if (!ParseTokenIndex(info, token, index)) {
    return RejectedPromise(env, "elementPerformAction requires a numeric stateToken and index");
  }
  if (info.Length() < 3 || !info[2].IsString()) {
    return RejectedPromise(env, "elementPerformAction requires a string action");
  }
  const std::string action = info[2].As<Napi::String>().Utf8Value();
  int actionId = -1;
  if (action == "invoke") actionId = 0;
  else if (action == "toggle") actionId = 1;
  else if (action == "expand") actionId = 2;
  else if (action == "collapse") actionId = 3;
  else if (action == "select") actionId = 4;
  else if (action == "focus") actionId = 5;
  if (actionId < 0) {
    // 封闭词汇（§11.2）：词汇外 → invalid_request 域（JS 侧已先拦，这里是 native 双保险，
    // 同步拒绝零派发）。
    return RejectedPromise(env, "elementPerformAction action is outside the closed vocabulary");
  }
  auto* worker = new ElementPerformActionWorker(env, token, index, actionId);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value ElementClickablePoint(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  uint32_t token = 0;
  int index = 0;
  if (!ParseTokenIndex(info, token, index)) {
    return RejectedPromise(env, "elementClickablePoint requires a numeric stateToken and index");
  }
  auto* worker = new ElementClickablePointWorker(env, token, index);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value ElementInvoke(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  uint32_t token = 0;
  int index = 0;
  if (!ParseTokenIndex(info, token, index)) {
    return RejectedPromise(env, "elementInvoke requires a numeric stateToken and index");
  }
  auto* worker = new ElementInvokeWorker(env, token, index);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value ElementScroll(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  uint32_t token = 0;
  int index = 0;
  if (!ParseTokenIndex(info, token, index)) {
    return RejectedPromise(env, "elementScroll requires a numeric stateToken and index");
  }
  if (info.Length() < 4 || !info[2].IsNumber() || !info[3].IsNumber()) {
    return RejectedPromise(env, "elementScroll requires numeric deltaX and deltaY");
  }
  const double deltaX = info[2].As<Napi::Number>().DoubleValue();
  const double deltaY = info[3].As<Napi::Number>().DoubleValue();
  if (!std::isfinite(deltaX) || !std::isfinite(deltaY) || std::abs(deltaX) > 1e7 ||
      std::abs(deltaY) > 1e7) {
    return RejectedPromise(env, "elementScroll deltas are out of range");
  }
  auto* worker = new ElementScrollWorker(env, token, index, static_cast<int>(deltaX),
                                         static_cast<int>(deltaY));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

}  // namespace ax
