# 组件归档解包（component archive extraction）

所有者：`acode-server-cli` 模块 `runtime/componentCache.ts`（导出 `extractArchiveSafely`，
唯一消费方 `runtime/releaseInstaller.ts`）。本 spec 记录解包机制的契约与选型依据；
路径安全、符号链接与重复条目校验的实现在同一文件内，不变量如下。

## 契约

- `tar.gz`：走系统 `tar`（`-tzf` 清单 + `-tvf` 链接检查 + `-xzf` 解包三段），清单逐条
  过 `safeRelativePath`（拒绝绝对路径、`..` 段、NUL）。
- `zip`：**同进程 yauzl `fromBuffer` 内存解压**。不使用 yauzl 的 fd 流式路径
  （`yauzl.open` + `openReadStream`）。逐条目校验：`safeRelativePath`、重复条目拒绝、
  unix mode 符号链接拒绝（`externalFileAttributes` 高 16 位 `S_IFLNK`）、落盘 mode 0600。
- 两种格式的校验语义必须一致：不安全路径、符号链接、重复条目一律抛错终止，
  不产出部分解包结果由调用方兜底（调用方在 incoming 目录解包，失败整体丢弃）。

## zip 为什么走内存解压（2026-10-20）

yauzl 的 fd 流式读取路径在解压部分 deflate 条目时会**永久挂起**：`openReadStream`
回调已触发，流的 `data`/`end`/`error` 事件均不再出现。上游 ZCodium #29 在
yauzl 3.3.0/3.4.0 均实证，最小复现 = 512KB 不可压缩随机数据构造的 deflate 条目
（GitHub zipball 源随体积增大易命中，曾致「从 GitHub 添加市场」静默挂死），
其修复同为改内存解压。本仓复现记录：Windows + lock yauzl 3.3.0，单条目 512KB
fixture 走旧 fd 路径**未**复现挂起（10s 内完整解出）——本改动属风险模式一致的
加固而非本机复现驱动；挂起一旦发生即远端组件安装静默卡死且无法自愈，而内存
解压无行为代价。

内存上限说明：本模块 `findArchive`/`putArchive` 为做 sha256 校验本就将归档整档
`readFile` 入内存，解包对象是刚完成校验的同一份组件归档，`fromBuffer` 不引入
新的内存上限，故不另设尺寸闸。

## 回归

`tests/component-cache-zip-extract.test.mjs`：不可压缩 deflate 条目在测试时限内
完整解出且字节一致（挂起即超时失败）；多条目/嵌套目录/stored 条目；重复条目、
符号链接条目、`..` 路径条目拒绝。
