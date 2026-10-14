// ACode 原创（specs/windows-helper-producer.md §4.1/§4.4 + §10.1 A2 导出面）。
// 纯 node-addon-api / N-API（不碰裸 V8）。导出面：
//   - A1：addonVersion（package.json version 编译期嵌入）+ probe()（同步纯函数，
//     napiVersion = 编译期 NAPI_VERSION 宏值，§4.4 防漂移锚）；
//   - A2（§10.1 钉死签名）：预检/环境事实（environmentProbe/foregroundPid/
//     heldInputSnapshot/asyncKeyState/cursorPosition/processExecutablePath*）、指针五导出
//     （moveTo/scrollAt/drag/mouseDown/mouseUp）、键盘（sendText/pressKeys）、held 清理
//     （releaseAllHeldInputs）、cancelOperations（唯一新增同步导出——停止信号必须不被
//     任何异步队列延迟，§10.1 设计注记 3）、剪贴板（clipboardWriteText）、截图
//     （captureDisplay/captureWindow）。
//     * processExecutablePath 是 A2 实现批次按 §10.9 app_ref 校验要求（「进程存活 +
//       QueryFullProcessImageName 可读 canonical exe」）补的导出——§10.1 原表未列该原语，
//       属 spec 缺口补齐（同批回写 §10.1；A3 的 list_apps exe_path 同源复用）。
// 除 probe 与 cancelOperations 外全部异步（N-API Promise；AsyncWorker 完成端 resolve），
// 类型化错误携带封闭 code（§10.3）+ dispatchStarted 二分判据事实。
#include <napi.h>

#include "ax_internal.h"

// NAPI_VERSION 单一来源 = scripts/build-native.mjs 的 env 注入（§4.4）；
// node-addon-api common.gypi 把该 env 翻成编译宏。缺失 = 工具链接线被破坏，编译期拒绝。
#ifndef NAPI_VERSION
#error "NAPI_VERSION must be injected by the build (scripts/build-native.mjs pins NAPI_VERSION=9)"
#endif

// addonVersion 编译期嵌入来源 = package.json version（binding.gyp ADDON_VERSION define，§4.1）。
#ifndef ADDON_VERSION
#error "ADDON_VERSION must be injected by binding.gyp from package.json"
#endif

namespace {

// probe(): { ok: true, napiVersion: <编译期 NAPI_VERSION> }（§4.1 精确签名）。
// 同步是刻意例外（§10.1 全异步）：它只在加载校验路径上被调用一次，无并发/阻塞面。
Napi::Value Probe(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  result.Set("ok", Napi::Boolean::New(env, true));
  result.Set("napiVersion", Napi::Number::New(env, NAPI_VERSION));
  return result;
}

// cancelOperations()：唯一新增同步导出（§10.1）——原子置取消旗标；在途循环
// （sendText chunk 间 / drag 插值点间 / pressKeys hold 等待环 / capture 帧等待环）
// ≤500ms 内以 canceled 收口。旗标在每个派发类 worker 的 Execute 入口清零
// （stop 非会话闩锁，§10.6：stop 后的新动作正常受理）。
Napi::Value CancelOperations(const Napi::CallbackInfo& info) {
  ax::g_cancelRequested.store(true);
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // DPI awareness 在 Init 设置（§10.7：Per-Monitor-V2；Electron 宿主 manifest 已带 PMv2
  // 时 Set 失败但查询判定达标；失败 → environmentProbe.dpiAware=false → preflight 拒绝，
  // 绝不带病派发）。
  ax::InitializeProcessDpi();

  exports.Set("addonVersion", Napi::String::New(env, ADDON_VERSION));
  exports.Set("probe", Napi::Function::New(env, Probe));
  // ── A2 预检与环境事实（§10.1）──
  exports.Set("environmentProbe", Napi::Function::New(env, ax::EnvironmentProbe));
  exports.Set("foregroundPid", Napi::Function::New(env, ax::ForegroundPid));
  exports.Set("heldInputSnapshot", Napi::Function::New(env, ax::HeldInputSnapshot));
  exports.Set("asyncKeyState", Napi::Function::New(env, ax::AsyncKeyState));
  exports.Set("cursorPosition", Napi::Function::New(env, ax::CursorPosition));
  exports.Set("processExecutablePath", Napi::Function::New(env, ax::ProcessExecutablePath));
  exports.Set("releaseAllHeldInputs", Napi::Function::New(env, ax::ReleaseAllHeldInputs));
  exports.Set("cancelOperations", Napi::Function::New(env, CancelOperations));
  // ── A2 指针（§10.1：expectedForegroundPid 必现、无缺省——纪律的结构化落点）──
  exports.Set("moveTo", Napi::Function::New(env, ax::MoveTo));
  exports.Set("scrollAt", Napi::Function::New(env, ax::ScrollAt));
  exports.Set("drag", Napi::Function::New(env, ax::Drag));
  exports.Set("mouseDown", Napi::Function::New(env, ax::MouseDown));
  exports.Set("mouseUp", Napi::Function::New(env, ax::MouseUp));
  // ── A2 键盘（chord→VK 解析在 JS 侧 keymap.ts；native 只注入）──
  exports.Set("sendText", Napi::Function::New(env, ax::SendText));
  exports.Set("pressKeys", Napi::Function::New(env, ax::PressKeys));
  // ── A2 剪贴板（CF_UNICODETEXT；无 read 导出——能力面溢出禁止，§10.1 注记 4）──
  exports.Set("clipboardWriteText", Napi::Function::New(env, ax::ClipboardWriteText));
  // ── A2 截图（WGC + D3D11 + WIC；编码在同一后台 worker）──
  exports.Set("captureDisplay", Napi::Function::New(env, ax::CaptureDisplay));
  exports.Set("captureWindow", Napi::Function::New(env, ax::CaptureWindow));
  return exports;
}

}  // namespace

NODE_API_MODULE(ax_native, Init)
