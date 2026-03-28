# from pathlib import Path
import os

class Logs:
    # 颜色代码定义（内部使用）
    _RED = '\033[91m'
    _YELLOW = '\033[93m'
    _GREEN = '\033[92m'
    _RESET = '\033[0m'

    @staticmethod
    def warning(msg, status = "Warning"):
        print(f"{Logs._YELLOW}[{status}] {msg}{Logs._RESET}")

    @staticmethod
    def error(msg, status = "Error"):
        print(f"{Logs._RED}[{status}] {msg}{Logs._RESET}")

    def info(msg, status = "Info"):
        print(f"{Logs._RESET}[{status}] {msg}")

    @staticmethod
    def done(msg, status = "Pass"):
        print(f"{Logs._GREEN}[{status}] {msg}{Logs._RESET}")

class FileSize:
    # 定义单位常量，避免计算错误
    KB = 1024
    MB = 1024 * 1024
    Rules = {
        ".txt":  (1 * MB,  2 * MB),
        ".lrc":  (1 * MB,  2 * MB),
        ".png":  (300 * KB,  0.5 * MB),
        ".jpg":  (300 * KB,  0.5 * MB),
        ".jpeg":  (300 * KB,  0.5 * MB),
        ".json": (1 * MB,  5 * MB),
        ".mp3": (12 * MB, 15 * MB),
        ".wav": (12 * MB, 15 * MB),
        "default": (12 * MB, 20 * MB)
    }

    @staticmethod
    def validate(file_path):
        file_name = os.path.basename(file_path)
        """
        根据文件路径自动判定大小是否合规
        """
        if not os.path.exists(file_path):
            return False,'文件体积检查失败，文件不存在'
        ext = os.path.splitext(file_path)[1].lower()
        size = os.path.getsize(file_path)

        # 获取标准，匹配不到则使用 default
        warn_limit, err_limit = FileSize.Rules.get(ext, FileSize.Rules["default"])
        log = ''
        if size >= err_limit:
            log = f"检查到资源超出限制: {file_name} {size/FileSize.MB:.2f}MB"
            return False,log
        elif size >= warn_limit:
            log = f"检查到资源偏大: {file_name} {size/FileSize.MB:.2f}MB"
            return True,log
        return True,log
