---
name: office-files
description: "Read, create or edit PDF, Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files with scripts."
---
# Approach
Office files are binary — never edit them as text. Use a script (Python preferred) with a well-known library; install it if missing (`pip install ...`).

| Format | Read | Create / edit |
|---|---|---|
| PDF | `pypdf` (text, pages), `pdfplumber` (tables, layout) | `reportlab` (new), `pypdf` (merge, split, rotate, fill forms) |
| DOCX | `python-docx` | `python-docx` (paragraphs, styles, tables, headers) |
| XLSX | `openpyxl`, `pandas.read_excel` | `openpyxl` (formulas, formatting, charts); keep formulas instead of hard-coded values |
| PPTX | `python-pptx` | `python-pptx` (slides from layouts, text, images, tables) |

# Rules
- Write the script to a file, run it, check its output; never overwrite the original — save to a new file unless the user asked.
- Preserve existing formatting and styles when editing.
- After creating a file, re-open it with the reader library to verify the content.
- For scanned PDFs (no text layer) say that OCR is needed (`pytesseract` + `pdf2image`).
