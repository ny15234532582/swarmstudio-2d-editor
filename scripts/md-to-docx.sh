#!/usr/bin/env bash
#
# 把 docs/design.md 转成 docs/design.docx（Word 交付版）。
#
# 依赖：pnpm（用 `pnpm dlx marked` 拉取临时转换器）+ LibreOffice（soffice）。
# 不用 pandoc，因此无需额外安装 Node/Python 包。
#
# 用法：bash scripts/md-to-docx.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "1/3 Markdown -> HTML"
pnpm dlx marked@14 -i docs/design.md -o /tmp/design_body.html

echo "2/3 包一层带样式的 HTML（表格边框 / 代码块 / 中文字体）"
python3 - <<'PY'
body = open('/tmp/design_body.html', encoding='utf-8').read()
html = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>SwarmStudio 二维点阵编辑器 · 设计说明</title>
<style>
body { font-family: "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 11pt; line-height: 1.6; }
h1 { font-size: 20pt; } h2 { font-size: 15pt; margin-top: 1.2em; } h3 { font-size: 12.5pt; }
table { border-collapse: collapse; width: 100%; margin: 0.6em 0; }
th, td { border: 1px solid #999; padding: 4px 8px; font-size: 10pt; vertical-align: top; }
th { background: #f0f0f0; }
code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 9.5pt; background: #f5f5f5; }
pre { background: #f5f5f5; border: 1px solid #ddd; padding: 8px; font-size: 9pt;
      font-family: "SF Mono", Menlo, Consolas, monospace; white-space: pre-wrap; }
</style>
</head>
<body>
""" + body + "\n</body>\n</html>\n"
open('/tmp/design_full.html', 'w', encoding='utf-8').write(html)
print('  写出 /tmp/design_full.html')
PY

echo "3/3 HTML -> docx（LibreOffice）"
rm -rf /tmp/lo_profile
soffice -env:UserInstallation=file:///tmp/lo_profile --headless \
  --infilter="HTML (StarWriter)" \
  --convert-to 'docx:MS Word 2007 XML' \
  --outdir docs /tmp/design_full.html
mv -f docs/design_full.docx docs/design.docx

echo "完成 -> docs/design.docx"
