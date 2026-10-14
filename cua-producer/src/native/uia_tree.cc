// ACode 原创（specs/windows-helper-producer.md §11.1/§11.2/§11.4/§11.5）。
// UIA 观察面：listApplications / listWindows / captureUiTree / releaseStateToken /
// uiaWorkerStats + 冻结元素注册表（COM 引用不出 native，JS 只持不透明 token）。
//
// 纪律：
// - 全部 UIA COM 只在专属 MTA worker 上执行（uia_worker.cc 的 RunUiaTask；观察类预算
//   8s，超时 → poison-detach-rebuild + uia_timeout，§11.1）；
// - C09 红线：native 失败/超时/挂死一律类型化错误出口，与「遍历成功且 0 元素」是两个
//   不同出口——结构上不存在「失败读成空树」的路径（§11.2）；
// - 预算感知遍历（§11.4）：≤maxElements 行 ∧ ≤maxTextBytes 估算字节；超限停止采集但
//   继续计数（M 如实报告总量）；文本可见 index ⇔ 注册表可解析（同集合截断）；
// - 树内容 = 不可信输入：name/value 单行化 + 截断（native 512 code units 采集上限，
//   wire 面 200 截断在 JS tree-text.ts），错误面零插值；
// - 冻结域提交以「等待方未离开」为前提（abandoned 检查）：取消/超时后绝不提交注册表。
#include "ax_internal.h"

// WIN32_LEAN_AND_MEAN 排除了 ole2 系头——UIA COM 客户端头的前置依赖须显式引入
//（capture.cc 的 <unknwn.h> 同由；SafeArray/PROPVARIANT 面另需 oleauto/objbase）。
#include <objbase.h>
#include <oleauto.h>
// uiautomation.h 是伞形头（UIAutomationCore.h + UIAutomationClient.h + UIAutomationCoreApi.h）：
// CONTROLTYPEID/ExpandCollapseState/TextUnit 枚举与 const long UIA_* 常量全在其内。
#include <uiautomation.h>
#include <winrt/base.h>

#include <algorithm>
#include <cmath>
#include <map>

namespace ax {
namespace {

constexpr DWORD kObserveDeadlineMs = 8000;  // §11.1 观察类预算（对齐上游 8 秒遍历期限机制）
constexpr DWORD kPatternDeadlineMs = 3000;  // §11.1 单 pattern/维护调用预算
constexpr int kMaxTreeDepth = 128;          // 递归深度上界（超深子树不枚举——计数如实至 cap）
constexpr size_t kCollectMaxCodeUnits = 512;  // native 采集截断（wire 面 200 截断在 JS）

std::string Utf8FromWide(const std::wstring& wide) {
  if (wide.empty()) return std::string();
  const int needed = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()),
                                         nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return std::string();
  std::string result(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()), result.data(),
                      needed, nullptr, nullptr);
  return result;
}

// 单行化 + code-unit 截断（采集侧 512；换行/回车 → 空格，树行格式的行判据依赖单行性）。
std::wstring SanitizeText(const wchar_t* text, size_t length) {
  std::wstring result;
  result.reserve(std::min(length, kCollectMaxCodeUnits));
  for (size_t i = 0; i < length && result.size() < kCollectMaxCodeUnits; i += 1) {
    const wchar_t ch = text[i];
    result.push_back((ch == L'\r' || ch == L'\n') ? L' ' : ch);
  }
  return result;
}

// UIA ControlType → 稳定英文名（§11.4 封闭映射，绝不本地化——渲染层 /^text\s+/iu 特判与
// 模型习惯都依赖稳定词汇）；未知 → "control"（诚实兜底，不猜测语义名）。
const char* RoleNameForControlType(CONTROLTYPEID type) {
  switch (type) {
    case UIA_ButtonControlTypeId: return "button";
    case UIA_CalendarControlTypeId: return "calendar";
    case UIA_CheckBoxControlTypeId: return "check-box";
    case UIA_ComboBoxControlTypeId: return "combo-box";
    case UIA_EditControlTypeId: return "edit";
    case UIA_HyperlinkControlTypeId: return "hyperlink";
    case UIA_ImageControlTypeId: return "image";
    case UIA_ListItemControlTypeId: return "list-item";
    case UIA_ListControlTypeId: return "list";
    case UIA_MenuControlTypeId: return "menu";
    case UIA_MenuBarControlTypeId: return "menu-bar";
    case UIA_MenuItemControlTypeId: return "menu-item";
    case UIA_ProgressBarControlTypeId: return "progress-bar";
    case UIA_RadioButtonControlTypeId: return "radio-button";
    case UIA_ScrollBarControlTypeId: return "scroll-bar";
    case UIA_SliderControlTypeId: return "slider";
    case UIA_SpinnerControlTypeId: return "spinner";
    case UIA_StatusBarControlTypeId: return "status-bar";
    case UIA_TabControlTypeId: return "tab";
    case UIA_TabItemControlTypeId: return "tab-item";
    case UIA_TextControlTypeId: return "text";
    case UIA_ToolBarControlTypeId: return "tool-bar";
    case UIA_ToolTipControlTypeId: return "tool-tip";
    case UIA_TreeControlTypeId: return "tree";
    case UIA_TreeItemControlTypeId: return "tree-item";
    case UIA_CustomControlTypeId: return "custom";
    case UIA_GroupControlTypeId: return "group";
    case UIA_ThumbControlTypeId: return "thumb";
    case UIA_DataGridControlTypeId: return "data-grid";
    case UIA_DataItemControlTypeId: return "data-item";
    case UIA_DocumentControlTypeId: return "document";
    case UIA_SplitButtonControlTypeId: return "split-button";
    case UIA_WindowControlTypeId: return "window";
    case UIA_PaneControlTypeId: return "pane";
    case UIA_HeaderControlTypeId: return "header";
    case UIA_HeaderItemControlTypeId: return "header-item";
    case UIA_TableControlTypeId: return "table";
    case UIA_TitleBarControlTypeId: return "title-bar";
    case UIA_SeparatorControlTypeId: return "separator";
    case UIA_SemanticZoomControlTypeId: return "semantic-zoom";
    case UIA_AppBarControlTypeId: return "app-bar";
    default: return "control";
  }
}

// ── 冻结元素注册表（§11.5；COM 引用所有权在 native，JS 只持 token）──────────────
std::mutex g_stateMutex;
uint32_t g_nextStateToken = 0;
struct FrozenState {
  uint64_t generation = 0;
  std::vector<IUIAutomationElement*> elements;  // AddRef/Release 配对是 native 职责
  std::vector<std::vector<int>> runtimeIds;
};
std::map<uint32_t, FrozenState> g_frozenStates;
constexpr size_t kMaxFrozenStates = 64;  // JS LRU（8 scope × 16）之外的 native 兜底上界

void ReleaseStateLocked(FrozenState& state) {
  if (state.generation == UiaWorkerGeneration()) {
    for (IUIAutomationElement* element : state.elements) {
      if (element) element->Release();  // 同代：MTA 内合法释放
    }
  }
  // 孤儿代（poison-detach 后）：不触碰 COM 指针——随 detached 线程泄漏（§11.1 如实登记）。
  state.elements.clear();
  state.runtimeIds.clear();
}

}  // namespace

// RuntimeId 快照/复验共用助手（ax_internal.h 声明；uia_patterns.cc 的活性复验同源消费）。
// COM C++ API 只有 GetRuntimeId（无 cached 变体，SDK 10.0.26100 实测核对）——冻结与复验
// 两侧都走它：复验本来就是「取当下的新值对比冻结快照」，语义精确吻合。
std::vector<int> RuntimeIdVector(IUIAutomationElement* element) {
  SAFEARRAY* array = nullptr;
  const HRESULT hr = element->GetRuntimeId(&array);
  std::vector<int> result;
  if (SUCCEEDED(hr) && array) {
    int* data = nullptr;
    if (SUCCEEDED(SafeArrayAccessData(array, reinterpret_cast<void**>(&data))) && data) {
      LONG lower = 0;
      LONG upper = -1;
      SafeArrayGetLBound(array, 1, &lower);
      SafeArrayGetUBound(array, 1, &upper);
      for (LONG i = lower; i <= upper; i += 1) result.push_back(data[i]);
      SafeArrayUnaccessData(array);
    }
    SafeArrayDestroy(array);
  }
  return result;
}

uint32_t CommitFrozenElements(std::vector<IUIAutomationElement*> elements,
                              std::vector<std::vector<int>> runtimeIds, uint64_t generation) {
  std::lock_guard<std::mutex> lock(g_stateMutex);
  g_nextStateToken += 1;
  const uint32_t token = g_nextStateToken;
  FrozenState state;
  state.generation = generation;
  state.elements = std::move(elements);
  state.runtimeIds = std::move(runtimeIds);
  g_frozenStates[token] = std::move(state);
  while (g_frozenStates.size() > kMaxFrozenStates) {
    auto oldest = g_frozenStates.begin();
    ReleaseStateLocked(oldest->second);
    g_frozenStates.erase(oldest);
  }
  return token;
}

bool LookupFrozenElement(uint32_t stateToken, size_t index, uint64_t& generationOut,
                         IUIAutomationElement** elementOut,
                         const std::vector<int>** runtimeIdOut) {
  std::lock_guard<std::mutex> lock(g_stateMutex);
  auto it = g_frozenStates.find(stateToken);
  if (it == g_frozenStates.end()) return false;
  if (index >= it->second.elements.size()) return false;
  generationOut = it->second.generation;
  *elementOut = it->second.elements[index];
  *runtimeIdOut = &it->second.runtimeIds[index];
  return true;
}

void ReleaseFrozenState(uint32_t stateToken) {
  std::lock_guard<std::mutex> lock(g_stateMutex);
  auto it = g_frozenStates.find(stateToken);
  if (it == g_frozenStates.end()) return;
  ReleaseStateLocked(it->second);
  g_frozenStates.erase(it);
}

namespace {

// ── 采集事实结构（BuildResult 在主线程读取；AsyncWorker Queue→OnOK 时序保证可见性）──
struct ElementFact {
  int index = 0;
  int depth = 0;
  std::string role;
  std::string name;
  bool hasValue = false;
  std::string value;      // 截断后的 UTF-8（≤512 code units 采集上限）
  int valueLength = 0;    // 完整值长度（select_text start 越界判据的事实通道）
  bool hasBounds = false;
  RECT bounds{};
  std::vector<std::string> patterns;
};

struct TreeTaskState {
  const char* errorCode = nullptr;
  bool noWindow = false;
  bool truncated = false;
  int totalElements = 0;
  uint32_t windowToken = 0;
  std::wstring windowTitle;
  RECT windowBounds{};
  std::vector<ElementFact> elements;
  std::vector<IUIAutomationElement*> frozen;  // AddRef 持有；提交或释放二选一
  std::vector<std::vector<int>> runtimeIds;
  uint32_t stateToken = 0;
};

struct AppFact {
  DWORD pid = 0;
  std::wstring exePath;
  std::wstring aumid;
  int windowCount = 0;
  bool active = false;
};

struct WindowFactOut {
  uint32_t windowId = 0;
  std::wstring title;
  DWORD pid = 0;
  std::wstring exePath;
  RECT bounds{};
  bool minimized = false;
};

// ── captureUiTree worker ───────────────────────────────────────────────────────
class CaptureUiTreeWorker final : public PromiseWorker {
 public:
  CaptureUiTreeWorker(const Napi::Env& env, DWORD pid, uint32_t windowToken, int maxElements,
                      long long maxTextBytes, DWORD deadlineOverrideMs)
      : PromiseWorker(env),
        pid_(pid),
        windowToken_(windowToken),
        maxElements_(maxElements),
        maxTextBytes_(maxTextBytes),
        deadlineOverrideMs_(deadlineOverrideMs) {}

 protected:
  void Execute() override;

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    result.Set("stateToken", Napi::Number::New(env, static_cast<double>(stateToken_)));
    if (noWindow_) {
      result.Set("window", env.Null());
    } else {
      Napi::Object window = Napi::Object::New(env);
      window.Set("windowId", Napi::Number::New(env, static_cast<double>(windowToken_)));
      window.Set("title", Napi::String::New(env, reinterpret_cast<const char16_t*>(windowTitle_.c_str()), windowTitle_.size()));
      Napi::Object bounds = Napi::Object::New(env);
      bounds.Set("x", Napi::Number::New(env, static_cast<double>(windowBounds_.left)));
      bounds.Set("y", Napi::Number::New(env, static_cast<double>(windowBounds_.top)));
      bounds.Set("width", Napi::Number::New(env, static_cast<double>(windowBounds_.right - windowBounds_.left)));
      bounds.Set("height", Napi::Number::New(env, static_cast<double>(windowBounds_.bottom - windowBounds_.top)));
      window.Set("bounds", bounds);
      result.Set("window", window);
    }
    Napi::Array elements = Napi::Array::New(env, elements_.size());
    for (size_t i = 0; i < elements_.size(); i += 1) {
      const ElementFact& fact = elements_[i];
      Napi::Object item = Napi::Object::New(env);
      item.Set("index", Napi::Number::New(env, fact.index));
      item.Set("depth", Napi::Number::New(env, fact.depth));
      item.Set("role", Napi::String::New(env, fact.role));
      item.Set("name", Napi::String::New(env, fact.name));
      if (fact.hasValue) {
        item.Set("value", Napi::String::New(env, fact.value));
      } else {
        item.Set("value", env.Null());
      }
      item.Set("valueLength", Napi::Number::New(env, fact.valueLength));
      if (fact.hasBounds) {
        Napi::Object bounds = Napi::Object::New(env);
        bounds.Set("x", Napi::Number::New(env, static_cast<double>(fact.bounds.left)));
        bounds.Set("y", Napi::Number::New(env, static_cast<double>(fact.bounds.top)));
        bounds.Set("width", Napi::Number::New(env, static_cast<double>(fact.bounds.right - fact.bounds.left)));
        bounds.Set("height", Napi::Number::New(env, static_cast<double>(fact.bounds.bottom - fact.bounds.top)));
        item.Set("bounds", bounds);
      } else {
        item.Set("bounds", env.Null());
      }
      Napi::Array patterns = Napi::Array::New(env, fact.patterns.size());
      for (size_t p = 0; p < fact.patterns.size(); p += 1) {
        patterns.Set(static_cast<uint32_t>(p), Napi::String::New(env, fact.patterns[p]));
      }
      item.Set("patterns", patterns);
      elements.Set(static_cast<uint32_t>(i), item);
    }
    result.Set("elements", elements);
    result.Set("truncated", Napi::Boolean::New(env, truncated_));
    result.Set("totalElements", Napi::Number::New(env, totalElements_));
    return result;
  }

 private:
  DWORD pid_;
  uint32_t windowToken_;
  int maxElements_;
  long long maxTextBytes_;
  DWORD deadlineOverrideMs_;
  // 结果事实（Execute → BuildResult 同线程可见性由 AsyncWorker 时序保证）。
  uint32_t stateToken_ = 0;
  bool noWindow_ = false;
  bool truncated_ = false;
  int totalElements_ = 0;
  uint32_t windowTokenOut_ = 0;
  std::wstring windowTitle_;
  RECT windowBounds_{};
  std::vector<ElementFact> elements_;
};

void CaptureUiTreeWorker::Execute() {
  // stop 非闩锁（§10.6/§18 第 6 条同律）：新观察在入口清零取消旗标。
  g_cancelRequested.store(false);
  // 统一 preflight 门（§10.9：A3 的 UIA 读走同一门——非交互桌面整体诚实拒绝）。
  if (!DetectInteractiveDesktop() || DetectSessionZero() || !g_dpiAware.load()) {
    FailAx(kNonInteractiveDesktop, false);
    return;
  }

  auto taskState = std::make_shared<TreeTaskState>();
  auto slot = std::make_shared<UiaTaskSlot>();
  // weak 引用（body 捕获 slot 的 shared_ptr 会成环泄漏）：等待方离开（取消/超时毒化）后
  // body 的提交前检查以 expired-or-abandoned 判定。
  const std::weak_ptr<UiaTaskSlot> weakSlot = slot;
  const DWORD pid = pid_;
  const uint32_t windowToken = windowToken_;
  const int maxElements = maxElements_;
  const long long maxTextBytes = maxTextBytes_;

  slot->body = [taskState, weakSlot, pid, windowToken, maxElements, maxTextBytes] {
    const auto abandoned = [&weakSlot] {
      const auto pinned = weakSlot.lock();
      return !pinned || pinned->abandoned.load();
    };
    // 任务开始时的 worker 代——提交进注册表的冻结域归属该代（poison 后孤儿代查找即
    // stale fail-closed，绝不跨代触碰 COM 指针，§11.1/§11.5）。
    const uint64_t generation = UiaWorkerGeneration();

    // ── 窗口选择（§11.2 钉死规则）──
    HWND target = nullptr;
    uint32_t resultToken = 0;
    if (windowToken != 0) {
      WindowIdentity identity;
      if (!ResolveWindowToken(windowToken, identity)) {
        taskState->errorCode = kStale;  // 失效 token → element_unavailable，绝不回退最前窗口
        return;
      }
      // token 与 app_ref 归属复核：宿主 pid 相等，或 AFH 承载修正后相等；不符 → stale。
      DWORD hostPid = 0;
      GetWindowThreadProcessId(identity.hwnd, &hostPid);
      bool owned = hostPid == pid;
      if (!owned && IsApplicationFrameHostPid(hostPid)) {
        owned = ResolveFrameHostedAppPid(identity.hwnd) == pid;
      }
      if (!owned) {
        taskState->errorCode = kStale;
        return;
      }
      target = identity.hwnd;
      resultToken = windowToken;
    } else {
      const std::vector<TopLevelWindowFact> facts = EnumerateVisibleTopLevelWindows();
      const TopLevelWindowFact* chosen = nullptr;
      const DWORD foreground = CorrectedForegroundPid();
      if (foreground == pid) {
        const HWND foregroundHwnd = GetForegroundWindow();
        for (const TopLevelWindowFact& fact : facts) {
          if (fact.pid == pid && fact.hwnd == foregroundHwnd) {
            chosen = &fact;
            break;
          }
        }
      }
      if (!chosen) {
        // Z 序最顶**非最小化**可见窗口优先（确定性规则，§11.2；A3 实现批次细化：最小化
        // 窗口居首会让树根 IsOffscreen → 动作面恒 stale、截图恒 capture_minimized——
        // 非最小化优先是「可观察窗口」语义的诚实落地，spec 回写登记）。
        for (const TopLevelWindowFact& fact : facts) {
          if (fact.pid == pid && !fact.minimized) {
            chosen = &fact;
            break;
          }
        }
      }
      if (!chosen) {
        for (const TopLevelWindowFact& fact : facts) {
          if (fact.pid == pid) {
            chosen = &fact;  // 全部最小化：仍选 Z 序顶（capture 报 capture_minimized，诚实）
            break;
          }
        }
      }
      if (!chosen) {
        taskState->noWindow = true;  // 进程存活但无可观察窗口（JS → 专属字面量，§11.2）
        return;
      }
      target = chosen->hwnd;
      resultToken =
          RegisterWindowToken(target, chosen->hostPid, QueryProcessExePath(chosen->hostPid));
    }

    wchar_t title[513];
    const int titleLength = GetWindowTextW(target, title, 513);
    taskState->windowTitle.assign(title, titleLength > 0 ? static_cast<size_t>(titleLength) : 0);
    GetWindowRect(target, &taskState->windowBounds);
    taskState->windowToken = resultToken;

    // ── UIA 遍历（预算感知采集 + 全量计数；元素粒度 cancel/deadline 自查由等待方毒化
    // 兜底，任务体自查取消旗，§11.1）──
    IUIAutomation* automation = AcquireUiaAutomation();
    if (!automation) {
      taskState->errorCode = kInternalNative;
      return;
    }
    winrt::com_ptr<IUIAutomationCacheRequest> cacheRequest;
    if (FAILED(automation->CreateCacheRequest(cacheRequest.put())) || !cacheRequest) {
      taskState->errorCode = kInternalNative;
      return;
    }
    // 单次跨进程往返拿全属性（CacheRequest 机制）：逐属性 CurrentX 对大树是不可接受的
    // IPC 放大——UIA 跨进程调用可被无响应目标挂死，往返次数就是挂死面。
    cacheRequest->AddProperty(UIA_ControlTypePropertyId);
    cacheRequest->AddProperty(UIA_NamePropertyId);
    cacheRequest->AddProperty(UIA_BoundingRectanglePropertyId);
    cacheRequest->AddProperty(UIA_IsKeyboardFocusablePropertyId);
    cacheRequest->AddProperty(UIA_ValueValuePropertyId);
    cacheRequest->AddProperty(UIA_ValueIsReadOnlyPropertyId);
    cacheRequest->AddProperty(UIA_ExpandCollapseExpandCollapseStatePropertyId);
    cacheRequest->AddPattern(UIA_InvokePatternId);
    cacheRequest->AddPattern(UIA_TogglePatternId);
    cacheRequest->AddPattern(UIA_ExpandCollapsePatternId);
    cacheRequest->AddPattern(UIA_SelectionItemPatternId);
    cacheRequest->AddPattern(UIA_ValuePatternId);
    cacheRequest->AddPattern(UIA_TextPatternId);
    cacheRequest->AddPattern(UIA_ScrollPatternId);

    winrt::com_ptr<IUIAutomationElement> root;
    if (FAILED(automation->ElementFromHandleBuildCache(target, cacheRequest.get(), root.put())) ||
        !root) {
      taskState->errorCode = kInternalNative;  // UIA 拒绝（更高完整性级别目标等）——诚实失败
      return;
    }
    winrt::com_ptr<IUIAutomationCondition> controlView;
    automation->get_ControlViewCondition(controlView.put());
    winrt::com_ptr<IUIAutomationTreeWalker> walker;
    if (!controlView ||
        FAILED(automation->CreateTreeWalker(controlView.get(), walker.put())) || !walker) {
      taskState->errorCode = kInternalNative;
      return;
    }

    bool budgetHit = false;
    bool canceled = false;
    long long estimatedBytes = 0;
    int total = 0;

    // 递归 DFS（document order = 遍历序，§11.4 索引稳定性契约）；深度 cap 128。
    std::function<bool(IUIAutomationElement*, int)> visit =
        [&](IUIAutomationElement* element, int depth) -> bool {
      if (g_cancelRequested.load() || abandoned()) {
        canceled = true;
        return false;
      }
      total += 1;
      if (!budgetHit) {
        ElementFact fact;
        fact.index = static_cast<int>(taskState->elements.size());
        fact.depth = depth;
        CONTROLTYPEID controlType = 0;
        element->get_CachedControlType(&controlType);
        fact.role = RoleNameForControlType(controlType);
        BSTR name = nullptr;
        if (SUCCEEDED(element->get_CachedName(&name)) && name) {
          fact.name = Utf8FromWide(SanitizeText(name, SysStringLen(name)));
          SysFreeString(name);
        }
        VARIANT value;
        VariantInit(&value);
        if (SUCCEEDED(element->GetCachedPropertyValue(UIA_ValueValuePropertyId, &value)) &&
            value.vt == VT_BSTR && value.bstrVal) {
          fact.valueLength = static_cast<int>(SysStringLen(value.bstrVal));
          fact.hasValue = true;
          fact.value = Utf8FromWide(SanitizeText(value.bstrVal, SysStringLen(value.bstrVal)));
        }
        VariantClear(&value);
        RECT elementBounds{};
        if (SUCCEEDED(element->get_CachedBoundingRectangle(&elementBounds)) &&
            elementBounds.right > elementBounds.left && elementBounds.bottom > elementBounds.top) {
          fact.hasBounds = true;
          fact.bounds = elementBounds;
        }
        // patterns 注记 = 元素广告的动作词汇（§11.4：只广告真实存在的动作——模型
        // 「do not guess one」的供给侧对偶）。
        winrt::com_ptr<IUIAutomationInvokePattern> invokePattern;
        if (SUCCEEDED(element->GetCachedPatternAs(UIA_InvokePatternId,
                                                  IID_PPV_ARGS(&invokePattern))) &&
            invokePattern) {
          fact.patterns.emplace_back("invokable");
        }
        winrt::com_ptr<IUIAutomationTogglePattern> togglePattern;
        if (SUCCEEDED(element->GetCachedPatternAs(UIA_TogglePatternId,
                                                  IID_PPV_ARGS(&togglePattern))) &&
            togglePattern) {
          fact.patterns.emplace_back("toggleable");
        }
        winrt::com_ptr<IUIAutomationExpandCollapsePattern> expandPattern;
        if (SUCCEEDED(element->GetCachedPatternAs(UIA_ExpandCollapsePatternId,
                                                  IID_PPV_ARGS(&expandPattern))) &&
            expandPattern) {
          VARIANT state;
          VariantInit(&state);
          ExpandCollapseState expandState = ExpandCollapseState_LeafNode;
          if (SUCCEEDED(element->GetCachedPropertyValue(UIA_ExpandCollapseExpandCollapseStatePropertyId,
                                                        &state)) &&
              state.vt == VT_I4) {
            expandState = static_cast<ExpandCollapseState>(state.lVal);
          }
          VariantClear(&state);
          // 状态精确广告（§11.2 perform_action 的 expand/collapse 分支依据）。
          if (expandState == ExpandCollapseState_Collapsed) fact.patterns.emplace_back("expandable");
          if (expandState == ExpandCollapseState_Expanded) fact.patterns.emplace_back("collapsible");
          if (expandState == ExpandCollapseState_PartiallyExpanded) {
            fact.patterns.emplace_back("expandable");
            fact.patterns.emplace_back("collapsible");
          }
        }
        winrt::com_ptr<IUIAutomationSelectionItemPattern> selectionPattern;
        if (SUCCEEDED(element->GetCachedPatternAs(UIA_SelectionItemPatternId,
                                                  IID_PPV_ARGS(&selectionPattern))) &&
            selectionPattern) {
          fact.patterns.emplace_back("selectable");
        }
        winrt::com_ptr<IUIAutomationValuePattern> valuePattern;
        if (SUCCEEDED(element->GetCachedPatternAs(UIA_ValuePatternId,
                                                  IID_PPV_ARGS(&valuePattern))) &&
            valuePattern) {
          VARIANT readOnly;
          VariantInit(&readOnly);
          bool editable = true;
          if (SUCCEEDED(element->GetCachedPropertyValue(UIA_ValueIsReadOnlyPropertyId,
                                                        &readOnly)) &&
              readOnly.vt == VT_BOOL) {
            editable = readOnly.boolVal == VARIANT_FALSE;
          }
          VariantClear(&readOnly);
          if (editable) fact.patterns.emplace_back("editable");
        }
        winrt::com_ptr<IUIAutomationTextPattern> textPattern;
        if (SUCCEEDED(element->GetCachedPatternAs(UIA_TextPatternId,
                                                  IID_PPV_ARGS(&textPattern))) &&
            textPattern) {
          fact.patterns.emplace_back("text-selectable");
        }
        winrt::com_ptr<IUIAutomationScrollPattern> scrollPattern;
        if (SUCCEEDED(element->GetCachedPatternAs(UIA_ScrollPatternId,
                                                  IID_PPV_ARGS(&scrollPattern))) &&
            scrollPattern) {
          fact.patterns.emplace_back("scrollable");
        }
        BOOL focusable = FALSE;
        if (SUCCEEDED(element->get_CachedIsKeyboardFocusable(&focusable)) && focusable) {
          fact.patterns.emplace_back("focusable");
        }

        // 预算估算（§11.4：≤3000 行 ∧ ≤256 KiB——按渲染行 UTF-8 字节保守估算）。
        long long patternBytes = 0;
        for (const std::string& pattern : fact.patterns) patternBytes += static_cast<long long>(pattern.size()) + 2;
        estimatedBytes += 12 + 2LL * depth + static_cast<long long>(fact.role.size()) +
                          static_cast<long long>(fact.name.size()) +
                          static_cast<long long>(fact.value.size()) + patternBytes;

        const bool overBudget =
            static_cast<int>(taskState->elements.size()) >= maxElements ||
            estimatedBytes >= maxTextBytes;
        if (overBudget) {
          budgetHit = true;  // 本元素不采集（文本可见 index ⇔ 注册表可解析的同集合截断）
        } else {
          std::vector<int> runtimeId = RuntimeIdVector(element);
          IUIAutomationElement* frozen = element;
          frozen->AddRef();  // 冻结域所有权（Release 配对在注册表，§11.5）
          taskState->frozen.push_back(frozen);
          taskState->runtimeIds.push_back(std::move(runtimeId));
          taskState->elements.push_back(std::move(fact));
        }
      }
      if (depth >= kMaxTreeDepth) return true;  // 深度 cap：子树不枚举（计数如实至 cap）
      winrt::com_ptr<IUIAutomationElement> child;
      if (budgetHit) {
        walker->GetFirstChildElement(element, child.put());
      } else {
        walker->GetFirstChildElementBuildCache(element, cacheRequest.get(), child.put());
      }
      while (child) {
        if (!visit(child.get(), depth + 1)) return false;
        winrt::com_ptr<IUIAutomationElement> next;
        if (budgetHit) {
          walker->GetNextSiblingElement(child.get(), next.put());
        } else {
          walker->GetNextSiblingElementBuildCache(child.get(), cacheRequest.get(), next.put());
        }
        child = next;
      }
      return true;
    };

    visit(root.get(), 0);

    if (canceled || abandoned()) {
      // 等待方已按 canceled/timeout 收口：不提交冻结域，释放已采集引用（零泄漏）。
      for (IUIAutomationElement* element : taskState->frozen) {
        if (element) element->Release();
      }
      taskState->frozen.clear();
      taskState->runtimeIds.clear();
      if (!canceled) taskState->errorCode = kUiaTimeout;  // abandoned 而未见取消旗 = 超时毒化
      return;
    }
    taskState->truncated = budgetHit;
    taskState->totalElements = total;
    taskState->stateToken = CommitFrozenElements(std::move(taskState->frozen),
                                                 std::move(taskState->runtimeIds), generation);
  };

  const DWORD deadline = deadlineOverrideMs_ > 0 ? deadlineOverrideMs_ : kObserveDeadlineMs;
  const UiaTaskOutcome outcome = RunUiaTask(slot, deadline, /*cancelable=*/true);
  switch (outcome) {
    case UiaTaskOutcome::completed:
      break;
    case UiaTaskOutcome::canceled:
      FailAx(kCanceled, false);  // 只读观察被 stop 中断（driver 归类 Rejected → controller_busy）
      return;
    case UiaTaskOutcome::timed_out:
      FailAx(kUiaTimeout, false);  // 只读 → ok:false timeout（重试安全，§11.1 分流）
      return;
    case UiaTaskOutcome::internal:
      FailAx(kInternalNative, false);
      return;
  }
  if (taskState->errorCode) {
    FailAx(taskState->errorCode, false);
    return;
  }
  noWindow_ = taskState->noWindow;
  windowTokenOut_ = taskState->windowToken;
  windowTitle_ = std::move(taskState->windowTitle);
  windowBounds_ = taskState->windowBounds;
  elements_ = std::move(taskState->elements);
  truncated_ = taskState->truncated;
  totalElements_ = taskState->totalElements;
  stateToken_ = taskState->stateToken;
  if (noWindow_) {
    // 0 窗口也是「成功观察」的一种诚实结果形态（JS 产专属字面量失败——进程存活但无
    // 可观察窗口，与「not running」的指引不同，§11.2）；BuildResult 的 window=null 承载。
    return;
  }
  windowToken_ = windowTokenOut_;
}

// ── listApplications worker ───────────────────────────────────────────────────
class ListApplicationsWorker final : public PromiseWorker {
 public:
  explicit ListApplicationsWorker(const Napi::Env& env) : PromiseWorker(env) {}

 protected:
  void Execute() override {
    g_cancelRequested.store(false);
    if (!DetectInteractiveDesktop() || DetectSessionZero() || !g_dpiAware.load()) {
      FailAx(kNonInteractiveDesktop, false);
      return;
    }
    auto taskState = std::make_shared<std::vector<AppFact>>();
    auto slot = std::make_shared<UiaTaskSlot>();
    const std::weak_ptr<UiaTaskSlot> weakSlot = slot;
    slot->body = [taskState, weakSlot] {
      const std::vector<TopLevelWindowFact> facts = EnumerateVisibleTopLevelWindows();
      const DWORD foreground = CorrectedForegroundPid();
      // pid 去重聚合（app 集合 = 有 ≥1 个可见顶层窗口的进程，含 shell——如实列出，§11.2）。
      std::map<DWORD, AppFact> grouped;
      for (const TopLevelWindowFact& fact : facts) {
        AppFact& app = grouped[fact.pid];
        if (app.pid == 0) {
          app.pid = fact.pid;
          app.exePath = QueryProcessExePath(fact.pid);  // 不可读 → 空串（诚实事实，模型可用 pid）
        }
        app.windowCount += 1;
        if (app.aumid.empty() && !fact.aumid.empty()) app.aumid = fact.aumid;
      }
      for (auto& entry : grouped) {
        entry.second.active = entry.first == foreground;
        taskState->push_back(entry.second);
      }
      std::sort(taskState->begin(), taskState->end(),
                [](const AppFact& a, const AppFact& b) { return a.pid < b.pid; });
      const auto pinned = weakSlot.lock();
      if (!pinned || pinned->abandoned.load()) taskState->clear();
    };
    const UiaTaskOutcome outcome = RunUiaTask(slot, kObserveDeadlineMs, /*cancelable=*/true);
    if (outcome == UiaTaskOutcome::canceled) {
      FailAx(kCanceled, false);
      return;
    }
    if (outcome == UiaTaskOutcome::timed_out) {
      FailAx(kUiaTimeout, false);
      return;
    }
    if (outcome == UiaTaskOutcome::internal) {
      FailAx(kInternalNative, false);
      return;
    }
    apps_ = std::move(*taskState);
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Array apps = Napi::Array::New(env, apps_.size());
    for (size_t i = 0; i < apps_.size(); i += 1) {
      const AppFact& app = apps_[i];
      Napi::Object item = Napi::Object::New(env);
      item.Set("pid", Napi::Number::New(env, static_cast<double>(app.pid)));
      item.Set("exePath",
               Napi::String::New(env, reinterpret_cast<const char16_t*>(app.exePath.c_str()),
                                 app.exePath.size()));
      if (app.aumid.empty()) {
        item.Set("aumid", env.Null());
      } else {
        item.Set("aumid", Napi::String::New(env, reinterpret_cast<const char16_t*>(app.aumid.c_str()),
                                            app.aumid.size()));
      }
      // displayName best-effort（oQ11）：A3 v1 恒 null——name 落 exe basename（JS 侧派生），
      // 不猜测本地化显示名（能力真实性：宁缺勿假）。
      item.Set("displayName", env.Null());
      item.Set("windowCount", Napi::Number::New(env, app.windowCount));
      item.Set("active", Napi::Boolean::New(env, app.active));
      apps.Set(static_cast<uint32_t>(i), item);
    }
    Napi::Object result = Napi::Object::New(env);
    result.Set("apps", apps);
    return result;
  }

 private:
  std::vector<AppFact> apps_;
};

// ── listWindows worker ────────────────────────────────────────────────────────
class ListWindowsWorker final : public PromiseWorker {
 public:
  ListWindowsWorker(const Napi::Env& env, DWORD pidFilter)
      : PromiseWorker(env), pidFilter_(pidFilter) {}

 protected:
  void Execute() override {
    g_cancelRequested.store(false);
    if (!DetectInteractiveDesktop() || DetectSessionZero() || !g_dpiAware.load()) {
      FailAx(kNonInteractiveDesktop, false);
      return;
    }
    auto taskState = std::make_shared<std::vector<WindowFactOut>>();
    auto slot = std::make_shared<UiaTaskSlot>();
    const std::weak_ptr<UiaTaskSlot> weakSlot = slot;
    const DWORD pidFilter = pidFilter_;
    slot->body = [taskState, weakSlot, pidFilter] {
      const std::vector<TopLevelWindowFact> facts = EnumerateVisibleTopLevelWindows();
      std::map<DWORD, std::wstring> exeCache;
      for (const TopLevelWindowFact& fact : facts) {
        if (pidFilter != 0 && fact.pid != pidFilter) continue;
        WindowFactOut out;
        auto cached = exeCache.find(fact.hostPid);
        if (cached == exeCache.end()) {
          cached = exeCache.emplace(fact.hostPid, QueryProcessExePath(fact.hostPid)).first;
        }
        out.windowId = RegisterWindowToken(fact.hwnd, fact.hostPid, cached->second);
        out.title = fact.title;
        out.pid = fact.pid;
        auto appCached = exeCache.find(fact.pid);
        if (appCached == exeCache.end()) {
          appCached = exeCache.emplace(fact.pid, QueryProcessExePath(fact.pid)).first;
        }
        out.exePath = appCached->second;
        out.bounds = fact.bounds;
        out.minimized = fact.minimized;
        taskState->push_back(std::move(out));
      }
      const auto pinned = weakSlot.lock();
      if (!pinned || pinned->abandoned.load()) taskState->clear();
    };
    const UiaTaskOutcome outcome = RunUiaTask(slot, kObserveDeadlineMs, /*cancelable=*/true);
    if (outcome == UiaTaskOutcome::canceled) {
      FailAx(kCanceled, false);
      return;
    }
    if (outcome == UiaTaskOutcome::timed_out) {
      FailAx(kUiaTimeout, false);
      return;
    }
    if (outcome == UiaTaskOutcome::internal) {
      FailAx(kInternalNative, false);
      return;
    }
    windows_ = std::move(*taskState);
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Array windows = Napi::Array::New(env, windows_.size());
    for (size_t i = 0; i < windows_.size(); i += 1) {
      const WindowFactOut& fact = windows_[i];
      Napi::Object item = Napi::Object::New(env);
      item.Set("windowId", Napi::Number::New(env, static_cast<double>(fact.windowId)));
      // title 是用户内容：只进 wire 结果（产品面），JS 侧再截 512；绝不进日志/错误文本。
      const std::wstring truncated = fact.title.size() > kCollectMaxCodeUnits
                                         ? fact.title.substr(0, kCollectMaxCodeUnits)
                                         : fact.title;
      item.Set("title", Napi::String::New(env, reinterpret_cast<const char16_t*>(truncated.c_str()),
                                          truncated.size()));
      item.Set("pid", Napi::Number::New(env, static_cast<double>(fact.pid)));
      item.Set("exePath", Napi::String::New(env,
                                            reinterpret_cast<const char16_t*>(fact.exePath.c_str()),
                                            fact.exePath.size()));
      Napi::Object bounds = Napi::Object::New(env);
      bounds.Set("x", Napi::Number::New(env, static_cast<double>(fact.bounds.left)));
      bounds.Set("y", Napi::Number::New(env, static_cast<double>(fact.bounds.top)));
      bounds.Set("width",
                 Napi::Number::New(env, static_cast<double>(fact.bounds.right - fact.bounds.left)));
      bounds.Set("height",
                 Napi::Number::New(env, static_cast<double>(fact.bounds.bottom - fact.bounds.top)));
      item.Set("bounds", bounds);
      item.Set("minimized", Napi::Boolean::New(env, fact.minimized));
      windows.Set(static_cast<uint32_t>(i), item);
    }
    Napi::Object result = Napi::Object::New(env);
    result.Set("windows", windows);
    return result;
  }

 private:
  DWORD pidFilter_;
  std::vector<WindowFactOut> windows_;
};

// ── releaseStateToken / uiaWorkerStats ────────────────────────────────────────
class ReleaseStateWorker final : public PromiseWorker {
 public:
  ReleaseStateWorker(const Napi::Env& env, uint32_t token) : PromiseWorker(env), token_(token) {}

 protected:
  void Execute() override {
    auto slot = std::make_shared<UiaTaskSlot>();
    const uint32_t token = token_;
    slot->body = [token] { ReleaseFrozenState(token); };
    // 释放是 registry 维护操作：短预算、不可取消（取消会泄漏冻结引用）。
    const UiaTaskOutcome outcome = RunUiaTask(slot, kPatternDeadlineMs, /*cancelable=*/false);
    if (outcome == UiaTaskOutcome::timed_out) FailAx(kUiaTimeout, false);
    if (outcome == UiaTaskOutcome::internal) FailAx(kInternalNative, false);
    // canceled 结构性不可达（cancelable=false）。
  }

 private:
  uint32_t token_;
};

class WorkerStatsWorker final : public PromiseWorker {
 public:
  explicit WorkerStatsWorker(const Napi::Env& env) : PromiseWorker(env) {}

 protected:
  // 纯原子/锁读事实，无 COM 调用——不经 UIA worker（统计面在 worker 挂死时必须可用，
  // 这正是它的用途：JS 监督据此触发 ≥3 自终结，§11.1）。
  void Execute() override {
    poisoned_ = UiaPoisonedCount();
    generation_ = UiaWorkerGeneration();
  }

  Napi::Value BuildResult(const Napi::Env& env) override {
    Napi::Object result = Napi::Object::New(env);
    result.Set("poisoned", Napi::Number::New(env, static_cast<double>(poisoned_)));
    result.Set("generation", Napi::Number::New(env, static_cast<double>(generation_)));
    return result;
  }

 private:
  uint32_t poisoned_ = 0;
  uint64_t generation_ = 0;
};

}  // namespace

Napi::Value ListApplications(const Napi::CallbackInfo& info) {
  auto* worker = new ListApplicationsWorker(info.Env());
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value ListWindows(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  DWORD pidFilter = 0;  // 0 = 不过滤（全量）
  if (info.Length() >= 1 && info[0].IsNumber()) {
    const double value = info[0].As<Napi::Number>().DoubleValue();
    if (!(value >= 1) || value > 0xFFFFFFFF || value != std::floor(value)) {
      return RejectedPromise(env, "listWindows pid must be a positive integer or null");
    }
    pidFilter = static_cast<DWORD>(value);
  } else if (info.Length() >= 1 && !info[0].IsNull() && !info[0].IsUndefined()) {
    return RejectedPromise(env, "listWindows pid must be a positive integer or null");
  }
  auto* worker = new ListWindowsWorker(env, pidFilter);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value CaptureUiTree(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsObject()) {
    return RejectedPromise(env, "captureUiTree requires a target object and a budget object");
  }
  const Napi::Object target = info[0].As<Napi::Object>();
  if (!target.Has("pid") || !target.Get("pid").IsNumber()) {
    return RejectedPromise(env, "captureUiTree target requires a numeric pid");
  }
  const double pidValue = target.Get("pid").As<Napi::Number>().DoubleValue();
  if (!(pidValue >= 1) || pidValue > 0xFFFFFFFF || pidValue != std::floor(pidValue)) {
    return RejectedPromise(env, "captureUiTree pid must be a positive integer");
  }
  uint32_t windowToken = 0;
  if (target.Has("windowId") && !target.Get("windowId").IsUndefined() &&
      !target.Get("windowId").IsNull()) {
    if (!target.Get("windowId").IsNumber()) {
      return RejectedPromise(env, "captureUiTree windowId must be a number");
    }
    const double token = target.Get("windowId").As<Napi::Number>().DoubleValue();
    if (!(token >= 1) || token > 0xFFFFFFFF || token != std::floor(token)) {
      return RejectedPromise(env, "captureUiTree windowId must be a positive integer");
    }
    windowToken = static_cast<uint32_t>(token);
  }
  const Napi::Object budget = info[1].As<Napi::Object>();
  if (!budget.Has("maxElements") || !budget.Get("maxElements").IsNumber() ||
      !budget.Has("maxTextBytes") || !budget.Get("maxTextBytes").IsNumber()) {
    return RejectedPromise(env, "captureUiTree budget requires maxElements and maxTextBytes");
  }
  const double maxElements = budget.Get("maxElements").As<Napi::Number>().DoubleValue();
  const double maxTextBytes = budget.Get("maxTextBytes").As<Napi::Number>().DoubleValue();
  if (!(maxElements >= 1) || maxElements > 100000 || maxElements != std::floor(maxElements)) {
    return RejectedPromise(env, "captureUiTree maxElements is out of range");
  }
  if (!(maxTextBytes >= 1024) || maxTextBytes > 64.0 * 1024 * 1024 ||
      maxTextBytes != std::floor(maxTextBytes)) {
    return RejectedPromise(env, "captureUiTree maxTextBytes is out of range");
  }
  // deadlineMs 覆写仅供测试/自检（生产 handler 恒传 undefined → native 缺省 8s，§11.1）。
  DWORD deadlineOverride = 0;
  if (info.Length() >= 3 && info[2].IsNumber()) {
    const double override = info[2].As<Napi::Number>().DoubleValue();
    if (!(override >= 1) || override > 600000 || override != std::floor(override)) {
      return RejectedPromise(env, "captureUiTree deadlineMs override is out of range");
    }
    deadlineOverride = static_cast<DWORD>(override);
  }
  auto* worker = new CaptureUiTreeWorker(env, static_cast<DWORD>(pidValue), windowToken,
                                         static_cast<int>(maxElements),
                                         static_cast<long long>(maxTextBytes), deadlineOverride);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value ReleaseStateToken(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    return RejectedPromise(env, "releaseStateToken requires a numeric token");
  }
  const double token = info[0].As<Napi::Number>().DoubleValue();
  if (!(token >= 1) || token > 0xFFFFFFFF || token != std::floor(token)) {
    return RejectedPromise(env, "releaseStateToken requires a positive integer token");
  }
  auto* worker = new ReleaseStateWorker(env, static_cast<uint32_t>(token));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value UiaWorkerStats(const Napi::CallbackInfo& info) {
  auto* worker = new WorkerStatsWorker(info.Env());
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

}  // namespace ax
