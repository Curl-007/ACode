# ACode 原创构建描述（specs/windows-helper-producer.md §5.2 要点 + §4.1 addonVersion 编译期嵌入）。
# NAPI_VERSION 刻意不进 defines：由 scripts/build-native.mjs 在 spawn node-gyp 前注入
# env NAPI_VERSION="9"（单一来源，§4.4 pin 9）。
#
# 实现期回写（2026-10-14，node-addon-api 8.9.2 + Node 25 headers 实测，§4.5 预案的「回写本文」纪律）：
# 8.x 的 require('node-addon-api').gyp 指向 node_api.gyp:nothing（空 static_library），
# **不再**像 7.x 那样自动携带 common.gypi 的 NAPI_VERSION% env 翻译逻辑——故在 target 内显式
# `includes` 接线 common.gypi（env → 编译宏的翻译器，机制与 §4.4 描述一致）。两个实测事实：
# ① includes 必须放 target 内——顶层 includes 的 defines/conditions 不会传播进 target
#   （本机实证：顶层接线时 vcxproj 零 NAPI_VERSION 定义）；
# ② Node 25 的 js_native_api_types.h:6-16 在消费者未定义时自带 `#define NAPI_VERSION 8`
#   基线缺省——即「未显式钉则构建机漂移」的漂移值不再是 process.versions.napi 而是头文件
#   基线 8，且 addon.cc 的 #ifndef #error 编译期兜底在新头文件下不再可触发；防漂移的
#   load-bearing 锚 = probe().napiVersion 运行时回读 + 测试断言 ===9（§4.4/§6.2 步骤 6）。
{
  "variables": {
    # addonVersion = package.json version 的编译期嵌入（§4.1，单一来源防漂移）。
    "addon_version": "<!(node -p \"require('./package.json').version\")",
  },
  "targets": [
    {
      # → build/Release/ax_native.node（acodeCuaRuntime.windows.nativeAddon 契约路径）。
      "target_name": "ax_native",
      # A2 增补（§10.10：sources 清单是契约面，契约测试锁定；A3 追加 UIA 四件）。
      "sources": [
        "src/native/addon.cc",
        "src/native/environment.cc",
        "src/native/foreground.cc",
        "src/native/pointer.cc",
        "src/native/keyboard.cc",
        "src/native/clipboard.cc",
        "src/native/capture.cc",
      ],
      # env NAPI_VERSION（build-native.mjs 注入 "9"）→ common.gypi NAPI_VERSION% → defines。
      "includes": ["node_modules/node-addon-api/common.gypi"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      # C++ 异常开启（§4.5）：A2/A3 的 C++/WinRT 以 hresult_error 异常为主要错误通道。
      # _HAS_EXCEPTIONS=1 是 MSVC STL 侧的配套宏（node-addon-api except.gypi 同型配方；
      # node-gyp 缺省注入 _HAS_EXCEPTIONS=0，会关掉 STL 异常机构，与 NAPI_CPP_EXCEPTIONS 矛盾）。
      # A2 defines 增补（§10.10）：_WIN32_WINNT/NTDDI_VERSION = 编译期地板与 §12.3 运行时
      # 地板（Win10 1809 / build 17763，RS5）对齐——addon 只导入 1809+ API，更低版本系统
      # 加载即失败 → §2.7 native-addon-load-failed exit 2 诚实报告，结构性排除「低版本跑半套」。
      # NOMINMAX/WIN32_LEAN_AND_MEAN：windows.h 的 min/max 宏与 std::min/max 冲突、以及
      # 无关子系统头（含 GDI 旧面）拖慢编译并引入宏污染——C++/WinRT 工程的标准配套
      # （A2 实现期增补，spec §10.10 同批回写登记）。
      "defines": [
        "NAPI_CPP_EXCEPTIONS",
        "_HAS_EXCEPTIONS=1",
        "ADDON_VERSION=\"<(addon_version)\"",
        "_WIN32_WINNT=0x0A00",
        "NTDDI_VERSION=0x0A000006",
        "NOMINMAX",
        "WIN32_LEAN_AND_MEAN",
      ],
      "cflags_cc": ["-fexceptions"],
      "conditions": [
        [
          "OS=='win'",
          {
            "msvs_settings": {
              "VCCLCompilerTool": {
                # /EHsc，配合 NAPI_CPP_EXCEPTIONS（§4.5）。
                "ExceptionHandling": 1,
                # /std:c++17 = C++/WinRT 最低要求（§4.5，显式 pin；node-gyp 13 缺省已带
                # /std:c++20，MSVC 报良性 D9025 覆盖警告，后出现的 /std:c++17 生效）。
                # /utf-8：源码含中文注释，MSVC 缺省按系统代码页（936）解析会报 C4819 且
                # 有字面量误读风险——显式声明 UTF-8 源/执行字符集。
                "AdditionalOptions": ["/std:c++17", "/utf-8"],
              },
            },
            # A2 libraries（§10.10 钉死清单，契约测试锁定）：d3d11/dxgi = WGC 设备与
            # surface；windowsapp = C++/WinRT 伞形库（GraphicsCaptureItem interop /
            # CreateDirect3D11DeviceFromDXGIDevice）；user32 = SendInput/前台/光标/桌面；
            # gdi32 = EnumDisplayMonitors；windowscodecs = WIC PNG/JPEG 编码；
            # shcore = DPI/显示器度量；ole32 = COM 激活与流；uuid = IID/GUID 常量。
            "libraries": [
              "d3d11.lib",
              "dxgi.lib",
              "windowsapp.lib",
              "user32.lib",
              "gdi32.lib",
              "windowscodecs.lib",
              "shcore.lib",
              "ole32.lib",
              "uuid.lib",
            ],
          },
        ],
      ],
      # 工具集不 pin（§4.5）：node-gyp 13 find-visualstudio 自动解析（VS2026 v145 本机已实证），
      # 不写死 msvs_version/toolset，避免把开发机事实固化成发布链约束。
    },
  ],
}
