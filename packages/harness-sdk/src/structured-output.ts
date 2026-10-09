// 结构化输出内部实现（自 session.ts 拆出的内聚内部模块，行为保持原样）：
// session.ask() 的两块支撑逻辑——模型输出的 JSON 提取与 zod schema 的轻量
// JSON 描述。放在中立文件里让 session.ts 回到 400 行物理上限之内。

import type { z } from "zod";

/** 提取模型输出里的 JSON 对象（容忍 markdown fence / 前后闲话）。 */
export function parseJsonOutput(
  output: string,
): { ok: true; value: unknown } | { ok: false; issue: string } {
  const text = output.trim();
  if (text.length === 0) return { ok: false, issue: "empty response" };
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace)
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // 尝试下一个候选。
    }
  }
  return { ok: false, issue: "response is not valid JSON" };
}

/**
 * 用 zod 的 def 生成轻量 JSON 描述（不引第三方 schema 转换）。
 * M8：补标量类型识别——此前除 object 外全部落 {type:"any"}，模型收到的
 * requirement 不含任何类型信息（z.number()/z.enum() 全部退化为 any，实证缺陷）。
 * 导出供 SDK 消费方诊断 requirement 与测试回归使用。
 */
export function describeZodSchema(schema: z.ZodType): unknown {
  const def = (
    schema as unknown as {
      _zod?: {
        def?: {
          type?: string;
          innerType?: unknown;
          entries?: Record<string, unknown>;
          values?: unknown[];
          shape?: Record<string, z.ZodType>;
        };
      };
    }
  )._zod?.def;
  if (!def) return { type: "any" };
  switch (def.type) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "enum":
      return { type: "string", enum: Object.values(def.entries ?? {}) };
    case "literal":
      return { type: "literal", value: def.values?.[0] };
    case "optional":
    case "nullable":
    case "default": {
      // 包装类型：递归内层并标记 optional（nullable/default 近似为可缺省）。
      const inner = describeZodSchema(def.innerType as z.ZodType);
      return { ...(inner as Record<string, unknown>), optional: true };
    }
    default:
      break;
  }
  if (def.shape) {
    const out: Record<string, unknown> = { type: "object", properties: {} };
    const properties = out.properties as Record<string, unknown>;
    for (const [key, value] of Object.entries(def.shape)) {
      properties[key] = describeZodSchema(value);
    }
    return out;
  }
  return { type: "any" };
}
