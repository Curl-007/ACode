// ACode 原创（specs/windows-helper-producer.md §11.2/§11.3/§11.5）。
// 窗口枚举 / AUMID 解析 / AFH（ApplicationFrameHost）承载修正 / window token 注册表。
//
// 纪律：
// - window_id = 不透明整数 token（Helper 代内单调、不复用；使用前复验 IsWindow + 宿主
//   pid——HWND 复用/身份漂移 → 失效 → element_unavailable，绝不拿裸数值当 HWND 猜测）；
// - cloaked 窗口（DWM DWMWA_CLOAKED，UWP 挂起态等）过滤不列——列出来就是给模型假目标
//   （§11.2）；DWM 查询失败 → 按非 cloaked 处理（诚实枚举，不误滤）；
// - packaged app 归属修正（§11.3/§10.4 规则 2）：AFH frame 窗口经 PKEY_AppUserModel_ID +
//   子窗口/同 AUMID 顶层窗口双路径解析真实应用 pid，**唯一候选纪律**——0 或多候选 →
//   fail-closed（保持 AFH 归属/前台判负），绝不猜测；
// - token 注册表有界（4096 条，最旧逐出——被逐出 token 失效 → element_unavailable，
//   reobserve 语义正确）。
#include "ax_internal.h"

#include <dwmapi.h>
#include <objbase.h>  // WIN32_LEAN_AND_MEAN 排除 ole2 系——PROPVARIANT/COM 前置显式引入
#include <propkey.h>
#include <shellapi.h>  // SHGetPropertyStoreForWindow（LEAN_AND_MEAN 排除 shellapi，须显式引入）
#include <shobjidl.h>

#include <cstring>
#include <map>

namespace ax {
namespace {

std::mutex g_windowMutex;
uint32_t g_nextWindowToken = 0;
std::map<uint32_t, WindowIdentity> g_windowTokens;  // 有序 → begin() 即最旧 token
constexpr size_t kMaxWindowTokens = 4096;

bool IsCloakedWindow(HWND hwnd) {
  DWORD cloaked = 0;
  if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked)))) {
    return cloaked != 0;
  }
  return false;  // 查询失败 → 按非 cloaked 处理（诚实枚举）
}

std::wstring ExeBasenameLower(const std::wstring& exePath) {
  const size_t slash = exePath.find_last_of(L"\\/");
  std::wstring base = slash == std::wstring::npos ? exePath : exePath.substr(slash + 1);
  for (wchar_t& ch : base) ch = static_cast<wchar_t>(towlower(ch));
  return base;
}

}  // namespace

std::wstring QueryProcessExePath(DWORD pid) {
  if (pid == 0) return std::wstring();
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return std::wstring();
  // 32768 wchar 上界（QueryFullProcessImageNameW 长路径容量，foreground.cc 同由）。
  std::wstring buffer(32768, L'\0');
  DWORD size = static_cast<DWORD>(buffer.size());
  std::wstring result;
  if (QueryFullProcessImageNameW(process, 0, buffer.data(), &size) && size > 0) {
    result.assign(buffer.data(), size);
  }
  CloseHandle(process);
  return result;
}

std::wstring WindowAumid(HWND hwnd) {
  IPropertyStore* store = nullptr;
  if (FAILED(SHGetPropertyStoreForWindow(hwnd, IID_PPV_ARGS(&store))) || !store) {
    return std::wstring();
  }
  PROPVARIANT value;
  PropVariantInit(&value);
  std::wstring result;
  if (SUCCEEDED(store->GetValue(PKEY_AppUserModel_ID, &value)) && value.vt == VT_LPWSTR &&
      value.pwszVal) {
    result = value.pwszVal;
  }
  PropVariantClear(&value);
  store->Release();
  return result;
}

bool IsApplicationFrameHostPid(DWORD pid) {
  // 判据 = canonical exe basename（大小写不敏感）；进程不可读 → false（不猜）。
  return ExeBasenameLower(QueryProcessExePath(pid)) == L"applicationframedhost.exe";
}

DWORD ResolveFrameHostedAppPid(HWND frameHwnd) {
  const std::wstring aumid = WindowAumid(frameHwnd);
  if (aumid.empty()) return 0;  // 无 AUMID → 不可解析 → fail-closed
  DWORD framePid = 0;
  GetWindowThreadProcessId(frameHwnd, &framePid);
  if (framePid == 0) return 0;

  std::set<DWORD> candidates;
  struct Ctx {
    DWORD framePid;
    const std::wstring* aumid;
    std::set<DWORD>* out;
  };
  Ctx ctx{framePid, &aumid, &candidates};

  // 路径 ①：frame 的子窗口中的非-AFH pid（经典 UWP：应用的 CoreWindow 是 AFH 窗口的
  // 子窗口，属应用进程）。多候选由唯一性纪律兜底（注入性子窗口如 IME 会制造多候选 →
  // 判负 fail-closed，方向安全）。
  EnumChildWindows(
      frameHwnd,
      [](HWND child, LPARAM data) -> BOOL {
        auto* ctx = reinterpret_cast<Ctx*>(data);
        DWORD pid = 0;
        GetWindowThreadProcessId(child, &pid);
        if (pid != 0 && pid != ctx->framePid) ctx->out->insert(pid);
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&ctx));

  // 路径 ②：同 AUMID 的非-AFH 顶层可见窗口（WinUI3/packaged 自有顶层窗口形态）。
  EnumWindows(
      [](HWND hwnd, LPARAM data) -> BOOL {
        auto* ctx = reinterpret_cast<Ctx*>(data);
        if (!IsWindowVisible(hwnd)) return TRUE;
        DWORD pid = 0;
        GetWindowThreadProcessId(hwnd, &pid);
        if (pid == 0 || pid == ctx->framePid) return TRUE;
        if (WindowAumid(hwnd) == *ctx->aumid) ctx->out->insert(pid);
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&ctx));

  if (candidates.size() != 1) return 0;  // 0 或多候选 → fail-closed（唯一候选纪律，§11.3）
  return *candidates.begin();
}

DWORD CorrectedForegroundPid() {
  HWND foreground = GetForegroundWindow();
  if (!foreground) return 0;
  DWORD pid = 0;
  GetWindowThreadProcessId(foreground, &pid);
  if (pid == 0) return 0;
  if (IsApplicationFrameHostPid(pid)) {
    const DWORD real = ResolveFrameHostedAppPid(foreground);
    if (real != 0) return real;
    // 修正不可解析 → 保持 AFH pid（调用侧比对判负，fail-closed 方向不变，§11.3）。
  }
  return pid;
}

std::vector<TopLevelWindowFact> EnumerateVisibleTopLevelWindows() {
  std::vector<TopLevelWindowFact> facts;
  // AFH 判定按 pid 缓存（同进程多窗口不重复 QueryFullProcessImageName）。
  std::map<DWORD, bool> afhCache;
  struct Ctx {
    std::vector<TopLevelWindowFact>* facts;
    std::map<DWORD, bool>* afhCache;
  };
  Ctx ctx{&facts, &afhCache};
  // EnumWindows 顺序 = Z 序（顶先）——「Z 序最顶可见窗口」的确定性规则事实源（§11.2）。
  EnumWindows(
      [](HWND hwnd, LPARAM data) -> BOOL {
        auto* ctx = reinterpret_cast<Ctx*>(data);
        if (!IsWindowVisible(hwnd)) return TRUE;
        if (IsCloakedWindow(hwnd)) return TRUE;  // UWP 挂起态等非真实可见窗口（§11.2）
        DWORD hostPid = 0;
        GetWindowThreadProcessId(hwnd, &hostPid);
        if (hostPid == 0) return TRUE;

        TopLevelWindowFact fact{};
        fact.hwnd = hwnd;
        fact.hostPid = hostPid;
        fact.pid = hostPid;
        auto cached = ctx->afhCache->find(hostPid);
        if (cached == ctx->afhCache->end()) {
          cached = ctx->afhCache->emplace(hostPid, IsApplicationFrameHostPid(hostPid)).first;
        }
        if (cached->second) {
          const DWORD real = ResolveFrameHostedAppPid(hwnd);
          if (real != 0) fact.pid = real;  // 归属修正；不可解析保持 AFH（诚实）
        }
        fact.aumid = WindowAumid(hwnd);
        wchar_t title[513];
        const int length = GetWindowTextW(hwnd, title, 513);
        fact.title.assign(title, length > 0 ? static_cast<size_t>(length) : 0);
        GetWindowRect(hwnd, &fact.bounds);
        fact.minimized = IsIconic(hwnd) != FALSE;
        ctx->facts->push_back(std::move(fact));
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&ctx));
  return facts;
}

uint32_t RegisterWindowToken(HWND hwnd, DWORD hostPid, const std::wstring& hostExePath) {
  std::lock_guard<std::mutex> lock(g_windowMutex);
  g_nextWindowToken += 1;  // 代内单调、不复用（进程级计数，重启即新代）
  const uint32_t token = g_nextWindowToken;
  WindowIdentity identity;
  identity.hwnd = hwnd;
  identity.pid = hostPid;
  identity.exePath = hostExePath;
  g_windowTokens[token] = identity;
  while (g_windowTokens.size() > kMaxWindowTokens) {
    g_windowTokens.erase(g_windowTokens.begin());  // 最旧逐出；失效 token → element_unavailable
  }
  return token;
}

bool ResolveWindowToken(uint32_t token, WindowIdentity& out) {
  std::lock_guard<std::mutex> lock(g_windowMutex);
  auto it = g_windowTokens.find(token);
  if (it == g_windowTokens.end()) return false;
  const WindowIdentity record = it->second;
  if (!IsWindow(record.hwnd)) {
    g_windowTokens.erase(it);
    return false;
  }
  DWORD pidNow = 0;
  GetWindowThreadProcessId(record.hwnd, &pidNow);
  if (pidNow != record.pid) {
    // HWND 被系统复用给其它进程：身份漂移 → 失效（绝不把新住户当旧目标）。
    g_windowTokens.erase(it);
    return false;
  }
  out = record;
  return true;
}

}  // namespace ax
