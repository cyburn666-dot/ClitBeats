import os
from docx import Document
import json
from pathlib import Path

input_dir = "input"
output_dir = "output"

os.makedirs(output_dir, exist_ok=True)

for filename in os.listdir(input_dir):
    if filename.lower().endswith(".docx"):
        docx_path = os.path.join(input_dir, filename)
        txt_name = os.path.splitext(filename)[0] + ".lrc"
        txt_path = os.path.join(output_dir, txt_name)

        doc = Document(docx_path)

        lines = []
        for para in doc.paragraphs:
            lines.append(para.text)

        text = "\n".join(lines)

        with open(txt_path, "w", encoding="utf-8") as f:
            f.write(text)

        print(f"已转换: {filename} -> {txt_name}")

print("全部完成")