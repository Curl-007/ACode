#!/usr/bin/env python3
"""2026-10-09: local-only, fixed-version adapter; requires platform network sandbox."""
import argparse
from importlib.metadata import version, PackageNotFoundError
import os
from pathlib import Path
import sys

REQUIRED_VERSION='0.1.2'
ALLOWED={'.pdf','.docx','.pptx','.xlsx','.xls','.html','.htm','.csv','.json','.txt','.md'}

def convert(source, destination):
    if '://' in str(source): raise ValueError('不接受网络URL；请使用任务中有权处理的本地文件。')
    p=Path(source)
    if p.suffix.lower() not in ALLOWED: raise ValueError('格式不在本地允许列表；不处理音视频、压缩包或插件。')
    if not p.is_file(): raise ValueError('缺少本地输入文件；请检查当前任务路径。')
    out=Path(destination)
    if out.suffix.lower() != '.md': raise ValueError('输出须使用新的 .md 文件名。')
    if out.exists(): raise ValueError('输出已存在；请使用新文件名，未覆盖原件。')
    try: installed=version('markitdown')
    except PackageNotFoundError: raise ValueError('缺少预装的 MarkItDown 0.1.2 及已审依赖；请由平台管理员准备，不自动安装。') from None
    if installed != REQUIRED_VERSION: raise ValueError('MarkItDown 版本不符，要求 0.1.2；请由平台管理员核对固定环境。')
    from markitdown import MarkItDown
    converter=MarkItDown(enable_plugins=False)
    result=converter.convert_local(str(p))
    if not result.text_content or not result.text_content.strip():
        raise ValueError('未提取到文字；扫描件可能需要已批准的OCR，未自动上传。')
    descriptor=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(descriptor,'w',encoding='utf-8') as stream: stream.write(result.text_content)

def main():
    parser=argparse.ArgumentParser(description='固定版本本地 Markdown 转换，无云服务参数。')
    parser.add_argument('input');parser.add_argument('output');args=parser.parse_args()
    try: convert(args.input,args.output)
    except ValueError as exc: print('转换未完成：'+str(exc),file=sys.stderr);return 2
    except (OSError,ImportError): print('转换未完成：文件权限或已审格式依赖缺失；请核对路径和固定环境。',file=sys.stderr);return 2
    except Exception: print('转换未完成：格式处理失败；请核对原件或使用已审替代工具，未自动启用云服务。',file=sys.stderr);return 2
    print('Markdown 已保存；请复核表格、公式和扫描页。');return 0

if __name__=='__main__': raise SystemExit(main())
