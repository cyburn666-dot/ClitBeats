from pathlib import Path
from docx import Document
import core_utils

def collect_docx_files(input_dir: Path) -> list[Path]:
    """
    收集 input 目录下所有 docx 文件。
    """
    return list(input_dir.glob("*.docx"))


def extract_paragraph_texts(docx_path: Path) -> list[str]:
    """
    提取 docx 所有段落文本。
    """
    doc = Document(docx_path)
    return [para.text for para in doc.paragraphs]


def build_lrc_text(lines: list[str]) -> str:
    """
    将段落列表拼接为 lrc 文本。
    这里只做纯文本输出，不自动加时间轴。
    """
    return "\n".join(lines)


def get_output_lrc_path(docx_path: Path, output_dir: Path) -> Path:
    """
    根据 docx 文件名生成对应的 lrc 输出路径。
    """
    return output_dir / f"{docx_path.stem}.lrc"


def write_text_file(file_path: Path, text: str) -> None:
    """
    写入文本文件。
    """
    file_path.write_text(text, encoding="utf-8")


def convert_docx_to_lrc(docx_path: Path, output_dir: Path) -> None:
    """
    将单个 docx 转为 lrc。
    """
    try:
        lines = extract_paragraph_texts(docx_path)
        text = build_lrc_text(lines)
        output_path = get_output_lrc_path(docx_path, output_dir)
        write_text_file(output_path, text)
        # print(f"[歌词转换] {docx_path.name} -> {output_path.name}")
        core_utils.Logs.warning(f'{docx_path.name} -> {output_path.name}','歌词转换')
    except Exception as e:
        # print(f"[歌词转换失败] {docx_path.name}: {e}")
        core_utils.Logs.error(f'{docx_path.name}: {e}','歌词转换失败')


def convert_all_docx_to_lrc(input_dir: Path, output_dir: Path) -> None:
    """
    批量将 input 目录下的 docx 转为 lrc。
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    docx_files = collect_docx_files(input_dir)
    if not docx_files:
        # print("input 目录没有找到 docx 文件")
        core_utils.Logs.info(f'input 目录没有找到 docx 文件')
        return

    for docx_path in docx_files:
        convert_docx_to_lrc(docx_path, output_dir)