// ACode 原创（specs/windows-helper-producer.md §11.1）。
// UIA 专属常驻 MTA worker：全部 UIA COM（IUIAutomation 及元素/pattern 调用）只在一个
// CoInitializeEx(COINIT_MULTITHREADED) 的专属 std::thread 上执行；JS 主线程只经
// Promise/AsyncWorker 收结果。COM 接口指针绝不过线程边界（冻结元素引用留在 native
// 注册表，JS 只持不透明 token）。
//
// 任务模型：FIFO 队列 + 每任务 deadline + 全局取消旗（g_cancelRequested 与 §10.6 同源）。
//
// 卡死隔离（poison-detach-rebuild，§11.1 钉死）：deadline 到期**不等 COM 返回**——把
// worker 标记 poisoned、detach 线程（COM 挂死线程不可安全 kill，泄漏它并如实登记）、
// 本次调用以 uia_timeout 失败、下一次调用 spawn Replacement worker。poisoned 累计 ≥3 →
// JS 侧监督（uia-driver.ts）触发 Helper 自终结（internal-helper-failure + exit 1，既有
// 封闭表、零新增失败类别；自终结先经 §10.4 规则 3 统一释放收口）。
//
// 取消语义（A3 实现批次裁决，spec §11.1「单 pattern 调用不可中断」的具体化）：
// - 只读观察任务（cancelable）：等待方见取消旗即离开，任务体在元素粒度自查取消后
//   中止且不提交结果（abandoned 检查）；
// - 变更类 pattern 任务（非 cancelable）：单个原子 COM 调用不可中断——等到 deadline 内
//   报真实结果，绝不提前弃等谎称「确定未派发」（delivery-state 铁律 1 的 native 侧对偶）。
#include "ax_internal.h"

#include <objbase.h>  // WIN32_LEAN_AND_MEAN 排除 ole2 系——COM 前置依赖显式引入
#include <uiautomationclient.h>

#include <condition_variable>
#include <deque>
#include <thread>

namespace ax {
namespace {

std::mutex g_uiaMutex;
std::condition_variable g_uiaCv;
std::deque<std::shared_ptr<UiaTaskSlot>> g_uiaQueue;
uint64_t g_uiaGeneration = 0;      // g_uiaMutex 保护
bool g_uiaThreadRunning = false;   // g_uiaMutex 保护（线程本体 spawn 即 detach，不持句柄——
                                   // joinable 静态 std::thread 在进程退出静态析构时
                                   // std::terminate，见 EnsureWorkerLocked 注释）
std::atomic<uint32_t> g_uiaPoisoned{0};
// 协作式停止旗（A3 评审修复 CUA-A3-SHUTDOWN-CRASH）：进程退出前经 uiaWorkerShutdown
// 置位并 notify——parked 的 worker 在 cv 谓词里看到停止旗后退出循环，teardown 期不留
// 线程触碰静态 cv/mutex。置位后不复活（本 addon 实例的进程正在退出；停止后到来的任务
// 由 spawn-即-detach + deadline 兜底诚实失败，绝不静默）。
std::atomic<bool> g_uiaStop{false};

// 每代 worker 线程一个 IUIAutomation 实例（thread_local——detached 孤儿线程的实例随
// 线程泄漏，与 §11.1 的泄漏登记一致；绝不跨代共享）。
thread_local IUIAutomation* t_uiaAutomation = nullptr;

void UiaThreadMain() {
  // MTA 初始化失败（进程已处于 STA 等异常）：线程直接退出——任务永远不完成，等待方
  // 以 deadline 收口（timed_out → poison → 重建再试；诚实失败，不带病执行）。
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {
    std::lock_guard<std::mutex> lock(g_uiaMutex);
    g_uiaThreadRunning = false;
    // 排队任务全部置 abandoned + 触发事件（等待方按 internal 收口）。
    for (auto& slot : g_uiaQueue) {
      slot->abandoned.store(true);
      if (slot->doneEvent) SetEvent(slot->doneEvent);
    }
    g_uiaQueue.clear();
    return;
  }
  for (;;) {
    std::shared_ptr<UiaTaskSlot> slot;
    {
      std::unique_lock<std::mutex> lock(g_uiaMutex);
      g_uiaCv.wait(lock, [] { return !g_uiaQueue.empty() || g_uiaStop.load(); });
      if (g_uiaStop.load()) break;  // 协作式停止：进程退出中，队列残项随进程消亡
      slot = g_uiaQueue.front();
      g_uiaQueue.pop_front();
    }
    // body 自捕获全部异常并写自己的结果字段（含 abandoned 检查——等待方离开后不提交
    // 冻结注册表等副作用）。event 由 slot 析构关闭（等待方与 worker 双持 shared_ptr，
    // SetEvent 恒对活句柄）。
    slot->body();
    if (slot->doneEvent) SetEvent(slot->doneEvent);
  }
  // 两个出口：协作式停止（正常退出路径，CoUninitialize 平衡公寓）或 poisoned 被 detach
  //（挂死在 COM 调用里，永不返回——泄漏如实登记，§11.1）。
  CoUninitialize();
}

// 调用方持锁：无活 worker 则起新一代。**spawn 即 detach**（评审修复：静态 std::thread
// 在正常路径永不 join/detach 时，process.exit 后 CRT 静态析构对 joinable 线程调
// std::terminate → 0xC0000409 fail-fast 覆盖退出码，破坏 §2.7 exit 0 契约——本 worker
// 设计上永不返回，joinable 状态没有任何收益，detach 是结构性正解；poison 路径的
// 「detach 泄漏挂死线程」语义不变）。
void EnsureWorkerLocked() {
  if (g_uiaThreadRunning) return;
  g_uiaGeneration += 1;
  std::thread worker(UiaThreadMain);
  worker.detach();
  g_uiaThreadRunning = true;
}

}  // namespace

IUIAutomation* AcquireUiaAutomation() {
  if (t_uiaAutomation) return t_uiaAutomation;
  IUIAutomation* automation = nullptr;
  const HRESULT hr = CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
                                      IID_IUIAutomation, reinterpret_cast<void**>(&automation));
  if (FAILED(hr) || !automation) return nullptr;
  t_uiaAutomation = automation;
  return t_uiaAutomation;
}

uint64_t UiaWorkerGeneration() {
  std::lock_guard<std::mutex> lock(g_uiaMutex);
  return g_uiaGeneration;
}

uint32_t UiaPoisonedCount() { return g_uiaPoisoned.load(); }

void StopUiaWorker() {
  // 协作式停止（同步、幂等）：置旗 + 广播——parked worker 立即退出循环；正在执行的任务
  // 跑完当前 body 后在下一轮谓词看到停止旗退出。调用方是 entry 的统一退出收口点
  //（windows-helper.ts exitConvergence，§10.4 规则 3），随后即 process.exit。
  g_uiaStop.store(true);
  g_uiaCv.notify_all();
}

UiaTaskOutcome RunUiaTask(const std::shared_ptr<UiaTaskSlot>& slot, DWORD deadlineMs,
                          bool cancelable) {
  slot->doneEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!slot->doneEvent) return UiaTaskOutcome::internal;
  {
    std::lock_guard<std::mutex> lock(g_uiaMutex);
    EnsureWorkerLocked();
    g_uiaQueue.push_back(slot);
  }
  g_uiaCv.notify_one();

  const ULONGLONG deadline = GetTickCount64() + deadlineMs;
  for (;;) {
    const DWORD wait = WaitForSingleObject(slot->doneEvent, 50);
    if (wait == WAIT_OBJECT_0) return UiaTaskOutcome::completed;
    if (cancelable && g_cancelRequested.load()) {
      // 只读观察：等待方离开；任务体元素粒度自查取消后中止、abandoned 检查杜绝提交。
      slot->abandoned.store(true);
      return UiaTaskOutcome::canceled;
    }
    if (GetTickCount64() >= deadline) {
      // poison-detach-rebuild（§11.1）：不等 COM 返回。（线程自 spawn 即 detached——
      // 挂死线程随进程消亡，泄漏如实登记；此处只需清 running 状态让下一代 spawn。）
      slot->abandoned.store(true);
      {
        std::lock_guard<std::mutex> lock(g_uiaMutex);
        g_uiaPoisoned.fetch_add(1);
        g_uiaThreadRunning = false;
        // admission 串行 ⇒ 队列通常为空；防御性清队（触发事件让潜在等待方按各自路径收口）。
        for (auto& queued : g_uiaQueue) {
          queued->abandoned.store(true);
          if (queued->doneEvent) SetEvent(queued->doneEvent);
        }
        g_uiaQueue.clear();
      }
      return UiaTaskOutcome::timed_out;
    }
  }
}

}  // namespace ax
