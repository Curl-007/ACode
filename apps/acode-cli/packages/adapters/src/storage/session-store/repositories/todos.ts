import type { DatabaseSync } from "node:sqlite";
import type { SessionId, TodoItem } from "@acode/contracts";
import { decodeTodoRow, encodeTodoConfidence, encodeTodoDeps } from "../codecs.js";
import type { TodoRow } from "../rows.js";
import { touchSession } from "./sessions.js";

export async function readTodos(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): Promise<TodoItem[]> {
  const rows = db
    .prepare(
      `
      select * from todo
      where session_id = ?
      order by position asc
      `,
    )
    .all(input.sessionID) as unknown as TodoRow[];

  return rows.map(decodeTodoRow);
}

export async function updateTodos(
  db: DatabaseSync,
  input: { sessionID: SessionId; todos: TodoItem[] },
): Promise<void> {
  const now = Date.now();

  db.exec("begin immediate");
  try {
    db.prepare("delete from todo where session_id = ?").run(input.sessionID);
    if (input.todos.length > 0) {
      // D4：deps_json 是 id/blockedBy/metadata 的唯一持久化家（migration 0023，nullable）。
      // J2-1：confidence_json 是 completionConfidence/confidenceHistory 的唯一持久化家
      // （migration 0024，nullable，specs/todo-confidence-semantics.md R5）。
      // 写入的是调用方给的规范化结果，本层不再做第二份规范化（唯一写入路径纪律）。
      const insert = db.prepare(
        `
        insert into todo (
          session_id, content, status, priority, position, time_created, time_updated, deps_json, confidence_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );

      for (const [position, todo] of input.todos.entries()) {
        insert.run(
          input.sessionID,
          todo.content,
          todo.status,
          todo.priority,
          position,
          now,
          now,
          encodeTodoDeps(todo),
          encodeTodoConfidence(todo),
        );
      }
    }
    touchSession(db, input.sessionID, now);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
