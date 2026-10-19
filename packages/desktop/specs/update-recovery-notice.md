# 更新恢复诊断通知面（install-recovery）

> 状态：实施中（UX 波第 4 件·Windows 交互前端，编排器单人）
> 前置：specs/updater-journal-recovery.md（WI-9 journal 闭环，本 spec 是其
> 用户可见面）；omp 价值提取清册 T1#14 的「诚实状态上报」语义延伸。

## 背景

WI-9 落地了更新交接账本与启动核对，但核对结果只进日志：「上次更新没装上」
（本月 Windows 自更新被杀事故的指纹）用户看不到任何解释——重启入口静默重现，
验证失败/陈旧包清理则完全无声。本项把恢复结论做成用户可见的诊断通知：
解释发生了什么、能不能重试、怎么重试。

## 产品规则

### R1 新载荷形态（packages/shared/src/update.ts 闭集扩展）

```ts
{
  kind: "install-recovery";
  enabled: boolean;
  outcome: "verification-failed" | "install-not-effective" | "stale-pending-cleared";
  fingerprint?: "version-unchanged" | "version-diverged"; // install-not-effective 时
  fromVersion: string;
  toVersion: string;
  /** pending 包完整且校验通过 → 一键重试交接可用（重启按钮语义同 update-downloaded）。 */
  retryAvailable: boolean;
  /** R19 豁免链标记（诊断本月事故形态：pending=死在豁免链之前）。 */
  exitSweepHandoff?: "pending" | "completed" | "failed" | "absent" | "unknown";
}
```

### R2 发射矩阵（autoUpdater 启动恢复三站点 + 验证失败站点）

| journal 核对结论 | 发射 | retryAvailable |
|---|---|---|
| first-launch-after-update + 探针过 | 不发（verified 静默成功） | — |
| first-launch-after-update + 探针败 | install-recovery(verification-failed) | false |
| install-not-effective + version-unchanged + pending 完整 | install-recovery(install-not-effective, version-unchanged)，**接替** re-stage 的 update-downloaded 菜单态 | true |
| install-not-effective + version-unchanged + pending 损坏 | install-recovery(stale-pending-cleared)，替代原静默 idle | false |
| install-not-effective + version-diverged | install-recovery(install-not-effective, version-diverged) | false |

retryAvailable 形态**取代**（而非叠加）update-downloaded 菜单态：单一状态值
语义下 UI 把 install-recovery+retryAvailable 渲染为「解释横幅 + 重启以重试」，
readyUpdateVersion 已由 re-stage 保住，重启链路与 update-downloaded 完全同源。

### R3 既有消费点扩展（防新 kind 落进拒绝分支）

- quitAndInstallUpdate 守卫：`update-downloaded` 或 `install-recovery且
  retryAvailable` 且 readyUpdateVersion 在场才放行（否则照旧忽略+warn）。
- isUpdateStatusWindowCloseLocked：install-recovery+retryAvailable 同样锁关闭
  （与 update-downloaded 同级的行动召唤）。
- resolveUpdateStatusWindowHeight：install-recovery 用 READY 高度（横幅+按钮）。
- 其余 `?.kind ===` 判定点（UI model 等）对新 kind 自然 fall-through，
  R4 显式接管。

### R4 UI 呈现（packages/ui）

- updateStatusModel：`install-recovery && retryAvailable` 时 readyVersion=
  toVersion（dialogPhase=downloaded，重启按钮语义不变）；新增 recoveryNotice
  视图字段（outcome/fingerprint/版本对/exitSweepHandoff）供横幅文案。
- 横幅（UpdateStatusDialogController 顶部区）：解释性文案按 outcome 三分
  （i18n 键 update.recovery.*），诚实呈现「上次更新未完成/验证未通过/陈旧
  包已清理」；retryAvailable 时主按钮=既有 restart 通道；dismiss=组件态本地
  关闭横幅（不改 main 状态，下一次状态广播自然接管——无新 IPC 面）。
- exitSweepHandoff=pending 时文案附加诊断提示（事故窗口精确定位，支持
  「排查取 ~/.acode/v2/logs」话术）。

### R5 测试面

- desktop：journal 恢复四路径的发射断言（既有替身加载器 harness 扩展）；
  守卫放行/拒绝矩阵（install-recovery±retryAvailable × readyUpdateVersion）。
- ui：deriveUpdateStatusViewModel 的 recoveryNotice/readyVersion 映射单测；
  既有 model 测试零回归。
- shared：闭集 schema 若有序列化守卫测试则同步扩样。

## 边界

- 不做恢复历史列表（journal 有多代条目，UI 只呈现最近一次核对结论）。
- 不做「自动重试」——重试永远是用户显式动作（更新是重操作，静默重试违反
  R19 事故的教训：用户对进程交接必须有知情权）。
- Web/手机面不在本项（UpdateStatePayload 是 desktop 通道）。
