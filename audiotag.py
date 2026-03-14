from mutagen.mp3 import MP3
from mutagen.id3 import ID3, APIC, error

def replace_mp3_cover(mp3_path, image_path):
    try:
        # 1. 加载 MP3 文件的 ID3 标签
        try:
            audio = MP3(mp3_path, ID3=ID3)
        except error:
            # 如果文件没有 ID3 标签，则添加一个
            audio = MP3(mp3_path)
            audio.add_tags()

        # 2. 删除所有现有的封面 (APIC 帧)
        audio.tags.delall("APIC")

        # 3. 读取新的图片文件
        with open(image_path, 'rb') as img:
            img_data = img.read()

        # 4. 创建新的 APIC 帧（封面）
        # type=3 表示这是正封面 (Front Cover)
        # mime='image/jpeg' 根据你的图片格式调整 (png 则为 image/png)
        audio.tags.add(
            APIC(
                encoding=3,          # UTF-8
                mime='image/jpeg',   # 图片类型
                type=3,              # 封面类型
                desc=u'Cover',       # 描述
                data=img_data        # 图片的二进制数据
            )
        )

        # 5. 保存修改
        audio.save()
        print(f"成功！已为作品 {mp3_path} 替换了新的主题封面。")

    except Exception as e:
        print(f"处理失败，原因：{e}")

# 使用示例
# replace_mp3_cover("你的作品.mp3", "你的封面.jpg")
import os

input_dir = "input"
img_type = ['.png','.jpg']

for filename in os.listdir(input_dir):
    if filename.lower().endswith(".mp3"):
        mp3_path = os.path.join(input_dir, filename)
        for t in img_type:
            img_name = os.path.splitext(filename)[0] + t
            img_path = os.path.join(input_dir, img_name)
            if os.path.exists(img_path):
                print("-------------From------------")
                print(f"{mp3_path}")
                print("-------------To------------")
                print(f"{img_path}")
                replace_mp3_cover(mp3_path, img_path)