#!/usr/bin/env python3
"""Modified 2026-10-09: escaped, self-contained HTML; no CDN/JavaScript."""
import argparse
from html import escape
import json
import math
import os
from pathlib import Path
import sys

def number(value):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):
        raise ValueError('报告金额必须为有限数字；请重新生成分析文件。')
    return float(value)

def money(value): return f'{number(value):,.2f}'
def safe(value): return escape(str(value),quote=True)

def render(data):
    s=data['summary']; viz=data['visualization_data']
    cards=''.join(f'<section class="card"><h2>{label}</h2><strong>{money(s[key])}</strong></section>' for label,key in [
        ('总收入','total_income'),('总支出','total_expenses'),('结余','net_savings')])
    rate='不可计算' if s['savings_rate'] is None else f'{number(s["savings_rate"]):.1f}%'
    cards+=f'<section class="card"><h2>结余率</h2><strong>{rate}</strong></section>'
    category=viz['category_spending']
    values=[number(v) for v in category.values()]
    if any(v<0 for v in values): raise ValueError('分类支出不能为负；请重新生成分析。')
    maximum=max(values,default=0)
    bars=''.join(f'<div class="bar-row"><span>{safe(label)}</span><div class="bar-track"><div class="bar" style="width:{value/maximum*100 if maximum else 0:.2f}%"></div></div><b>{money(value)}</b></div>' for (label,_),value in zip(category.items(),values))
    if not bars: bars='<p>暂无支出记录。</p>'
    months=''.join(f'<tr><td>{safe(r["month"])}</td><td>{money(r["income"])}</td><td>{money(r["expenses"])}</td></tr>' for r in viz['monthly_comparison'])
    top=''.join(f'<tr><td>{safe(r["Date"])}</td><td>{safe(r["Description"])}</td><td>{money(r["Amount"])}</td></tr>' for r in data['trends']['top_expenses'])
    notes=''.join(f'<li>{safe(t)}</li>' for t in data.get('recommendations',[])+data.get('warnings',[]))
    period=s['date_range']; dates='暂无日期' if period['start'] is None else safe(period['start'])+' 至 '+safe(period['end'])
    return """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>收支预算报告</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f6fa;color:#17283d;font:16px/1.6 system-ui,sans-serif}main{max-width:1040px;margin:auto;padding:32px 20px}h1{margin:0;font-size:30px}h2{font-size:19px}header{padding:16px 0 24px}.muted{color:#5d6b7b}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.card,.panel{background:white;border:1px solid #dae2ec;border-radius:12px;padding:20px}.card h2{font-size:15px;font-weight:500;margin:0 0 12px}.card strong{font-size:25px;overflow-wrap:anywhere}.panel{margin-top:18px}.bar-row{display:grid;grid-template-columns:minmax(80px,1fr) 2fr 100px;gap:12px;align-items:center;margin:12px 0}.bar-row span{overflow-wrap:anywhere}.bar-track{background:#edf1f7;height:14px;border-radius:7px;overflow:hidden}.bar{background:#3477bc;height:100%}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #e8edf3;overflow-wrap:anywhere}td:last-child,th:last-child{text-align:right}.scroll{overflow-x:auto}footer{padding:20px 0;font-size:14px}@media(max-width:640px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.bar-row{grid-template-columns:80px 1fr 80px}.card{padding:14px}.card strong{font-size:21px}}@media print{body{background:white}.panel,.card{break-inside:avoid}}
</style></head><body><main>"""+f"""<header><h1>收支预算报告</h1><div class="muted">{dates} · 币种：{safe(data.get('currency','未指定'))} · {int(s['transaction_count'])} 笔记录</div></header>
<div class="cards">{cards}</div><section class="panel"><h2>支出分类</h2>{bars}</section>
<section class="panel"><h2>月度收支</h2><div class="scroll"><table><thead><tr><th>月份</th><th>收入</th><th>支出</th></tr></thead><tbody>{months or '<tr><td colspan="3">暂无记录</td></tr>'}</tbody></table></div></section>
<section class="panel"><h2>最大支出（最多五笔）</h2><div class="scroll"><table><thead><tr><th>日期</th><th>描述</th><th>金额</th></tr></thead><tbody>{top or '<tr><td colspan="3">暂无记录</td></tr>'}</tbody></table></div></section>
<section class="panel"><h2>核对与预算提示</h2><ul>{notes}</ul></section>
<footer class="muted">此文件包含输入记录的汇总和部分描述，请仅在获准范围内保存和分享。本报告未载入外部脚本、字体或图片。</footer></main></body></html>"""

def generate_html_report(data,filename):
    result=render(data)
    descriptor=os.open(filename,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(descriptor,'w',encoding='utf-8') as stream: stream.write(result)

def main():
    parser=argparse.ArgumentParser(description='生成不联网的 HTML 收支报告。')
    parser.add_argument('input');parser.add_argument('output');args=parser.parse_args()
    try:
        data=json.loads(Path(args.input).read_text(encoding='utf-8'))
        generate_html_report(data,args.output)
    except FileExistsError:
        print('处理未完成：输出文件已存在；请使用新文件名，未覆盖旧文件。',file=sys.stderr);return 2
    except (OSError,ValueError,KeyError,TypeError,OverflowError):
        print('处理未完成：请检查分析JSON结构、有限数值及输入输出文件权限。',file=sys.stderr);return 2
    print('报告已保存到指定文件。');return 0

if __name__=='__main__': raise SystemExit(main())
