import sys
DEBUGPY = None
if "debugpy" in sys.modules:
    import debugpy
    DEBUGPY = debugpy

HOST = "0.0.0.0"
PORT = 5005
BASE_DIR = r"characters"  # 角色数据目录
PROFILE_DIR = r"profiles"  # 头像目录