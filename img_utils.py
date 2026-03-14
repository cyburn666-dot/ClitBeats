from pathlib import Path
from PIL import Image


def compress_image(image_path: Path, max_size: int = 512) -> None:
    """
    将单张图片压缩到 max_size * max_size 以内，不放大小图，直接覆盖原文件。
    """
    try:
        with Image.open(image_path) as img:
            original_size = img.size
            ext = image_path.suffix.lower()

            need_process = False

            # EXIF方向检查
            orientation = None
            try:
                exif = img.getexif()
                orientation = exif.get(274)
                if orientation in (3, 6, 8):
                    need_process = True
            except Exception:
                pass

            # 尺寸检查
            if img.width > max_size or img.height > max_size:
                need_process = True

            # JPG模式检查
            if ext in [".jpg", ".jpeg"] and img.mode not in ("RGB",):
                need_process = True

            if not need_process:
                print(f"[跳过合格图片] {image_path.name}: {img.size}")
            else:
                # 处理EXIF方向
                if orientation == 3:
                    img = img.rotate(180, expand=True)
                elif orientation == 6:
                    img = img.rotate(270, expand=True)
                elif orientation == 8:
                    img = img.rotate(90, expand=True)

                # 按比例缩小
                img.thumbnail((max_size, max_size))

                if ext in [".jpg", ".jpeg"]:
                    if img.mode in ("RGBA", "LA", "P"):
                        img = img.convert("RGB")
                    img.save(image_path, format="JPEG", quality=90, optimize=True)

                elif ext == ".png":
                    img.save(image_path, format="PNG", optimize=True)

                else:
                    raise ValueError(f"不支持的图片格式: {image_path}")

                print(f"[图片处理] {image_path.name}: {original_size} -> {img.size}")

    except Exception as e:
        print(f"[图片处理失败] {image_path.name}: {e}")


def preprocess_all_images(input_dir: Path, max_size: int = 512) -> None:
    """
    处理目录下所有 jpg/jpeg/png 图片。
    """

    image_files = []
    for pattern in ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG"):
        image_files.extend(input_dir.glob(pattern))

    if not image_files:
        print("未找到需要处理的图片")
        return

    for image_path in image_files:
        compress_image(image_path, max_size=max_size)