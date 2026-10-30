// 2026-12-31 例外债务偿还：自 main.ts 按职责拆出——d3 列带渲染层
//（renderColumnBands 绘制 State/Action/Guard/Effect/Case 列背景与标题）。
// 逐字迁移，零行为改动；d3 Selection 绘制依赖真实 SVG，不单测。

import * as d3 from "d3";
import { columnLabel, type StateSpaceGraph } from "./graphModel.js";

export function renderColumnBands(
  group: d3.Selection<SVGGElement, unknown, null, undefined>,
  graph: StateSpaceGraph,
): void {
  const bandWidth = 282;
  const left = 18;
  const labelTop = 18;
  const columnWidth = 304;

  const bands = group.append("g").attr("class", "column-bands");
  const column = bands
    .selectAll("g.column-band")
    .data(graph.columns)
    .join("g")
    .attr("class", "column-band")
    .attr("transform", (item) => `translate(${left + item * columnWidth},0)`);

  column
    .append("rect")
    .attr("x", 0)
    .attr("y", 8)
    .attr("width", bandWidth)
    .attr("height", graph.height - 24)
    .attr("rx", 8);

  column
    .append("text")
    .attr("x", 10)
    .attr("y", labelTop)
    .text((item) => columnLabel(item));
}
