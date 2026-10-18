interface CliCustomCommandContent {
  content: string;
  metadata: {
    name: string;
    scope: string;
    skills?: string[];
    source: string;
  };
}

interface CliCustomCommandExpansion {
  argumentCount: number;
  prompt: string;
  usedArgumentsPlaceholder: boolean;
}

const FENCED_SHELL_PATTERN = /```!\s*[\s\S]*?```/;
const INLINE_SHELL_PATTERN = /!`[^`]*`/;
// 单遍模板占位符（机制参照 oh-my-pi MIT，packages/coding-agent/src/utils/command-args.ts
// 的 substituteArgs；裁决见 specs/slash-positional-args.md）：
// $@[start:length] 切片 / $ARGUMENTS 整体 / $@ 聚合 / $N 位置参数。
// 备选序与 omp 一致：切片必须先于裸 $@，否则 $@[2] 会被 $@ 抢配。
const ARGUMENT_PLACEHOLDER_PATTERN = /\$@\[(\d+)(?::(\d*))?\]|\$ARGUMENTS|\$@|\$(\d+)/g;

export function expandCliCustomCommandPrompt(input: {
  args: string;
  command: CliCustomCommandContent;
}): CliCustomCommandExpansion {
  if (usesUnsupportedDynamicShell(input.command.content)) {
    throw new Error(
      `Custom command /${input.command.metadata.name} uses unsupported shell expansion. Dynamic expansion is not available yet.`,
    );
  }

  const args = input.args.trim();
  const positional = splitCliCustomCommandArguments(args);
  let usedArgumentsPlaceholder = false;
  // 单遍渲染：一次扫描完成全部占位符替换，替换结果不再进入扫描——参数值里出现的
  // $1/$@/$ARGUMENTS 按字面文本保留，不做二次展开（防注入，spec「单遍渲染语义」）。
  // 旧实现是两遍（先 $ARGUMENTS 后 $N），参数值内的 $N 会被第二遍展开并误置
  // usedArgumentsPlaceholder，属被本单遍化移除的注入面。
  let body = input.command.content.replace(
    ARGUMENT_PLACEHOLDER_PATTERN,
    (_match, sliceStart?: string, sliceLength?: string, positionalIndex?: string) => {
      usedArgumentsPlaceholder = true;
      if (positionalIndex !== undefined) {
        // 缺位参数渲染为空串（边界裁决："$3 但只给了 2 个参数" → 空串，不报错）。
        return positional[Number(positionalIndex) - 1] ?? "";
      }
      if (sliceStart !== undefined) return expandArgumentSlice(positional, sliceStart, sliceLength);
      // $ARGUMENTS 与 $@ 等价：整体替换为原始 trim 参数串（保留 ACode 既有语义；
      // omp 用重分组后 join，差异裁决见 spec「$ARGUMENTS/$@ 取值裁决」）。
      return args;
    },
  );

  if (args.length > 0 && !usedArgumentsPlaceholder) {
    body = `${body.trimEnd()}\n\nUser arguments:\n${args}`;
  }

  return {
    argumentCount: positional.length,
    prompt: [
      `Run custom command /${input.command.metadata.name}.`,
      `Command source: ${input.command.metadata.scope}/${input.command.metadata.source}.`,
      ...formatCommandSkillInstructions(input.command.metadata.skills ?? []),
      "",
      body.trim(),
    ].join("\n"),
    usedArgumentsPlaceholder,
  };
}

function formatCommandSkillInstructions(skills: string[]): string[] {
  if (skills.length === 0) return [];
  const names = skills.map((skill) => `\`${skill}\``).join(", ");
  return [
    `Required skills: ${names}.`,
    `Before following the command body, call the Skill tool for ${names}.`,
  ];
}

/**
 * $@[start:length] 切片语义（1-based，对齐 omp substituteArgs；spec 语法表）：
 * - start < 1 或起点越过参数个数 → 空串；
 * - length 省略或为空（$@[2] / $@[2:]）→ 取 start 到末尾；
 * - length ≤ 0 → 空串；
 * - 非数字形态（如 $@[2:-1]）不匹配占位符正则，整个片段保持字面量。
 */
function expandArgumentSlice(
  positional: readonly string[],
  startRaw: string,
  lengthRaw?: string,
): string {
  const start = Number.parseInt(startRaw, 10);
  if (!Number.isFinite(start) || start < 1) return "";
  const startIndex = start - 1;
  if (startIndex >= positional.length) return "";
  if (lengthRaw === undefined || lengthRaw === "") {
    return positional.slice(startIndex).join(" ");
  }
  const length = Number.parseInt(lengthRaw, 10);
  if (!Number.isFinite(length) || length <= 0) return "";
  return positional.slice(startIndex, startIndex + length).join(" ");
}

function splitCliCustomCommandArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let escaping = false;
  let quote: "'" | '"' | null = null;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current.length > 0) args.push(current);
  return args;
}

function usesUnsupportedDynamicShell(content: string): boolean {
  return INLINE_SHELL_PATTERN.test(content) || FENCED_SHELL_PATTERN.test(content);
}
