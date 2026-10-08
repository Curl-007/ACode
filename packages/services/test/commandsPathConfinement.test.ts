import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import type { CommandConfig } from "@acode/shared";
import { createCommandsService } from "../src/commands/commandsService.js";

/**
 * M7/M8 修复守护：commandsService 的自由格式路径入参与 config.name 收口。
 * 根因：RPC 参数是裸 string 且 rpc 层无 schema 校验——deleteCommandFile 直接 rm(filePath)、
 * updateCommandFile 直接 readFile/rm(oldFilePath)（内容经返回值外泄）、getCommandFileName
 * 不净化 ".." 段可穿越 commandsRoot 写出，配合 oldFilePath==newFilePath 跳过存在性检查
 * 可覆盖任意已存在文件。
 * spec: packages/services/specs/service-fs-path-confinement.md R2/R3。
 */

let home: string;
let workspace: string;
let victimDir: string;
let savedHome: string | undefined;
let savedProfile: string | undefined;

function commandsRoot(): string {
  return join(home, ".acode", "commands");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function configOf(name: string, prompt = "test prompt"): CommandConfig {
  return { name, prompt };
}

async function createVictimFile(fileName: string, content = "VICTIM-SECRET"): Promise<string> {
  const victimFile = join(victimDir, fileName);
  await writeFile(victimFile, content, "utf-8");
  return victimFile;
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), "acode-cmd-home-"));
  workspace = await mkdtemp(join(tmpdir(), "acode-cmd-ws-"));
  victimDir = await mkdtemp(join(tmpdir(), "acode-cmd-victim-"));
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  // commandsService 的 resolveUserHomeDir 在调用期读 HOME/USERPROFILE。
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
});

test("writeCommandFile + deleteCommandFile：受控根内命令照常创建与删除", async () => {
  const service = createCommandsService();
  const { command } = await service.writeCommandFile({ config: configOf("/my-cmd") });
  assert.equal(command.filePath, join(commandsRoot(), "my-cmd.md"));
  assert.equal(await exists(command.filePath), true);

  await service.deleteCommandFile({ commandId: command.id, filePath: command.filePath });
  assert.equal(await exists(command.filePath), false);
});

test("deleteCommandFile：受控根外任意路径拒绝且目标原样保留", async () => {
  const service = createCommandsService();
  const victimFile = await createVictimFile("delete-target.md");

  await assert.rejects(
    () => service.deleteCommandFile({ commandId: "x:acode:global:/any", filePath: victimFile }),
    /outside managed command directories/iu,
  );
  assert.equal(await exists(victimFile), true);
});

test('deleteCommandFile：".." 穿越字符串拒绝（原始未规范化路径）', async () => {
  const service = createCommandsService();
  await mkdir(commandsRoot(), { recursive: true });
  const victimFile = join(tmpdir(), `acode-cmd-traversal-victim-${process.pid}.md`);
  await writeFile(victimFile, "VICTIM", "utf-8");
  // commandsRoot 向上三级即 tmpdir：模拟被攻破客户端直接拼接穿越段。
  const traversal = `${commandsRoot()}/../../../${basename(victimFile)}`;

  await assert.rejects(
    () => service.deleteCommandFile({ commandId: "x:acode:global:/any", filePath: traversal }),
    /outside managed command directories/iu,
  );
  assert.equal(await exists(victimFile), true);
});

test("deleteCommandFile：项目级命令按结构兜底允许，.agents 只读来源与越目录拒绝", async () => {
  const service = createCommandsService();
  const projectCommands = join(workspace, ".acode", "commands");
  await mkdir(projectCommands, { recursive: true });
  const projectFile = join(projectCommands, "proj-cmd.md");
  await writeFile(projectFile, "# proj", "utf-8");
  await service.deleteCommandFile({
    commandId: "x:acode:project:/proj-cmd",
    filePath: projectFile,
  });
  assert.equal(await exists(projectFile), false, "项目级命令文件应可删除");

  // .agents/commands 是只读来源（isEditableUserCommand 要求 location.source==="acode"）。
  const agentsCommands = join(workspace, ".agents", "commands");
  await mkdir(agentsCommands, { recursive: true });
  const agentsFile = join(agentsCommands, "readonly.md");
  await writeFile(agentsFile, "# readonly", "utf-8");
  await assert.rejects(
    () =>
      service.deleteCommandFile({ commandId: "x:agents:project:/readonly", filePath: agentsFile }),
    /outside managed command directories/iu,
  );
  assert.equal(await exists(agentsFile), true);

  // 项目 workspace 内、命令目录外的文件同样拒绝。
  const workspaceSecret = join(workspace, "secret.md");
  await writeFile(workspaceSecret, "SECRET", "utf-8");
  await assert.rejects(
    () =>
      service.deleteCommandFile({
        commandId: "x:acode:project:/secret",
        filePath: `${projectCommands}/../../secret.md`,
      }),
    /outside managed command directories/iu,
  );
  assert.equal(await exists(workspaceSecret), true);
});

test("deleteCommandFile：受控根内不存在的路径保持幂等成功（absent no-op）", async () => {
  const service = createCommandsService();
  await mkdir(commandsRoot(), { recursive: true });
  await service.deleteCommandFile({
    commandId: "x:acode:global:/gone",
    filePath: join(commandsRoot(), "gone.md"),
  });
});

test("writeCommandFile/updateCommandFile：穿越与非法 config.name 全部拒绝", async () => {
  const service = createCommandsService();
  const evilFile = join(home, "evil.md");
  const badNames = [
    "../../evil",
    "../evil",
    "/..",
    "..",
    ".",
    "a/../b",
    "a/./b",
    "a//b",
    "//evil",
    "C:/evil",
    "a\\b",
    "..\\evil",
    "a:b",
    "",
    "   ",
  ];
  for (const name of badNames) {
    await assert.rejects(
      () => service.writeCommandFile({ config: configOf(name) }),
      /Invalid command name|Command name is required|escapes commands root/iu,
      `writeCommandFile 应拒绝 name=${JSON.stringify(name)}`,
    );
    await assert.rejects(
      () =>
        service.updateCommandFile({
          commandId: "x:acode:global:/any",
          config: configOf(name),
        }),
      /Invalid command name|Command name is required|escapes commands root/iu,
      `updateCommandFile 应拒绝 name=${JSON.stringify(name)}`,
    );
  }
  assert.equal(await exists(evilFile), false, "穿越写入不得落盘");
  assert.equal(await exists(join(home, ".acode", "evil.md")), false);
});

test("updateCommandFile：受控根内改名照常（含分层名与项目 scope）", async () => {
  const service = createCommandsService();
  const { command } = await service.writeCommandFile({ config: configOf("/cmd-a") });

  const renamed = await service.updateCommandFile({
    commandId: command.id,
    config: configOf("/team/cmd-b", "updated prompt"),
    oldFilePath: command.filePath,
  });
  assert.equal(await exists(command.filePath), false, "旧文件应被删除");
  assert.equal(renamed.command.filePath, join(commandsRoot(), "team", "cmd-b.md"));
  assert.equal(await exists(renamed.command.filePath), true);
  assert.equal(renamed.command.name, "/team/cmd-b");

  // 原地更新（oldFilePath === newFilePath）是合法语义，不应被存在性检查误拒。
  const inplace = await service.updateCommandFile({
    commandId: renamed.command.id,
    config: configOf("/team/cmd-b", "inplace prompt"),
    oldFilePath: renamed.command.filePath,
  });
  assert.match(await readFile(inplace.command.filePath, "utf-8"), /inplace prompt/u);

  // 项目 scope：写入与改名均落在 <ws>/.acode/commands 内。
  const created = await service.writeCommandFile({
    config: configOf("/proj-cmd"),
    storageLevel: "project",
    workspacePath: workspace,
  });
  assert.equal(created.command.filePath, join(workspace, ".acode", "commands", "proj-cmd.md"));
  const projectRenamed = await service.updateCommandFile({
    commandId: created.command.id,
    config: configOf("/proj-cmd-2"),
    oldFilePath: created.command.filePath,
    storageLevel: "project",
    workspacePath: workspace,
  });
  assert.equal(await exists(created.command.filePath), false);
  assert.equal(await exists(projectRenamed.command.filePath), true);
});

test("updateCommandFile：越界 oldFilePath 拒绝，任意文件不可读、不可删、内容不外泄", async () => {
  const service = createCommandsService();
  const victimFile = await createVictimFile("update-victim.md", "TOP-SECRET");

  await assert.rejects(
    () =>
      service.updateCommandFile({
        commandId: "x:acode:global:/leak",
        config: configOf("/leak"),
        oldFilePath: victimFile,
      }),
    /outside managed command directories/iu,
  );
  assert.equal(await readFile(victimFile, "utf-8"), "TOP-SECRET", "越界文件必须原样保留");
  assert.equal(await exists(join(commandsRoot(), "leak.md")), false, "拒绝必须发生在任何写盘之前");
});

test("updateCommandFile：oldFilePath==newFilePath 穿越覆盖技巧失效", async () => {
  const service = createCommandsService();
  await mkdir(commandsRoot(), { recursive: true });
  const victimFile = await createVictimFile("trick-victim.md", "ORIGINAL");
  // 旧实现：config.name 穿越令 newFilePath 命中任意已存在文件，再把 oldFilePath 设为
  // 同一路径即可跳过存在性检查、静默覆盖。修复后 name 段校验先行拒绝。
  const traversalName = `../../../${basename(victimDir)}/trick-victim`;

  await assert.rejects(
    () =>
      service.updateCommandFile({
        commandId: "x:acode:global:/trick",
        config: configOf(traversalName),
        oldFilePath: victimFile,
      }),
    /Invalid command name|outside managed command directories/iu,
  );
  assert.equal(await readFile(victimFile, "utf-8"), "ORIGINAL", "任意已存在文件不可被覆盖");
});

test("updateCommandFile：受控根内指向外部的软链 oldFilePath 经 realpath 拒绝", async (t) => {
  const service = createCommandsService();
  await mkdir(commandsRoot(), { recursive: true });
  const victimFile = await createVictimFile("symlink-victim.md", "LINK-SECRET");
  const linkPath = join(commandsRoot(), "symlink-cmd.md");
  try {
    await symlink(victimFile, linkPath);
  } catch {
    t.skip("当前平台/权限不支持创建文件软链，跳过软链穿越用例");
    return;
  }

  await assert.rejects(
    () =>
      service.updateCommandFile({
        commandId: "x:acode:global:/symlink-cmd",
        config: configOf("/symlink-renamed"),
        oldFilePath: linkPath,
      }),
    /outside managed command directories/iu,
  );
  assert.equal(await readFile(victimFile, "utf-8"), "LINK-SECRET", "软链目标必须原样保留");
});
