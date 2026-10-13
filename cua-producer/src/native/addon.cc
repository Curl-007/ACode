// ACode 原创（specs/windows-helper-producer.md §4.1/§4.4）：A1 诚实 probe/version 面。
// 纯 node-addon-api / N-API（不碰裸 V8）。A1 只导出两项：
//   - addonVersion：package.json version 的编译期嵌入（binding.gyp variables 注入）；
//   - probe()：同步纯函数（无 I/O、无副作用），证明「已加载且可调用」，
//     napiVersion = 编译期 NAPI_VERSION 宏值（运行时防漂移断言的锚，§4.4 pin 9）。
// 任何超出 probe/version 的导出在 A1 都没有真实能力支撑（能力真实性纪律，§4.1/§4.6）——
// 指针/截图（A2）与 UIA（阶段 3）的导出面由各自 spec 钉死后才实现，绝不放假动作。
#include <napi.h>

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
// 同步是刻意例外（§4.2 全异步）：它只在加载校验路径上被调用一次，无并发/阻塞面。
Napi::Value Probe(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  result.Set("ok", Napi::Boolean::New(env, true));
  result.Set("napiVersion", Napi::Number::New(env, NAPI_VERSION));
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("addonVersion", Napi::String::New(env, ADDON_VERSION));
  exports.Set("probe", Napi::Function::New(env, Probe));
  return exports;
}

}  // namespace

NODE_API_MODULE(ax_native, Init)
