# Manosaba Character Composer

本项目用于从 Manosaba 游戏资源中提取角色资源并通过一个简单的 Web UI 浏览。

下面文档覆盖三个主要脚本：`assetbundle_extractor.py`、`voice_extractor.py`、`webui.py`。

## 先决条件

- Python 3.8+
- 安装依赖（项目根目录下已有 `requirements.txt`）：

```powershell
python -m pip install -r requirements.txt
```

如果没有全局 Python，可使用 venv：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## 文件概览

- `assetbundle_extractor.py`
  - 目的：从 Unity AssetBundle、.assets 等文件中提取 Texture（保存为 .webp）、AudioClip（.wav 或文件夹）和 TextAsset，并将 GameObject 的 Transform / SpriteRenderer 信息汇总到 `GameObject.json`。
  - 主要类/函数：`AssetBundleExtractor`（可并发处理、按输入目录生成结构化输出目录）。
  - 备注：依赖 `UnityPy`、`tqdm`、`soundfile`（requirements.txt 中列出）。

- `voice_extractor.py`
  - 目的：解析 Naninovel 风格的脚本（以 `#id` 开始、以 `;` 注释标注语音信息），从剧本文件中抽取语音 id、角色、原文与翻译，生成可导出的 JSON 或角色对应的 `.list` 文件以供后续处理。
  - 主要类/函数：`NaninovelScript`、`NaninovelEntry`（用于解析、清理文本并导出 JSON）。
  - 备注：无需第三方包（dataclasses、json、glob 等为标准库），脚本包含示例如何把解析结果写入 `.list` 文件。

- `webui.py`
  - 目的：使用 Flask 提供一个简易 Web UI，列出角色并浏览 `GameObject.json`、图片等资源。
  - 主要路由：
    - `/`：主页，列出可用角色和头像（头像目录由 `config.settings.PROFILE_DIR` 指定）
    - `/character/<character>`：展示指定角色的 `GameObject.json` 根节点（使用 `templates/character.html`）
    - `/api/profile/<character>`：返回 Profile 图像
    - `/images/character/<character>/<path:path>`：按需返回角色图片
  - 备注：依赖 `Flask`，配置从 `config/settings.py` 读取（`BASE_DIR`、`PROFILE_DIR`、`HOST`、`PORT`）。

## 使用说明（示例）

1) 从 AssetBundle 提取资源

```powershell
# 运行脚本（脚本文件中 __main__ 已有默认路径示例）
python assetbundle_extractor.py

# 或在代码中使用类：
python - <<'PY'
from assetbundle_extractor import AssetBundleExtractor
extractor = AssetBundleExtractor(r'D:\path\to\StreamingAssets', r'D:\output', use_logger=True, max_workers=8)
print(extractor.extract_all())
PY
```

常用参数：
- `max_workers`：并发线程数（文件/对象处理线程池）
- `skip_exists_dir`：如果输出目录已存在且非空则跳过
- `skip_AssetBundle`：如果为 True 则跳过 AssetBundle 类型对象

处理结果：每个输入文件会在输出目录下创建一个以输入文件名为目录名的文件夹，提取出的图片（.webp）、音频（.wav 或子目录）、文本（.txt）以及 `GameObject.json`。

2) 解析剧本并生成语音列表

```powershell
python voice_extractor.py
```

脚本会扫描指定目录下的本地化脚本（示例代码查找 `general-localization-*` 目录），解析以 `;` 注释开头的语音标记并生成每个角色的 `.list` 文件。你也可以在 Python 中直接使用 `NaninovelScript`：

```python
from voice_extractor import NaninovelScript
s = NaninovelScript('path/to/script.txt')
s.save_as_json('out.json')
```

3) 启动 Web 界面

确保 `config/settings.py` 中的 `BASE_DIR` 指向包含角色资源（每个角色一个子目录，目录内有 `GameObject.json` 和图片）的根目录。`PROFILE_DIR` 指向头像文件夹。

```powershell
python webui.py
# 然后在浏览器打开: http://<HOST>:<PORT>/ （HOST/PORT 来自 config/settings.py）
```

## 开发者说明与注意事项

- `assetbundle_extractor.py` 会将 GameObject 结构汇总到 `GameObject.json`，该文件被 `webui.py` 用来生成角色树状展示。
- 提取图片使用 WEBP 格式，确保你的环境支持 `Pillow` 的 webp 保存功能。
- 音频提取对多音轨或字典形式的 AudioClip 做了兼容处理，会把多个样本写入子目录。
- `voice_extractor.py` 的语音匹配依赖内置正则（见 `VOICE_PATTERNS`），如果游戏脚本格式不同可能需要微调。