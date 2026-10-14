// ACode 原创（specs/windows-helper-producer.md §10.1/§10.3/§10.9）。
// 剪贴板写入面：clipboardWriteText（CF_UNICODETEXT + N-API async worker）。
// 机制预算对齐上游记载（windows-source-development.md:318-322）：独立 250ms 互斥预算、
// OpenClipboard 8×10ms 有界重试、文本上限 8 Mi UTF-16 code units。不使用 PowerShell、
// 外部命令或任何 fallback（决策一同律：能力面只有 Win32 一条合法路径）。
//
// 不导出 clipboardReadText：14 工具面无 read_clipboard，加导出 = 能力面溢出（§10.1
// 设计注记 4）；paste 的「恢复原剪贴板内容」也不做——paste 的契约就是写剪贴板，恢复会
// 与目标应用异步读剪贴板竞态（§10.9 剪贴板遗留 = 登记的产品副作用）。
//
// 失败分类（§10.3，全部确定未派发 → driver 归类 Rejected → ok:false）：
//   clipboard_busy   = 互斥预算耗尽（他进程占用剪贴板）→ wire controller_busy；
//   clipboard_denied = OpenClipboard 被拒且非互斥竞争（交互桌面异常）→ wire permission_denied。
// 判据说明：剪贴板被他进程打开时 OpenClipboard 同样报 ERROR_ACCESS_DENIED，无法单凭
// 错误码区分「竞争」与「拒绝」——故以预算耗尽为 busy；预算耗尽后再探交互桌面事实，
// 非交互 → denied（桌面异常）、交互 → busy（竞争）。方向保守且两者都是 ok:false 安全区。
#include "ax_internal.h"

#include <string>

namespace ax {
namespace {

constexpr DWORD kClipboardBudgetMs = 250;   // 互斥预算（上游机制同值）
constexpr int kClipboardOpenRetries = 8;    // OpenClipboard 有界重试次数
constexpr int kClipboardRetrySleepMs = 10;  // 重试间隔

class ClipboardWriteWorker final : public PromiseWorker {
 public:
  ClipboardWriteWorker(const Napi::Env& env, std::u16string text)
      : PromiseWorker(env), text_(std::move(text)) {}

 protected:
  void Execute() override {
    // 全局内存句柄所有权纪律：SetClipboardData 成功后归系统所有（绝不 GlobalFree）；
    // 任何失败路径由本 worker 释放。
    const SIZE_T bytes = (text_.size() + 1) * sizeof(wchar_t);
    HGLOBAL global = GlobalAlloc(GMEM_MOVEABLE, bytes);
    if (!global) {
      FailAx(kInternalNative, false);
      return;
    }
    {
      void* locked = GlobalLock(global);
      if (!locked) {
        GlobalFree(global);
        FailAx(kInternalNative, false);
        return;
      }
      memcpy(locked, text_.data(), text_.size() * sizeof(wchar_t));
      static_cast<wchar_t*>(locked)[text_.size()] = L'\0';
      GlobalUnlock(global);
    }

    const ULONGLONG startedAt = GetTickCount64();
    bool opened = false;
    for (int attempt = 0; attempt < kClipboardOpenRetries; attempt += 1) {
      if (OpenClipboard(nullptr)) {
        opened = true;
        break;
      }
      if (GetTickCount64() - startedAt >= kClipboardBudgetMs) break;
      Sleep(kClipboardRetrySleepMs);
    }
    if (!opened) {
      GlobalFree(global);
      // busy vs denied 判据见文件头注释：预算耗尽后探交互桌面事实。
      FailAx(DetectInteractiveDesktop() ? kClipboardBusy : kClipboardDenied, false);
      return;
    }

    const bool emptied = EmptyClipboard() != FALSE;
    bool stored = false;
    if (emptied) {
      stored = SetClipboardData(CF_UNICODETEXT, global) != nullptr;
    }
    CloseClipboard();
    if (!stored) {
      GlobalFree(global);  // SetClipboardData 失败 → 所有权仍在调用方
      // dispatchStarted=true：OpenClipboard/EmptyClipboard 已成功——原剪贴板内容已被清空
      // （副作用已发生、写入未完成 = 结果不可证），driver 归类 Ambiguous →
      // possibly_sent 收据（§10.12 铁律 1：派发启动后禁止 ok:false）。
      FailAx(kInternalNative, true);
    }
  }

 private:
  std::u16string text_;
};

}  // namespace

Napi::Value ClipboardWriteText(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    return RejectedPromise(env, "clipboardWriteText requires a text string");
  }
  const std::u16string text = info[0].As<Napi::String>().Utf16Value();
  // 8 Mi code units 上限（§10.1/§10.2）：wire 层 paste.text 已限同值；native 防御性同限。
  // 参数校验先于 OpenClipboard——超限拒绝面零剪贴板接触（§10.11 a2-native 用例表纪律）。
  if (text.size() > 8u * 1024u * 1024u) {
    return RejectedPromise(env, "clipboardWriteText text exceeds 8 Mi UTF-16 code units");
  }
  auto* worker = new ClipboardWriteWorker(env, std::move(text));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

}  // namespace ax
