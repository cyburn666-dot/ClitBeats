from pathlib import Path
from img_utils import preprocess_all_images
# from audio_tag_utils import replace_all_mp3_covers
from audio_tag_utils import strip_all_embedded_metadata
from docx_lrc_utils import convert_all_docx_to_lrc
from srt_utils import convert_all_srt_to_lrc

INPUT_DIR = Path("input")
OUTPUT_DIR = Path("output")
MAX_IMAGE_SIZE = 512
SUPPORTED_IMAGE_EXTS = [".jpg", ".jpeg", ".png"]
SUPPORTED_AUDIO_EXTS = [".mp3"]
SUPPORTED_DOCX_EXTS = [".docx"]

def main() -> None:
    # 1. 压缩图片资源
    preprocess_all_images(
        input_dir=INPUT_DIR,
        max_size=MAX_IMAGE_SIZE
    )

    # 2. 提取歌词 docx -> lrc
    convert_all_docx_to_lrc(
        input_dir=INPUT_DIR,
        output_dir=INPUT_DIR
    )

    convert_all_srt_to_lrc(
        input_dir=INPUT_DIR,
        output_dir=INPUT_DIR
    )

    # 3. 清理MP3 MetaData
    strip_all_embedded_metadata(input_dir=INPUT_DIR)

if __name__ == "__main__":
    main()

