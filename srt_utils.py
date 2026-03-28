from pathlib import Path
import re
import os
import core_utils

TIME_RE = re.compile(
    r"(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})"
)

def srt_time_to_lrc(h: str, m: str, s: str, ms: str) -> str:
    total_minutes = int(h) * 60 + int(m)
    centiseconds = int(ms) // 10
    return f"[{total_minutes:02d}:{int(s):02d}.{centiseconds:02d}]"


def srt_to_lrc_text(srt_text: str) -> str:
    blocks = re.split(r"\n\s*\n", srt_text.strip())
    lrc_lines = []

    for block in blocks:
        lines = [line.strip("\ufeff").rstrip() for line in block.splitlines() if line.strip()]
        if len(lines) < 2:
            continue

        time_line_index = None
        for i, line in enumerate(lines):
            if TIME_RE.match(line):
                time_line_index = i
                break

        if time_line_index is None:
            continue

        match = TIME_RE.match(lines[time_line_index])
        start_h, start_m, start_s, start_ms = match.group(1, 2, 3, 4)

        lyric_lines = lines[time_line_index + 1 :]
        if not lyric_lines:
            lyric = ""
        else:
            lyric = " / ".join(lyric_lines)

        lrc_time = srt_time_to_lrc(start_h, start_m, start_s, start_ms)
        lrc_lines.append(f"{lrc_time}{lyric}")

    return "\n".join(lrc_lines)


def convert_srt_file_to_lrc(srt_path: Path, lrc_path: Path | None = None) -> Path:
    if lrc_path is None:
        lrc_path = srt_path.with_suffix(".lrc")

    srt_text = srt_path.read_text(encoding="utf-8-sig")
    lrc_text = srt_to_lrc_text(srt_text)
    lrc_path.write_text(lrc_text, encoding="utf-8")
    return lrc_path

def get_output_lrc_path(srt_path: Path, output_dir: Path) -> Path:
    """
    根据 srt 文件名生成对应的 lrc 输出路径。
    """
    return output_dir / f"{srt_path.stem}.lrc"

def collect_srt_files(input_dir: Path) -> list[Path]:
    """
    收集 input 目录下所有 docx 文件。
    """
    return list(input_dir.glob("*.srt"))

def convert_all_srt_to_lrc(input_dir: Path, output_dir: Path) -> None:
    """
    批量将 input 目录下的 docx 转为 lrc。
    """
    if not os.path.exists(output_dir):
        output_dir.mkdir(parents=True, exist_ok=True)

    srt_files = collect_srt_files(input_dir)
    if not srt_files:
        # print("input 目录没有找到 srt 文件")
        core_utils.Logs.info("input 目录没有找到 srt 文件")
        return

    for srt_path in srt_files:
        output_path = get_output_lrc_path(srt_path, output_dir)
        convert_srt_file_to_lrc(srt_path, output_path)