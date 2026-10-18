#!/usr/bin/env python3
"""Modified 2026-10-09: deterministic local budget analysis, standard library only."""
import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path

FIELDS = ('Date', 'Description', 'Income', 'Type', 'Amount')

def load_transactions(filename):
    p = Path(filename)
    if p.suffix.lower() == '.csv':
        with p.open(encoding='utf-8-sig', newline='') as stream:
            reader = csv.DictReader(stream)
            if not reader.fieldnames or not set(FIELDS).issubset(reader.fieldnames):
                raise ValueError('CSV 缺少 Date、Description、Income、Type、Amount 中的字段；请按输入规范补齐。')
            source = list(reader)
    elif p.suffix.lower() == '.json':
        source = json.loads(p.read_text(encoding='utf-8-sig'))
        if not isinstance(source, list):
            raise ValueError('JSON 顶层必须是交易数组；请转换为逐笔对象列表。')
    else:
        raise ValueError('仅支持本地 CSV 或 JSON；请先用已审工具转换。')
    rows = []
    for number, row in enumerate(source, 1):
        prefix = f'第 {number} 笔'
        if not isinstance(row, dict) or not set(FIELDS).issubset(row) or any(row[k] is None for k in FIELDS):
            raise ValueError(prefix+'缺少必要字段；请补齐，未忽略此行。')
        day = str(row['Date']).strip()
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
            raise ValueError(prefix+'日期须为 YYYY-MM-DD。')
        try:
            parsed_date = date.fromisoformat(day)
        except ValueError:
            raise ValueError(prefix+'日期无效；请核对原始记录。') from None
        kind = str(row['Type']).strip()
        if kind not in ('Income', 'Expense'):
            raise ValueError(prefix+'类型仅支持 Income 或 Expense；退款/转账请先确认口径。')
        try:
            amount = Decimal(str(row['Amount']).strip())
        except InvalidOperation:
            raise ValueError(prefix+'金额不是有效数字；请使用不带币种和千分位的数值。') from None
        if not amount.is_finite() or abs(amount) > Decimal('1000000000000'):
            raise ValueError(prefix+'金额非有限值或超出支持范围。')
        if amount != amount.quantize(Decimal('0.01')):
            raise ValueError(prefix+'金额精度超过分；请先确认精度和币种。')
        if (kind == 'Income' and amount < 0) or (kind == 'Expense' and amount > 0):
            raise ValueError(prefix+'金额符号与类型矛盾；收入非负、支出非正，请核对。')
        if not all(isinstance(row[k], str) and row[k].strip() for k in ('Description','Income')):
            raise ValueError(prefix+'描述或分类为空；请补齐。')
        rows.append(dict(Date=parsed_date, Description=row['Description'].strip(),
                         Income=row['Income'].strip(), Type=kind, Amount=amount))
    return rows

def analyze(rows, currency='未指定（须确认单一币种）'):
    income = sum((r['Amount'] for r in rows if r['Type']=='Income'),Decimal(0))
    expenses = [r for r in rows if r['Type']=='Expense']
    cost = sum((-r['Amount'] for r in expenses),Decimal(0))
    cats, sources, daily = (defaultdict(Decimal) for _ in range(3))
    monthly = defaultdict(lambda: {'income':Decimal(0), 'expenses':Decimal(0)})
    for r in rows:
        if r['Type']=='Expense':
            cats[r['Income']] -= r['Amount']
            daily[r['Date'].isoformat()] -= r['Amount']
            monthly[r['Date'].isoformat()[:7]]['expenses'] -= r['Amount']
        else:
            sources[r['Description']] += r['Amount']
            monthly[r['Date'].isoformat()[:7]]['income'] += r['Amount']
    days = [r['Date'] for r in rows]
    start, end = (min(days),max(days)) if days else (None,None)
    span = (end-start).days+1 if days else 0
    to_nums = lambda d: {k:float(v) for k,v in sorted(d.items())}
    top = sorted(expenses,key=lambda r:abs(r['Amount']),reverse=True)[:5]
    seen=set(); duplicates=0
    for r in rows:
        key=tuple(r[k] for k in FIELDS)
        duplicates += int(key in seen); seen.add(key)
    warnings=['币种由调用者确认；未做换汇。','退款、转账和借贷须先人工确认分类。']
    if duplicates: warnings.append(f'存在 {duplicates} 笔完全相同记录；已保留计入，请核对是否重复。')
    return {
        'schema_version': 2, 'currency': currency,
        'summary': {'total_income':float(income),'total_expenses':float(cost),'net_savings':float(income-cost),
                    'savings_rate':float((income-cost)/income*100) if income else None,
                    'expense_by_category':to_nums(cats),'income_by_source':to_nums(sources),
                    'transaction_count':len(rows),
                    'date_range':{'start':start.isoformat() if start else None,'end':end.isoformat() if end else None}},
        'trends':{'daily_average_spending':float(cost/span) if span else 0,
                  'top_expenses':[{'Date':r['Date'].isoformat(),'Description':r['Description'],'Amount':float(abs(r['Amount']))} for r in top],
                  'category_percentages':{k:float(v/cost*100) if cost else 0 for k,v in sorted(cats.items())}},
        'recommendations':['先对账，再结合必要开支和自己的预算目标讨论调整；比例不代表财务健康结论。'] if rows else ['当前没有交易，尚不能判断支出趋势。'],
        'warnings':warnings,
        'visualization_data':{'category_spending':to_nums(cats),
                              'daily_trend':[{'date':k,'amount':float(v)} for k,v in sorted(daily.items())],
                              'monthly_comparison':[{'month':k,**to_nums(v)} for k,v in sorted(monthly.items())]}}

def main():
    parser=argparse.ArgumentParser(description='在当前任务环境内计算收支，不联网。')
    parser.add_argument('input'); parser.add_argument('--currency',default='未指定（须确认单一币种）')
    args=parser.parse_args()
    try:
        result=analyze(load_transactions(args.input),args.currency)
        print(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False))
    except (OSError,ValueError,InvalidOperation,csv.Error) as exc:
        if isinstance(exc,OSError): message='无法读取文件；请检查任务内文件路径和权限。'
        else: message=str(exc)
        print('处理未完成：'+message,file=sys.stderr)
        return 2
    return 0

if __name__=='__main__':
    raise SystemExit(main())
