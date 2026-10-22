# 架构 ratchet 物理行计数契约

## 规则

1. `max-file-lines` 按物理行数比较，文件末尾的换行符不产生额外空行。
2. 同一份内容不论使用 LF 还是 CRLF，行数都一致。
3. 工作树计数与 `git HEAD` 计数使用同一个函数；收回上限的 legacy 文件再次保持在上限内时不得产生 `max-file-lines-regrown`。
4. 真实新增一行仍必须被 ratchet 识别，不能通过删除末尾换行符规避。

## 验收场景

- `"a\n"` 和 `"a"` 均计为 1 行。
- `"a\r\nb\r\n"` 计为 2 行。
- 400 行正文加一个末尾换行仍为 400 行；第 401 行正文必须计为 401 行。

## 边界声明的 ratchet 语义（resolver 三缺口，2026-10-22）

deep-import 门禁的边界声明（`publicEntrypoints` / `publicEntrypointPatterns` /
`internalEdgeAllowlist`）遵循「只收紧不放宽」的 ratchet 纪律，与 max-file-lines 同源：

1. **新增解析能力不得放宽既有边界**。exports map 解析、通配入口、asset 豁免、内部边白名单
   全部 fail-closed：默认（未声明）不匹配任何文件、不豁免任何 specifier、不放行任何边。
   能力只在 policy 显式声明后生效，声明范围外的 deep-import 仍报违规。
2. **通配入口只放行声明目录范围**。`publicEntrypointPatterns` 未匹配到任何文件的 pattern
   等同无入口（不产生「宽松空集」）；范围外的新 deep-import 仍是 new violation。因此把
   逐一显式登记收敛为通配，只有当「目录内全部文件确为公开面」时才不放宽边界——server 的
   `remote/*.ts`（47 文件中仅 5 个被消费）不满足，故保留显式登记，不收敛为通配。
3. **内部边白名单只减不增**。白名单冻结存量 (from,to) 边使其合法，未登记的新边立即报
   deep-import（把「惰性合法」变成「新增需显式登记」）。迁移方向是逐条从白名单删除、迁到
   `contract.ts`，白名单见底即注册公开入口。到期（2026-12-31）前白名单必须清空，与
   over-limit / disable 例外同批偿还，不续期。
4. **asset 豁免集合窄且可审计**。`global.assetExtensions` 按仓库实测静态资源面登记
   （当前 `.css/.svg/.png/.mp3`），扩展名不在集合内的 side-effect import（如 `./foo.ts`）
   不豁免、照常按源码边校验；新增 asset 类型时在 policy 登记，不硬编码进 checker。

### 验收场景（边界 ratchet）

- 通配范围内合法入口放行；范围外 deep-import 报违规（相对/包名/动态/re-export 四种写法一致判定）。
- asset specifier（`.css`/`.svg`）放行；伪装成 asset 的 `.ts` side-effect deep-import 不豁免。
- exports remap 子路径解析到登记入口放行；解析到未登记文件仍报 deep-import；纯 `.d.ts`
  target 不作依赖边（不误报 deep-import）。
- 白名单登记的 (from,to) 边放行；同 target 的未登记新 importer 边报 deep-import。
- 以上负向场景对应 fixture：`apps/acode-cli/tests/architecture-coverage.test.mjs`。
