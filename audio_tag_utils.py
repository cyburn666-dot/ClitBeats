from pathlib import Path
from mutagen.id3 import ID3, APIC, error
from mutagen.id3 import ID3, ID3NoHeaderError
import core_utils


def get_mime_type(image_path: Path) -> str:
    ext = image_path.suffix.lower()

    if ext in [".jpg", ".jpeg"]:
        return "image/jpeg"
    if ext == ".png":
        return "image/png"

    raise ValueError(f"不支持的图片格式: {image_path}")


def find_cover(mp3_path: Path, supported_exts: list[str]) -> Path | None:
    """
    查找与 mp3 同名的封面图片。
    """
    for ext in supported_exts:
        candidate = mp3_path.with_suffix(ext)
        if candidate.exists():
            return candidate
    return None


def load_or_create_tags(mp3_path: Path) -> ID3:
    """
    读取 ID3 标签；如果没有则新建。
    """
    try:
        return ID3(mp3_path)
    except error:
        return ID3()


def read_binary_file(file_path: Path) -> bytes:
    with open(file_path, "rb") as f:
        return f.read()


def write_cover_to_tags(tags: ID3, cover_path: Path) -> None:
    """
    将图片写入 ID3 封面字段。
    """
    image_data = read_binary_file(cover_path)

    tags.delall("APIC")
    tags.add(
        APIC(
            encoding=3,
            mime=get_mime_type(cover_path),
            type=3,
            desc="Cover",
            data=image_data,
        )
    )


def replace_cover(mp3_path: Path, supported_exts: list[str]) -> None:
    """
    为单个 mp3 替换封面。
    """
    cover_path = find_cover(mp3_path, supported_exts)
    if not cover_path:
        # print(f"[跳过] 未找到同名图片: {mp3_path.name}")
        core_utils.Logs.done(f"未找到同名图片: {mp3_path.name}","跳过")
        return

    try:
        tags = load_or_create_tags(mp3_path)
        write_cover_to_tags(tags, cover_path)
        tags.save(mp3_path, v2_version=3)

        verify_tags = ID3(mp3_path)
        apic_list = verify_tags.getall("APIC")
        # print(f"[完成] {mp3_path.name} <- {cover_path.name}，封面数量: {len(apic_list)}")
        core_utils.Logs.warning(f"{mp3_path.name} <- {cover_path.name}，封面数量: {len(apic_list)}","完成")

    except Exception as e:
        # print(f"[失败] {mp3_path.name}: {e}")
        core_utils.Logs.error(f"{mp3_path.name}: {e}","失败")

def collect_mp3_files(input_dir: Path) -> list[Path]:
    return list(input_dir.glob("*.mp3"))


def replace_all_mp3_covers(input_dir: Path, supported_exts: list[str]) -> None:
    """
    处理目录下所有 mp3 的封面。
    """
    mp3_files = collect_mp3_files(input_dir)

    if not mp3_files:
        # print("input 目录没有找到 mp3 文件")
        core_utils.Logs.info(f"input 目录没有找到 mp3 文件")
        return

    for mp3_path in mp3_files:
        replace_cover(mp3_path, supported_exts)


def strip_embedded_cover(mp3_path: Path):
    """删除MP3内嵌封面(APIC)，若不存在则跳过"""

    try:
        tags = ID3(mp3_path)
    except ID3NoHeaderError:
        # print(f"[跳过] 无ID3标签: {mp3_path.name}")
        core_utils.Logs.done(f"无ID3标签: {mp3_path.name}","跳过")
        return False

    removed = False

    for key in list(tags.keys()):
        if key.startswith("APIC"):
            del tags[key]
            removed = True

    if not removed:
        # print(f"[跳过] 无内嵌封面: {mp3_path.name}")
        core_utils.Logs.done(f"无内嵌封面: {mp3_path.name}","跳过")
        return False

    # 只有真的修改了才保存
    tags.save(mp3_path)

    # print(f"[删除成功] 已删除MP3内嵌封面: {mp3_path.name}")
    core_utils.Logs.warning(f"已删除MP3内嵌封面: {mp3_path.name}","删除成功")
    return True

def strip_mp3_metadata(mp3_path: Path) -> bool:
    """删除 MP3 的全部 ID3 元数据；若本来就没有，则跳过"""

    try:
        tags = ID3(mp3_path)
    except ID3NoHeaderError:
        core_utils.Logs.done(f"无ID3标签: {mp3_path.name}","跳过")
        return False

    if len(tags.keys()) == 0:
        core_utils.Logs.done(f"空ID3标签: {mp3_path.name}","跳过")
        return False

    tags.delete(mp3_path)
    # print(f"[清理成功] 已删除全部MP3元数据: {mp3_path.name}")
    core_utils.Logs.warning(f"已删除全部MP3元数据: {mp3_path.name}","清理成功")
    return True



def strip_all_embedded_metadata(input_dir: Path):
    mp3_files = collect_mp3_files(input_dir)
    for mp3_path in mp3_files:
        #检查音频大小
        status, logs = core_utils.FileSize.validate(mp3_path)
        if logs != '':
            core_utils.Logs.warning(logs)
        strip_mp3_metadata(mp3_path)