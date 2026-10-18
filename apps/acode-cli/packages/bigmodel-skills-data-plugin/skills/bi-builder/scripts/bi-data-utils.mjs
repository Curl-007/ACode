// Added 2026-10-09. Pure data utilities: no network, database, or authorization implementation.
// Call only on the server after tenant/row/column authorization and aggregation.

function cell(value, type) {
  if (value === null || value === undefined) return '""';
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('数值列出现非有限数字；请核对数据口径。');
    }
    return String(value);
  }
  if (typeof value !== 'string') throw new Error('文本列类型错误；请使用明确的服务端字段定义。');
  // Quoting is CSV syntax, not a formula defense. Prefix risky text before CSV encoding.
  const text = /^[\s\u0000-\u001f]*[=+\-@]/u.test(value) || /^[\u0000-\u001f]/u.test(value)
    ? "'" + value : value;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function serializeApprovedRows(rows, columns) {
  if (!Array.isArray(rows) || !Array.isArray(columns) || columns.length === 0) {
    throw new Error('缺少已授权结果或服务端字段白名单。');
  }
  const keys = new Set();
  for (const c of columns) {
    if (!c || typeof c.key !== 'string' || !c.key || typeof c.label !== 'string' ||
        !['text', 'number'].includes(c.type) || keys.has(c.key)) {
      throw new Error('字段白名单格式不正确或重复。');
    }
    keys.add(c.key);
  }
  const lines = [columns.map(c => cell(c.label, 'text')).join(',')];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('导出记录不是对象。');
    lines.push(columns.map(c => cell(Object.hasOwn(row, c.key) ? row[c.key] : null, c.type)).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function indexSeries(series) {
  if (!Array.isArray(series)) throw new Error('时间序列须为数组。');
  const index = new Map();
  for (const item of series) {
    if (!item || !validDate(item.date) || index.has(item.date) ||
        !(item.value === null || (typeof item.value === 'number' && Number.isFinite(item.value)))) {
      throw new Error('时间序列存在无效日期、重复日期或无效数值。');
    }
    index.set(item.date, item.value);
  }
  return index;
}

export function alignPeriods(currentData, previousData, periodMap) {
  // periodMap is explicitly chosen from the business calendar, e.g. same day-of-month.
  // No index matching and no assumption that missing observations equal zero.
  if (!Array.isArray(periodMap)) throw new Error('缺少已确认的跨期日期映射。');
  const current = indexSeries(currentData), previous = indexSeries(previousData);
  const seenCurrent = new Set(), seenPrevious = new Set(), labels = new Set();
  const result = periodMap.map(p => {
    if (!p || typeof p.label !== 'string' || !p.label || labels.has(p.label) ||
        !validDate(p.currentDate) || !(p.previousDate === null || validDate(p.previousDate)) ||
        seenCurrent.has(p.currentDate) || (p.previousDate !== null && seenPrevious.has(p.previousDate))) {
      throw new Error('跨期日期映射不完整、重复或日期无效。');
    }
    labels.add(p.label); seenCurrent.add(p.currentDate);
    if (p.previousDate !== null) seenPrevious.add(p.previousDate);
    return {date:p.label, current:current.get(p.currentDate) ?? null,
            previous:p.previousDate === null ? null : previous.get(p.previousDate) ?? null};
  });
  if ([...current.keys()].some(k => !seenCurrent.has(k)) || [...previous.keys()].some(k => !seenPrevious.has(k))) {
    throw new Error('存在未纳入映射的日期；请先补齐业务时间口径。');
  }
  return result;
}
