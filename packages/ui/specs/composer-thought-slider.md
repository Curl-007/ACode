# composer-thought-slider：思考强度悬浮滑条

> 来源与许可：交互机制参考 https://github.com/c80361619/zcode-toolkit （MIT,
> c80361619；含 HHQ-666 MIT 组件声明；其滑条样式上游 HanaAyane/dsh-reasoning-effort,
> MIT）。只搬交互机制与产品语义，不复制样式代码/类名/数值；全部文案自撰。

## 现状（调查结论 2026-10-17）

档位管线已完整：档位事实源 = 模型配置 `optionSpecs.reasoningLevel.values`
（`bootstrap/src/app/model-catalog-port.ts:44-56` 复制为 reasoningLevels，末位=默认档）；
composer 已有 `chat-input-toolbar/ThoughtLevelCycleControl.tsx`（select/cycle 双模式 +
档位进度条视觉 :206-221 + Ctrl+T 循环 :922-935）；写路径 `handleThoughtValueChange →
onSelectThought → handleDraftSelectThought`（草稿=下一次提交意图；已运行会话走 v4
`switchModelConfig` 命令）——**滑条是纯 ui 增强，零协议/零 runtime 改动**。

## 产品规则

1. 入口：composer 工具栏既有「思考 · 档名」控件；点击打开滑条面板（Popover，参照
   `ChatPromptActionMenu` 的 PopoverAnchor 用法）；Ctrl+T 循环切档保留不动。
2. 面板：标题行（「思考强度」+ 当前档名胶囊）+ 滑条本体。宽度 `min(240px, 100vw−24px)`
   量级；菜单壳遵守 DESIGN.md §Menus, Popovers, Dialogs（bg-popover/shadow-md/圆角规范）。
3. 档位映射：当前模型 `thoughtLevels` 按配置声明序映射到 0..n−1 离散轨道，**动态、
   不硬编码档位名**；切模型档数变化自动跟随；档位显示名走既有别名表
   （`thoughtLevelOptions.ts`）+ i18n。
4. 拖拽手感：拖动中连续浮点预览跟手（旋钮/档名预览实时），松手吸附最近档
   （round）提交；←→/Home/End 键盘切档提交（Radix Slider 原生支持）；提交期间
   busy 态（降透明度），提交失败回弹原档位并给错误态提示（不静默）。
5. 即时生效：走既有写路径（草稿态=下一次提交意图；运行中会话=switchModelConfig），
   与原生控件语义一致。
6. 隐藏条件：模型无思考档位/单档位固定时沿用既有控件条件，不显示滑条不占空间。
7. 无障碍与主题：`prefers-reduced-motion`（含 appearancePreferences 的 reduce-motion
   data 属性）下关动画；主题走 CSS tokens 自适应，不写死深浅色值。

## 实现形态

- 新 `packages/ui/src/components/ui/slider.tsx`：封装聚合依赖 `radix-ui@^1.4.3` 已导出
  的 Slider（**零新增依赖**；仓内无既有 slider 组件，WhiteboardPane 的 range input 仅作
  参照不共用）。
- 新 `packages/ui/src/chat-input-toolbar/ThoughtSliderPanel.tsx`（纯 props 展示件，跟随
  chat-input-toolbar「展示件纯 props、v4 wiring 另层」惯例）+ 滑条轨道/旋钮样式进
  既有样式体系。
- **inert-until-wired**：ThoughtLevelCycleControl/V4ComposerToolbar 的入口改造与模式
  切换（默认 slider 面板、select 模式保留为降级 prop）由编排者接线；实现代理只交付
  新组件+测试+i18n key 清单（`chat.toolbar.thoughtLevel.*` 族内新增，locales 文件
  编排者独占）。
- e2e 锚点：`data-thought`/`data-thought-levels`（V4ComposerToolbar.tsx:979-991）保持
  不变；滑条面板补 `data-thought-slider` 锚点。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| 可用档位与当前档 | 既有草稿/会话投影（composerDraftStore / session-config thought） |
| 滑条面板开合 | v4 composer picker 互斥状态（configPickerState "thought" 槽） |
| 档位提交 | 既有 handleThoughtValueChange 链（不新增写路径） |

## 验收场景

1. 组件测试：档位映射（3/5/8 档动态）、拖动预览与松手吸附、键盘切档、busy/失败回弹、
   无档位隐藏、reduced-motion。
2. 接线后回归：Ctrl+T 循环不变、data 锚点不变、草稿与运行中会话两条写路径即时生效。
3. E2E（desktop dev）：拖滑条切档 → 下一次提交携带对应 reasoningLevel（turn-model.ts
   消费点日志/事件核对）。
