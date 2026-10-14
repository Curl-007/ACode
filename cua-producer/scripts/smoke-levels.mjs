/**
 * 真机烟测层级实现（specs/windows-helper-producer.md §15.2；A3 实现批次自
 * smoke-real.mjs 拆出——max-lines 治理，§19 第 15 条）。四个层级函数接收 ctx =
 * { emit, emitErr, finish, registerSecret, loadAddon }（输出纪律与前置检查是入口
 * smoke-real.mjs 的单一落点，本文件不直接触 process.stdout/exit）。
 *
 * 纪律不变：--pointer 人工 C07 专属（入口双保险门在拆出前后语义一致）；树文本/标题/
 * 截图字节绝不打印；层级失败一律固定结果码。
 */
import {
  CAPTURE_INLINE_BASE64_BUDGET_BYTES,
  CAPTURE_MAX_DIMENSION,
  INTERRUPTED_MESSAGE,
  STOPPED_MESSAGE,
  SmokeAssertionError,
  VK_F13,
  WIRE_OBSERVE_TIMEOUT_MS,
  assertAppEntryShape,
  assertTrue,
  assertWireResultOk,
  assertWireScreenshot,
  assertWindowEntryShape,
  callGetAppState,
  createCapturingLogger,
  delay,
  importHostSurface,
  observeAppState,
  probePipeRefused,
  producerRoot,
  resolveTargetApp,
  stopHostQuietly,
} from "./smoke-lib.mjs";

// ── --capture（addon 直载段 + A3 wire get_app_state 截图段，§15.2）────────────

export async function runCapture(ctx) {
  const { emit, emitErr, finish, registerSecret, loadAddon } = ctx;
  const startedAt = Date.now();
  const addon = loadAddon();
  const environment = await addon.environmentProbe();
  assertTrue(environment && typeof environment === "object", "environment-probe-shape");
  if (!environment.interactiveDesktop || environment.sessionZero) {
    // 非交互桌面/锁屏 = 前置失败（非层级失败），且在启动任何子进程前退出（§15.3）。
    emitErr("non-interactive-desktop");
    finish(2);
  }
  const capture = await addon.captureDisplay(
    { monitorIndex: 0 },
    { maxDimension: CAPTURE_MAX_DIMENSION, inlineBase64BudgetBytes: CAPTURE_INLINE_BASE64_BUDGET_BYTES },
  );
  // 断言面（§15.2）：魔数/encoding 一致、尺寸 ≤2000 且 >0、base64 折算 ≤200 KiB、
  // bounds 宽高 >0、budgetFit===true、scaled 与尺寸事实一致。
  // 图像字节不落盘、不打印、断言即弃（屏幕内容是隐私面）。
  assertTrue(capture && typeof capture === "object", "capture-result-shape");
  const bytes = capture.image;
  assertTrue(bytes instanceof Uint8Array && bytes.length > 0, "capture-image-bytes");
  const base64Bytes = Math.ceil(bytes.length / 3) * 4;
  if (capture.encoding === "png") {
    assertTrue(
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
      "capture-png-magic",
    );
  } else if (capture.encoding === "jpeg") {
    assertTrue(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff, "capture-jpeg-magic");
  } else {
    throw new SmokeAssertionError("capture-encoding-unknown");
  }
  assertTrue(
    Number.isInteger(capture.width) && capture.width > 0 && capture.width <= CAPTURE_MAX_DIMENSION,
    "capture-width-bound",
  );
  assertTrue(
    Number.isInteger(capture.height) && capture.height > 0 && capture.height <= CAPTURE_MAX_DIMENSION,
    "capture-height-bound",
  );
  assertTrue(base64Bytes <= CAPTURE_INLINE_BASE64_BUDGET_BYTES, "capture-base64-budget");
  assertTrue(
    capture.bounds && capture.bounds.width > 0 && capture.bounds.height > 0,
    "capture-bounds-positive",
  );
  assertTrue(capture.budgetFit === true, "capture-budget-fit");
  // scaled 与尺寸事实一致：未缩放 ⇒ 栅格 = bounds 尺寸；缩放 ⇒ 栅格严格小于 bounds。
  if (capture.scaled === true) {
    assertTrue(
      capture.width < capture.bounds.width || capture.height < capture.bounds.height,
      "capture-scaled-consistency",
    );
  } else {
    assertTrue(
      capture.width === capture.bounds.width && capture.height === capture.bounds.height,
      "capture-scaled-consistency",
    );
  }
  // ── A3 扩展段（§15.2）：真 fork Helper → wire get_app_state(include_screenshot:true)。
  // 截图失败降级形态在本层级 = 段失败（--capture 的语义就是截图必须成功）；base64/
  // 图像字节绝不打印。no-foreground-app = 前置不满足（先收口 Helper 再 exit 2）。
  const { resolveWindowsCuaRuntime, WindowsCuaHelperHost, callBrokerMethod } =
    await importHostSurface();
  const runtime = await resolveWindowsCuaRuntime({
    platform: "win32",
    env: { ACODE_CUA_DEV_ROOT: producerRoot },
  });
  const logSink = [];
  const host = new WindowsCuaHelperHost({ runtime, logger: createCapturingLogger(logSink) });
  let shot;
  try {
    const handle = await host.start();
    registerSecret(handle.socketPath);
    registerSecret(handle.pluginAuthority);
    assertTrue(host.running === true, "host-running");
    const target = await resolveTargetApp({ callBrokerMethod, socketPath: handle.socketPath, addon });
    if (target.pid === null) {
      await stopHostQuietly(host);
      emitErr("no-foreground-app");
      finish(2);
    }
    const stateResult = await callGetAppState(callBrokerMethod, handle.socketPath, target.pid, true);
    shot = assertWireScreenshot(stateResult);
  } finally {
    await stopHostQuietly(host);
  }
  const durationMs = Date.now() - startedAt;
  emit(
    `level=capture result=pass duration_ms=${durationMs} png_bytes=${bytes.length} width=${capture.width} height=${capture.height} encoding=${capture.encoding} scaled=${capture.scaled} budget_fit=${capture.budgetFit} base64_bytes=${base64Bytes} wire_mime=${shot.mimeType} wire_base64_bytes=${shot.base64Bytes} wire_frame_id=true`,
  );
  return 0;
}

// ── --uia（A3：只读观察当前目标应用，§15.2——不 spawn、不变更、不抢焦点）─────────

export async function runUia(ctx) {
  const { emit, emitErr, finish, registerSecret, loadAddon } = ctx;
  const startedAt = Date.now();
  // 级联②需要 addon.foregroundPid()——工件/加载前置在 fork 之前完成（§15.3）。
  const addon = loadAddon();
  const { resolveWindowsCuaRuntime, WindowsCuaHelperHost, callBrokerMethod } =
    await importHostSurface();
  const runtime = await resolveWindowsCuaRuntime({
    platform: "win32",
    env: { ACODE_CUA_DEV_ROOT: producerRoot },
  });
  const logSink = [];
  const host = new WindowsCuaHelperHost({ runtime, logger: createCapturingLogger(logSink) });
  try {
    const handle = await host.start();
    registerSecret(handle.socketPath);
    registerSecret(handle.pluginAuthority);
    assertTrue(host.running === true, "host-running");
    // 目标应用 pid 级联（A3 实现批次裁决；三层共享单一实现，只读观察纪律）。
    const target = await resolveTargetApp({ callBrokerMethod, socketPath: handle.socketPath, addon });
    if (target.pid === null) {
      // 无任何可见窗口（罕见）：前置不满足，非失败（§15.2）——先收口 Helper 再 exit 2。
      await stopHostQuietly(host);
      emitErr("no-foreground-app");
      finish(2);
    }
    // 断言①：list_apps 非空 ∧ 目标 pid 在集合 ∧ 条目字段齐套（键在场 + 类型合法）。
    assertTrue(target.apps.length > 0, "uia-list-apps-empty");
    assertTrue(
      target.apps.some((entry) => entry !== null && entry.pid === target.pid),
      "uia-target-not-in-apps",
    );
    for (const entry of target.apps) assertAppEntryShape(entry, "uia-app-entry-shape");
    // 断言②：list_windows（目标应用 scope）条目字段类型合法；标题内容绝不打印。
    const windowsResult = await callBrokerMethod({
      socketPath: handle.socketPath,
      method: "list_windows",
      params: { app_ref: { pid: target.pid } },
      timeoutMs: WIRE_OBSERVE_TIMEOUT_MS,
    });
    assertWireResultOk(windowsResult, "uia-list-windows-failed");
    const windows = windowsResult.structuredContent?.windows;
    assertTrue(Array.isArray(windows), "uia-list-windows-shape");
    for (const entry of windows) assertWindowEntryShape(entry, "uia-window-entry-shape");
    // 断言③：get_app_state（无截图）×2——四必备字段恒在、树文本采样行格式、C09 诚实
    // 空树判据、app.pid===目标、两次 state_id 不同（observeAppState 内逐条断言）。
    const obs1 = await observeAppState(callBrokerMethod, handle.socketPath, target.pid, "obs1");
    const obs2 = await observeAppState(callBrokerMethod, handle.socketPath, target.pid, "obs2");
    assertTrue(obs1.stateId !== obs2.stateId, "uia-state-id-repeat");
    const durationMs = Date.now() - startedAt;
    // emit 纪律（§15.3）：只输出数值/布尔/固定枚举（target_source ∈ active|foreground|
    // top_window）；绝不输出标题/树文本/元素名。
    emit(
      `level=uia result=pass duration_ms=${durationMs} app_count=${target.apps.length} window_count=${windows.length} element_count=${obs2.elementCount} element_count_obs1=${obs1.elementCount} state_id_distinct=true target_source=${target.source}`,
    );
    return 0;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const reason = error instanceof SmokeAssertionError ? error.reason : "uia-wire-failure";
    emit(`level=uia result=fail duration_ms=${durationMs} reason=${reason}`);
    emitErr(error?.name ?? "Error");
    return 1;
  } finally {
    await stopHostQuietly(host);
  }
}

// ── --host（生命周期面 + A3 截图步，不需要模型 cell，§15.2）───────────────────

export async function runHost(ctx) {
  const { emit, emitErr, finish, registerSecret, loadAddon } = ctx;
  const startedAt = Date.now();
  // A3 截图步的目标 pid 级联②需要 addon.foregroundPid()——工件/加载前置在 fork 之前
  // 完成（§15.3 前置纪律；加载被拒 → addon-load-failed + exit 2，不启子进程）。
  const addon = loadAddon();
  const { resolveWindowsCuaRuntime, WindowsCuaHelperHost, probeHelperHealth, callBrokerMethod } =
    await importHostSurface();
  // dev 链解析（§15.2 步骤 1：真解析器，ACODE_CUA_DEV_ROOT 指向 producer）。
  const runtime = await resolveWindowsCuaRuntime({
    platform: "win32",
    env: { ACODE_CUA_DEV_ROOT: producerRoot },
  });
  const logSink = [];
  const host = new WindowsCuaHelperHost({ runtime, logger: createCapturingLogger(logSink) });
  try {
    const handle = await host.start();
    registerSecret(handle.socketPath);
    registerSecret(handle.pluginAuthority);
    // C05 split-brain 教训（§15.2 步骤 3）：仅 env tuple 不算数——host.running 必须为真。
    assertTrue(host.running === true, "host-running");
    const health = await probeHelperHealth(handle.socketPath, { timeoutMs: 15_000 });
    const pidMatch = health.pid === handle.pid;
    assertTrue(pidMatch, "host-pid-match");
    // A2 切片（§15.2 步骤 4）：broker_info 一次（capabilities 形状断言）。
    const info = await callBrokerMethod({
      socketPath: handle.socketPath,
      method: "broker_info",
      timeoutMs: 5_000,
    });
    assertTrue(info && info.pid === handle.pid, "broker-info-pid");
    assertTrue(typeof info.bundle_id === "string" && info.bundle_id.length > 0, "broker-info-bundle-id");
    const capabilities = info.capabilities;
    assertTrue(capabilities && typeof capabilities === "object", "broker-info-capabilities-shape");
    // A3 起 capabilities 含 uia 键（§10.9 两面同源：uia:true ⟺ 6 个 UIA handler 注册）。
    for (const key of ["input", "capture", "clipboard", "uia"]) {
      assertTrue(typeof capabilities[key] === "boolean", "broker-info-capabilities-shape");
    }
    // A3 追加截图步（§15.2 步骤 4）：目标 pid 级联（与 --capture/--uia 同一共享实现）→
    // get_app_state(include_screenshot:true) → image 块断言（同 --capture A3 扩展判据）。
    const target = await resolveTargetApp({ callBrokerMethod, socketPath: handle.socketPath, addon });
    if (target.pid === null) {
      // 前置不满足（非失败）：先收口已 fork 的 Helper，再按 §15.3 固定码 exit 2。
      await stopHostQuietly(host);
      emitErr("no-foreground-app");
      finish(2);
    }
    const stateResult = await callGetAppState(callBrokerMethod, handle.socketPath, target.pid, true);
    const shot = assertWireScreenshot(stateResult);
    // 步骤 5：stop() → 子进程退出（stop 以 lifecycle tail 等待 exact child exit 后 resolve）
    // ∧ 旧 pipe 拒连（ENOENT）∧ **stop 序列** <5s（A3 实现批次裁决，spec §15.2/§19 第 13 条：
    // 5s 预算的语义本意是宿主生命周期响应性；层级总时长如实 emit，闸门只钉 stop 序列）。
    const stopStartedAt = Date.now();
    await host.stop();
    assertTrue(host.running === false, "host-stopped");
    const refused = await probePipeRefused(handle.socketPath);
    assertTrue(refused, "host-pipe-refused-after-stop");
    const stopMs = Date.now() - stopStartedAt;
    assertTrue(stopMs < 5_000, "host-duration-budget");
    const durationMs = Date.now() - startedAt;
    emit(
      `level=host result=pass duration_ms=${durationMs} stop_ms=${stopMs} running=true pid_match=true exit_code=0 capabilities_input=${capabilities.input} capabilities_capture=${capabilities.capture} capabilities_clipboard=${capabilities.clipboard} capabilities_uia=${capabilities.uia} pipe_refused=true wire_mime=${shot.mimeType} wire_base64_bytes=${shot.base64Bytes} wire_frame_id=true`,
    );
    return 0;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const reason = error instanceof SmokeAssertionError ? error.reason : "host-lifecycle-failure";
    emit(`level=host result=fail duration_ms=${durationMs} reason=${reason}`);
    emitErr(error?.name ?? "Error");
    try {
      await host.stop();
    } catch {
      // 清理失败不改变层级 fail 结论（host 内部有终止链兜底）。
    }
    return 1;
  }
}

// ── --pointer（人工 C07 专属；操作者在场、已解锁交互桌面，§15.2）──────────────
// 破坏性边界（如实登记）：本脚本不含任何真实点击/键入用户应用——只有光标移动/还原
// （≤24 坐标单位、≤2px 容差复原）、零滚动量探针、f13（无害键）hold + wire stop 中断
// 时序。鼠标键实压配对不在任何自动化面（真机点击证据归 A3 wire 级人工 C07）。

export async function runPointer(ctx) {
  const { emit, emitErr, finish, registerSecret, loadAddon } = ctx;
  const startedAt = Date.now();
  const addon = loadAddon();
  const environment = await addon.environmentProbe();
  if (!environment.interactiveDesktop || environment.sessionZero || !environment.dpiAware) {
    emitErr("non-interactive-desktop");
    finish(2);
  }
  // 步骤 1：记录原始光标位置；取当前前台应用 pid 为 app_ref。
  const original = await addon.cursorPosition();
  const foreground = await addon.foregroundPid();
  if (!foreground.pid) {
    emitErr("no-foreground-app");
    finish(2);
  }
  const pid = foreground.pid;
  const { resolveWindowsCuaRuntime, WindowsCuaHelperHost, callBrokerMethod } =
    await importHostSurface();
  const runtime = await resolveWindowsCuaRuntime({
    platform: "win32",
    env: { ACODE_CUA_DEV_ROOT: producerRoot },
  });
  const logSink = [];
  const host = new WindowsCuaHelperHost({ runtime, logger: createCapturingLogger(logSink) });
  let handle;
  let cursorDeltaPx = -1;
  try {
    // 步骤 2：moveTo 向所在显示器中心移动 ≤24 坐标单位 → foregroundPid 复核 → 还原（≤2px）。
    // 显示器几何经 captureDisplay bounds 取得（只读；图像断言即弃、绝不输出）。
    const geometry = await addon.captureDisplay(
      { monitorIndex: 0 },
      { maxDimension: CAPTURE_MAX_DIMENSION, inlineBase64BudgetBytes: CAPTURE_INLINE_BASE64_BUDGET_BYTES },
    );
    const centerX = geometry.bounds.x + geometry.bounds.width / 2;
    const centerY = geometry.bounds.y + geometry.bounds.height / 2;
    const stepToward = (from, toward) => {
      const distance = Math.abs(toward - from);
      const step = Math.min(24, Math.round(distance));
      return from + (toward >= from ? step : -step);
    };
    const target = { x: stepToward(original.x, centerX), y: stepToward(original.y, centerY) };
    await addon.moveTo(target.x, target.y, { expectedForegroundPid: pid });
    const midForeground = await addon.foregroundPid();
    assertTrue(midForeground.pid === pid, "pointer-foreground-stable");
    await addon.moveTo(original.x, original.y, { expectedForegroundPid: pid });
    const restored = await addon.cursorPosition();
    cursorDeltaPx = Math.max(Math.abs(restored.x - original.x), Math.abs(restored.y - original.y));
    assertTrue(cursorDeltaPx <= 2, "pointer-cursor-restored-2px");
    // 步骤 3：scrollAt(amount:0) 探针（零滚动量，无副作用；光标定位到原位 = 无移动）。
    await addon.scrollAt(original.x, original.y, 0, 0, { expectedForegroundPid: pid });
    // 步骤 4：wire 级中断时序（fork 真 Helper；对齐上游 hold_key 中断验收机制）。
    handle = await host.start();
    registerSecret(handle.socketPath);
    registerSecret(handle.pluginAuthority);
    const keyPromise = callBrokerMethod({
      socketPath: handle.socketPath,
      method: "key",
      params: { text: "f13", app_ref: { pid }, hold_seconds: 5 },
      timeoutMs: 15_000,
    }).then(
      (receipt) => ({ receipt }),
      (error) => ({ error }),
    );
    await delay(1_000);
    const stopSentAt = Date.now();
    const stopReceipt = await callBrokerMethod({
      socketPath: handle.socketPath,
      method: "stop_computer_control",
      timeoutMs: 10_000,
    });
    const keyOutcome = await keyPromise;
    const interruptMs = Date.now() - stopSentAt;
    // stop 收据（§10.6 ⑤ 固定字面量）。
    assertTrue(stopReceipt && stopReceipt.isError !== true, "pointer-stop-receipt-ok");
    assertTrue(
      stopReceipt.structuredContent?.dispatch_status === "accepted" &&
        stopReceipt.structuredContent?.action_sent === true &&
        stopReceipt.structuredContent?.message === STOPPED_MESSAGE,
      "pointer-stop-receipt-shape",
    );
    // key 调用在 ≤1.5s 内以 interrupted 收据收口（§10.6/§15.2 步骤 4）。
    assertTrue(keyOutcome.receipt !== undefined, "pointer-key-receipt-present");
    const keyReceipt = keyOutcome.receipt;
    assertTrue(keyReceipt.isError === true, "pointer-key-interrupted-is-error");
    assertTrue(
      keyReceipt.structuredContent?.dispatch_status === "accepted" &&
        keyReceipt.structuredContent?.action_sent === true &&
        keyReceipt.structuredContent?.code === "controller_busy" &&
        keyReceipt.structuredContent?.message === INTERRUPTED_MESSAGE,
      "pointer-key-interrupted-shape",
    );
    assertTrue(interruptMs <= 1_500, "pointer-interrupt-1500ms");
    // 烟测进程自载 addon 的系统级全局键态：跨进程独立佐证 Helper 无 held 遗留
    // （held 注册表是 Helper 进程内的，烟测进程读不到，故必须用系统事实面验证）。
    const f13State = await addon.asyncKeyState(VK_F13);
    assertTrue(f13State.down === false, "pointer-f13-released-system-wide");
    const durationMs = Date.now() - startedAt;
    emit(
      `level=pointer result=pass duration_ms=${durationMs} cursor_delta_px=${cursorDeltaPx} interrupt_ms=${interruptMs} key_released=true released_count=${stopReceipt.structuredContent?.released_inputs ?? 0}`,
    );
    return 0;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const reason = error instanceof SmokeAssertionError ? error.reason : "pointer-sequence-failure";
    emit(`level=pointer result=fail duration_ms=${durationMs} reason=${reason} cursor_delta_px=${cursorDeltaPx}`);
    emitErr(error?.name ?? "Error");
    return 1;
  } finally {
    // 步骤 5（finally）：还原光标位置（≤2px 断言尽力而为）→ Helper shutdown。
    try {
      // 还原用当前前台 pid（前台可能已变化；moveTo 的前台校验以现值为准——还原是
      // cleanup 性质的尽力动作）。
      const nowForeground = await addon.foregroundPid();
      if (nowForeground.pid) {
        await addon.moveTo(original.x, original.y, { expectedForegroundPid: nowForeground.pid });
        const final = await addon.cursorPosition();
        const finalDelta = Math.max(Math.abs(final.x - original.x), Math.abs(final.y - original.y));
        if (finalDelta > 2) emitErr("pointer-cursor-restore-degraded");
      }
    } catch {
      emitErr("pointer-cursor-restore-failed");
    }
    try {
      await host.stop();
    } catch {
      emitErr("pointer-host-stop-failed");
    }
    void handle;
  }
}
