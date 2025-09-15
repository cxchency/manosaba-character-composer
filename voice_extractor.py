from dataclasses import dataclass, asdict
from typing import List, Optional
import re
import json
import os
import glob
from collections import defaultdict

@dataclass
class NaninovelEntry:
    id: str
    source: str                # 合并的多行原文
    translation: str           # 合并的多行翻译
    source_plain: str          # 清除格式后的原文
    translation_plain: str     # 清除格式后的翻译
    voice_id: Optional[str] = None
    character: Optional[str] = None

    @staticmethod
    def clean_text(text: str) -> str:
        """去除 HTML 标签及多余空格"""
        # 去掉 <br> 等 HTML 标签
        text = re.sub(r"<.*?>", "", text)
        # 去掉全角空格和多余空行
        text = re.sub(r"\s+", "", text)
        return text.strip()

@dataclass
class ScriptMetadata:
    id: str
    file_path: str
    file_dir: str
    header: Optional[str] = None


class NaninovelScript:
    # 所有支持的语音匹配正则及对应处理函数
    VOICE_PATTERNS = [
        # 新格式: ; > @printDebate ... |#voice_id|
        (re.compile(r"> *@printDebate.*\|#([A-Za-z0-9_]+)\|"), lambda m: (None, m.group(1))),
        # 旧格式: ; > Miria: |#voice_id|
        (re.compile(r"> *(\w+): *\|#([A-Za-z0-9_]+)\|"), lambda m: (m.group(1), m.group(2))),
    ]

    @staticmethod
    def extract_character_from_voice_id(voice_id: str) -> Optional[str]:
        # 从 voice_id 中自动识别角色名（如 0206Trial09_Yuki003 -> Yuki）
        match = re.search(r'_(\w+?)(\d+)?$', voice_id)
        if match:
            return match.group(1)
        return None

    def __init__(self, file_path: str):
        self.file_path = file_path
        file_dir = os.path.dirname(file_path)
        self.id = os.path.splitext(os.path.basename(file_path))[0]
        self.metadata = ScriptMetadata(file_path=self.file_path, id=self.id, file_dir=file_dir)
        self.entries: List[NaninovelEntry] = []
        self.other_remarks: List[str] = []  # 储存所有 ; > 开头的内容
        self._parse()

    def _parse(self):
        current_entry_id = None
        source_lines = []
        translation_lines = []
        character = None
        voice_id = None
        first_line = True
        reading_translation = False

        with open(self.file_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.rstrip()
                if not line:
                    continue

                if first_line and line.startswith(";"):
                    self.metadata.header = line[1:].strip()
                    first_line = False
                    continue
                first_line = False

                if line.startswith("#"):
                    if current_entry_id is not None:
                        source_text = "\n".join(source_lines)
                        translation_text = "\n".join(translation_lines)
                        self.entries.append(NaninovelEntry(
                            id=current_entry_id,
                            source=source_text,
                            translation=translation_text,
                            source_plain=NaninovelEntry.clean_text(source_text),
                            translation_plain=NaninovelEntry.clean_text(translation_text),
                            voice_id=voice_id,
                            character=character,
                        ))
                    # 初始化新条目
                    current_entry_id = line[1:].strip()
                    source_lines = []
                    translation_lines = []
                    character = None
                    voice_id = None
                    reading_translation = False

                elif line.startswith(";"):
                    content = line[1:].strip()
                    matched = False
                    for pattern, handler in self.VOICE_PATTERNS:
                        match = pattern.match(content)
                        if match:
                            char, vid = handler(match)
                            voice_id = vid
                            # 如果正则没有直接给出角色名，则尝试自动识别
                            character = char if char else self.extract_character_from_voice_id(voice_id)
                            matched = True
                            break
                    if matched:
                        continue  # 语音信息行不计入其它备注
                    # 只保存未被上述匹配的 ; > 行
                    if content.startswith(">"):
                        self.other_remarks.append(content)
                        continue
                    # 其他以 ; 开头的行根据当前翻译状态加入源文本或译文
                    if not reading_translation:
                        source_lines.append(content)
                    else:
                        translation_lines.append(content)
                else:
                    reading_translation = True
                    translation_lines.append(line)

            # 保存最后一个条目
            if current_entry_id is not None:
                source_text = "\n".join(source_lines)
                translation_text = "\n".join(translation_lines)
                self.entries.append(NaninovelEntry(
                    id=current_entry_id,
                    source=source_text,
                    translation=translation_text,
                    source_plain=NaninovelEntry.clean_text(source_text),
                    translation_plain=NaninovelEntry.clean_text(translation_text),
                    voice_id=voice_id,
                    character=character,
                ))

    def save_as_json(self, output_path: str):
        """使用 asdict 简化 JSON 导出"""
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump({
                "metadata": asdict(self.metadata),
                "entries": [asdict(e) for e in self.entries]
            }, f, ensure_ascii=False, indent=2)

# 使用示例
if __name__ == "__main__":
    input_dir = r"D:\manosaba"
    output_dir = r"D:\manosaba_voice_lists"
    os.makedirs(output_dir, exist_ok=True)
    character_map = defaultdict(list)
    files = glob.glob(os.path.join(input_dir, "general-localization-*-scripts-*", "*.txt"))
    for file in files:
        print(f"Processing file: {file}")
        script = NaninovelScript(file)
        # 输出所有 ; > 开头的内容
        if script.other_remarks:
            print(f"> lines in {file}:")
            for remark in script.other_remarks:
                print(remark)
        dir_name = script.metadata.file_dir.split('-')[-1]
        if dir_name == "common_assets_all":
            voice_dir = os.path.join(input_dir, f"general-voice-{script.id.lower()}_assets_all")
        else:
            voice_dir = os.path.join(input_dir, f"general-voice-{dir_name}")
        for entry in script.entries:
            if entry.character and entry.voice_id:
                voice_path = os.path.join(voice_dir, entry.voice_id, f"{entry.voice_id}.wav")
                if os.path.exists(voice_path):
                    character_map[entry.character].append(f"{voice_path}|slicer_opt|JP|{entry.source_plain}")
                
    for character, voices in character_map.items():
        with open(os.path.join(output_dir, f"{character}.list"), "w", encoding="utf-8") as f:
            for voice in voices:
                f.write(voice + "\n")