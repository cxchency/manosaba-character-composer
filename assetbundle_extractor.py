from pathlib import Path
import re
import io
import soundfile as sf
from collections import Counter
import logging
import os
import sys
from typing import Literal, Optional, Dict, Any, Tuple
import time
from concurrent.futures import ThreadPoolExecutor, wait
import json
import threading

from tqdm import tqdm

import UnityPy
from UnityPy.files import ObjectReader
from UnityPy.classes import TextAsset, Texture2D, AudioClip, AssetBundle, Sprite, GameObject, Transform, SpriteRenderer, Shader, EditorExtension
from PyCriCodecsEx.acb import ACB
from PyCriCodecsEx.hca import HCACodec

ILLEGAL_CHARS_RE = re.compile(r'[<>:"/\\|?*#]')

def _sanitize_name(name: str) -> str:
        """替换文件名/路径中不合法的字符为下划线"""
        return ILLEGAL_CHARS_RE.sub('_', name)

# 辅助函数：在树中查找节点
def _find_node(container: Dict[str, Any], target_id: str) -> Optional[Dict[str, Any]]:
    if target_id in container:
        return container[target_id]
    for v in container.values():
        children = v.get("Children")
        if isinstance(children, dict):
            found = _find_node(children, target_id)
            if found:
                return found
    return None

# 辅助函数：收集所有 ParentId == target_id 的节点
def _collect_children(container: Dict[str, Any], target_parent_id: str, acc: list):
    for k, v in list(container.items()):
        if v.get("ParentId") == target_parent_id:
            acc.append((container, k, v))
        else:
            ch = v.get("Children")
            if isinstance(ch, dict):
                _collect_children(ch, target_parent_id, acc)


class AssetBundleExtractor:
    def __init__(self, input_dir, output_dir, use_logger=False, max_workers=8, logger=None, is_debug=False, skip_exists_dir=False, skip_AssetBundle=False):
        self.input_dir = Path(input_dir)
        self.output_dir = Path(output_dir)
        self.use_logger = use_logger
        self.is_debug = is_debug
        self.skip_exists_dir = skip_exists_dir
        self.skip_AssetBundle = skip_AssetBundle
        self.handlers = {
            "TextAsset": self._handle_text_asset,
            "Texture2D": self._handle_texture,
            "AudioClip": self._handle_audioclip,
            "AssetBundle": self._handle_assetbundle,
            "Sprite": self._handle_texture,
            "GameObject": self._handle_gameobject,  # 替换为处理GameObject
            # "SpriteRenderer": self._handle_sprite_renderer,  # 移除
            # "Transform": self._handle_transform,  # 移除
        }
        self.processed_objects = set()
        self.file_executor = ThreadPoolExecutor(max_workers=max_workers)
        self.obj_executor = ThreadPoolExecutor(max_workers=max_workers)
        self.futures = []
        self.type_counter = Counter()
        if logger:
            self.logger = logger
        else:
            logging.basicConfig(level=logging.INFO)
            self.logger = logging.getLogger(__name__)
        self.pbar = None
        self._json_locks = {}  # 路径: threading.Lock
        self._json_locks_lock = threading.Lock()  # 保护 _json_locks 字典
        self._json_cache = {}  # 新增：json缓存，key为json文件绝对路径

    def _log(self, level: Literal["debug", "info", "warning", "error"], msg: str):
        """日志"""
        if level == "debug" and not self.is_debug:
            return
        if self.use_logger or level in ["warning", "error"]:
            exc_type, exc_value, exc_tb = sys.exc_info()
            if exc_type is not None:
                getattr(self.logger, level)(f"{msg}", exc_info=True)
            else:
                getattr(self.logger, level)(f"{msg}")

    def _prepare_output_dir(self, file_path: str) -> Path:
        file_path: Path = Path(file_path)
        relative_path = file_path.relative_to(self.input_dir)
        
        sanitized_parts = [_sanitize_name(part) for part in relative_path.parent.parts]
        sanitized_stem = _sanitize_name(file_path.stem)
        
        out_dir = self.output_dir.joinpath(*sanitized_parts, sanitized_stem)
        
        if self.skip_exists_dir and out_dir.exists() and any(out_dir.iterdir()):
            return None
        
        out_dir.mkdir(parents=True, exist_ok=True)
        return out_dir
    
    def _skip_if_exists(self, path: Path) -> bool:
        """检查文件是否存在且大小一致，存在则跳过"""
        if path.exists():
            self._log("debug", f"跳过已存在: {path}")
            self.type_counter["skipped"] += 1
            return True
        return False
    
    def _get_json_lock(self, json_path: Path):
        """获取指定json文件的锁（如无则创建）"""
        key = str(json_path.resolve())
        with self._json_locks_lock:
            if key not in self._json_locks:
                self._json_locks[key] = threading.Lock()
            return self._json_locks[key]

    def _handle_text_asset(self, obj: ObjectReader, out_dir: Path):
        """处理 TextAsset 资源"""
        data: TextAsset = obj.read()
        res_name = getattr(data, "m_Name", None) or f"unnamed_{obj.path_id}"
        sanitized_res_name = _sanitize_name(res_name)
        out_base_path = out_dir / sanitized_res_name
        if out_base_path.name.endswith(".acb"):
            # 处理 .acb 格式的音频
            try:
                byte_content = data.m_Script.encode("utf-8", "surrogateescape")
                output_flac_path = out_base_path.with_suffix(".flac")
                if self._skip_if_exists(output_flac_path): return
                acb_obj = ACB(byte_content)
                waveforms = acb_obj.get_waveforms()
                if waveforms and isinstance(waveforms[0], HCACodec):
                    wf = waveforms[0]
                    with io.BytesIO(wf.decode()) as bio:
                        audio, samplerate = sf.read(bio)
                        sf.write(output_flac_path, audio, samplerate, format="FLAC", compression_level=1)
                    self._log("debug", f"导出音频: {output_flac_path}")
                    self.type_counter["audio"] += 1
            except Exception as e:
                self._log("error", f"处理 ACB 音频失败: {out_base_path.name} | {e}")
                self.type_counter["error"] += 1
        else:
            out_base_path = out_base_path.with_suffix(".txt")
            if self._skip_if_exists(out_base_path): return
            # 处理普通文本
            text_bytes = data.m_Script.encode("utf-8", "replace")
            out_base_path.write_bytes(text_bytes)
            self.type_counter["text"] += 1
            return

    def _handle_texture(self, obj: ObjectReader, out_dir: Path):
        """处理 Texture2D 资源"""
        data: Texture2D | Sprite = obj.read()
        res_name = getattr(data, "m_Name", None) or f"unnamed_{obj.path_id}"
        sanitized_res_name = _sanitize_name(res_name)
        out_base_path = out_dir / sanitized_res_name
        out_path = out_base_path.with_suffix(".webp")
        if not self._skip_if_exists(out_path):
            try:
                data.image.save(out_path, format="WEBP", lossless=True)
                self.type_counter["image"] += 1
            except Exception as e:
                self._log("error", f"图片保存失败: {out_path} | {e}")
                self.type_counter["error"] += 1

    def _handle_audioclip(self, obj: ObjectReader, out_dir: Path):
        """处理 AudioClip 资源"""
        data: AudioClip = obj.read()
        res_name = getattr(data, "m_Name", None) or f"unnamed_{obj.path_id}"
        sanitized_res_name = _sanitize_name(res_name)
        out_base_path = out_dir / sanitized_res_name
        if self._skip_if_exists(out_base_path): return
        if not hasattr(data, "samples") or data.samples is None:
            self._log("warning", f"AudioClip 无音频数据: {out_base_path.name}")
            return
        # 处理多音频文件字典
        if isinstance(data.samples, dict):
            out_base_path.mkdir(exist_ok=True)
            sample_items = data.samples.items()
            for filename, audio_bytes in sample_items:
                temp_path = (out_base_path / filename).with_suffix(".wav")
                temp_path.write_bytes(audio_bytes)
        # 处理单个音频文件
        else:
            output_wav_path = out_base_path.with_suffix(".wav")
            output_wav_path.write_bytes(data.samples)
        self.type_counter["audio"] += 1
    
    def _get_transform_info(self, transform: Transform):
        """提取 Transform 信息"""
        return {
            "Position": {
                "x": transform.m_LocalPosition.x,
                "y": transform.m_LocalPosition.y,
                "z": transform.m_LocalPosition.z,
            } if getattr(transform, "m_LocalPosition", None) else None,
            "Rotation": {
                "x": transform.m_LocalRotation.x,
                "y": transform.m_LocalRotation.y,
                "z": transform.m_LocalRotation.z,
                "w": transform.m_LocalRotation.w,
            } if getattr(transform, "m_LocalRotation", None) else None,
            "Scale": {
                "x": transform.m_LocalScale.x,
                "y": transform.m_LocalScale.y,
                "z": transform.m_LocalScale.z,
            } if getattr(transform, "m_LocalScale", None) else None,
        }
        
    def _get_sprite_renderer_info(self, sprite_renderer: SpriteRenderer):
        """提取 SpriteRenderer 关键信息（仅保留渲染和 Mask 相关字段）"""
        sprite = sprite_renderer.m_Sprite.read() if getattr(sprite_renderer, "m_Sprite", None) else None
        # 修正：只处理 m_PathID != 0 的材料
        materials = [mat.read() for mat in getattr(sprite_renderer, "m_Materials", []) if hasattr(mat, "read") and getattr(mat, "m_PathID", 0) != 0]
        sprite_info = None
        if sprite:
            sprite_info = {
                "Name": getattr(sprite, "m_Name", None),
                "PixelsToUnits": getattr(sprite, "m_PixelsToUnits", None),
                "Pivot": {
                    "x": sprite.m_Pivot.x,
                    "y": sprite.m_Pivot.y,
                } if getattr(sprite, "m_Pivot", None) else None,
            }

        material_infos = []
        for mat in materials:
            if not mat:
                continue
            props = getattr(mat, "m_SavedProperties", None)
            if not props:
                continue
            mat_info = {"Name": getattr(mat, "m_Name", None)}
            # 关键浮点数
            floats = {}
            for fname in ["_StencilRef", "_StencilComp"]:
                val = dict(props.m_Floats).get(fname)
                if val is not None:
                    floats[fname] = val
            if floats:
                mat_info["Floats"] = floats

            material_infos.append(mat_info)

        return {
            "Sprite": sprite_info,
            "Enabled": getattr(sprite_renderer, "m_Enabled", None),
            "SortingOrder": getattr(sprite_renderer, "m_SortingOrder", None),
            "Color": {
                "r": sprite_renderer.m_Color.r,
                "g": sprite_renderer.m_Color.g,
                "b": sprite_renderer.m_Color.b,
                "a": sprite_renderer.m_Color.a
            } if getattr(sprite_renderer, "m_Color", None) else None,
            "Materials": material_infos
        }
        
        
    def _get_sub_components(self, data: GameObject, comp_type_names: list[str]) -> dict[str, EditorExtension]:
        """获取 GameObject 的子组件，返回类型名到组件对象的映射"""
        components: dict[str, EditorExtension] = {}
        for comp in getattr(data, "m_Component", []):
            pptr = getattr(comp, "component", None)
            if pptr is not None and hasattr(pptr, "read"):
                try:
                    comp_obj = pptr.read()
                    comp_type = getattr(pptr, "type", None)
                    comp_type_name = getattr(comp_type, "name", None) if comp_type is not None else None
                    if comp_type_name in comp_type_names:
                        components[comp_type_name] = comp_obj
                except Exception:
                    continue
        return components
    
    
    def _handle_gameobject(self, obj: ObjectReader, out_dir: Path):
        """
        导出 GameObject 的 Transform 和 SpriteRenderer 信息到 GameObject.json
        （支持嵌套层级，自动修复孤立子节点，不重复更新已存在的节点）
        """
        data: GameObject = obj.read()
        res_name = getattr(data, "m_Name", None) or f"unnamed_{obj.path_id}"
        sanitized_res_name = _sanitize_name(res_name)
        out_base_path = out_dir / sanitized_res_name
        folder_json_path = out_base_path.parent / "GameObject.json"
        lock = self._get_json_lock(folder_json_path)
        json_key = str(folder_json_path.resolve())

        with lock:
            # 优先从缓存读取
            if json_key in self._json_cache:
                tree: Dict[str, Any] = self._json_cache[json_key]
            else:
                if folder_json_path.exists():
                    with open(folder_json_path, "r", encoding="utf-8") as f:
                        tree: Dict[str, Any] = json.load(f)
                else:
                    tree = {}
                self._json_cache[json_key] = tree

            key = str(obj.path_id)
            # 判断是否已有该节点
            existing_node = _find_node(tree, key)
            if existing_node is None:
                # 获取子组件
                components = self._get_sub_components(data, ["Transform", "SpriteRenderer"])
                transform: Transform = components.get("Transform")
                sprite_renderer: SpriteRenderer = components.get("SpriteRenderer")

                transform_info = self._get_transform_info(transform) if transform else None
                sprite_renderer_info = self._get_sprite_renderer_info(sprite_renderer) if sprite_renderer else None

                parent_id = None
                if transform:
                    father_ptr = getattr(transform, "m_Father", None)
                    if father_ptr and hasattr(father_ptr, "read"):
                        try:
                            father_transform = father_ptr.read()
                            father_gameobject = getattr(father_transform, "m_GameObject", None)
                            if father_gameobject:
                                parent_id = str(father_gameobject.path_id)
                        except Exception:
                            pass

                # 新建节点
                current_node = {
                    "Name": getattr(data, "m_Name", f"unnamed_{key}"),
                    "Id": key,
                    "ParentId": parent_id,
                    "Transform": transform_info,
                    "SpriteRenderer": sprite_renderer_info,
                    "IsActive": getattr(data, "m_IsActive", None),
                    "Children": {}
                }

                # 放置到父节点或顶层
                if parent_id:
                    parent_node = _find_node(tree, parent_id)
                    if parent_node:
                        parent_node.setdefault("Children", {})[key] = current_node
                    else:
                        tree[key] = current_node
                else:
                    tree[key] = current_node
            else:
                self.type_counter["skipped"] += 1
                return

            # 修复孤立子节点
            to_move = []
            _collect_children(tree, key, to_move)
            if to_move:
                current_node.setdefault("Children", {})
                for src_container, src_key, src_node in to_move:
                    if src_key in src_container:
                        del src_container[src_key]
                    current_node["Children"][src_key] = src_node

            # 排序
            def sort_dict(d: Dict[str, Any]) -> Dict[str, Any]:
                return dict(sorted(d.items(), key=lambda x: x[1].get("Name", "")))

            def recursive_sort(node: Dict[str, Any]):
                if "Children" in node and isinstance(node["Children"], dict):
                    node["Children"] = sort_dict(node["Children"])
                    for child in node["Children"].values():
                        recursive_sort(child)

            tree = sort_dict(tree)
            for node in tree.values():
                recursive_sort(node)

            # 不再立即写回文件，缓存到 _json_cache
            self._json_cache[json_key] = tree

        self.type_counter["gameobject"] += 1
        self._log("debug", f"导出 GameObject: {key} 并合并到 {folder_json_path}")


    def _handle_assetbundle(self, obj: ObjectReader, out_dir: Path, file_path: str):
        """递归处理 AssetBundle 资源"""
        data: AssetBundle = obj.read()
        self._log("debug", f"递归处理 AssetBundle: {getattr(data, 'm_Name', 'unknown')}")
        container = getattr(data, "m_Container", {})
        entries = container.items() if isinstance(container, dict) else container
        
        for entry in entries:
            try:
                name, pptr = entry
                if not (hasattr(pptr, "asset") and pptr.asset):
                    self._log("warning", f"子对象不支持 read: {type(pptr)} | {name}")
                    continue
                self.process_object(pptr.asset, out_dir, file_path)

            except Exception as e:
                self._log("error", f"AssetBundle 子对象处理失败: {entry} | {e}")
        
        return "assetbundle"

    def extract_all(self):
        """提取目录下所有 Unity 文件"""
        file_list = []
        for root, dirs, files in os.walk(self.input_dir):
            for file in files:
                file_path = os.path.join(root, file)
                file_list.append(file_path)

        self.pbar = tqdm(total=len(file_list), desc="处理对象", unit="个")

        file_futures = [self.file_executor.submit(self.process_file, fp) for fp in file_list]
        wait(file_futures)
        self.file_executor.shutdown()
        while True:
            if all(f.done() for f in self.futures):
                break
            time.sleep(0.1)
        self.obj_executor.shutdown(wait=True)

        self.pbar.close()

        # 新增：统一写回所有缓存的json
        for json_key, tree in self._json_cache.items():
            try:
                with open(json_key, "w", encoding="utf-8") as f:
                    json.dump(tree, f, ensure_ascii=False, indent=2)
            except Exception as e:
                self._log("error", f"写入 GameObject.json 失败: {json_key} | {e}")

        return self.type_counter

    def process_file(self, file_path: str):
        """处理单个 Unity 文件"""
        try:
            out_dir = self._prepare_output_dir(file_path)
            if out_dir is None:
                self._log("info", f"跳过已存在目录: {file_path}")
                self.type_counter["skipped"] += 1
                self._update_pbar(1)
                return
            env = UnityPy.load(str(file_path))
        except Exception as e:
            self._log("error", f"无法加载文件: {file_path}, {e}")
            self._update_pbar(1)
            return
        self._update_pbar_total(-1)
        for obj in env.objects:
            if self.skip_AssetBundle and obj.type.name == "AssetBundle":
                continue
            self.process_object(obj, out_dir, file_path)
        
        self._log("debug", f"完成文件: {file_path}")

    def _handler_update_pbar(self, handler, *args, **kwargs):
        """处理资源并更新进度条"""
        try:
            handler(*args, **kwargs)
        except Exception as e:
            self._log("error", f"处理资源失败: {e}")
        self._update_pbar(1)
        
    def _update_pbar_total(self, increment=1):
        if self.pbar:
            self.pbar.total += increment
            self.pbar.refresh()
            
    def _update_pbar(self, n=1):
        if self.pbar:
            self.pbar.update(n)

    def process_object(self, obj: ObjectReader, out_dir: Path, file_path: str):
        """处理单个 Unity 对象"""
        try:
            key = (file_path, obj.path_id)  # 唯一标识
            if key in self.processed_objects:
                self._log("debug", f"跳过已处理对象: {key}")
                return
            self.processed_objects.add(key)
            handler = self.handlers.get(obj.type.name)
            if handler:
                self._update_pbar_total()

                if obj.type.name == "AssetBundle":
                    future = self.obj_executor.submit(self._handler_update_pbar, handler, obj, out_dir, file_path)
                else:
                    future = self.obj_executor.submit(self._handler_update_pbar, handler, obj, out_dir)
                self.futures.append(future)
            else:
                # self._update_pbar(1)
                self.type_counter[obj.type.name] += 1
                # self._log("debug", f"跳过资源类型: {obj.type.name} | {file_path}")
        
        except Exception as e:
            self._update_pbar(1)
            self._log("error", f"资源处理失败: {file_path} | {obj.path_id} | {e}")
            
if __name__ == "__main__":
    input_dir = r"D:\Steam\steamapps\common\manosaba_game\manosaba_Data\StreamingAssets\aa\StandaloneWindows64"
    output_dir = r"D:\manosaba"
    print(AssetBundleExtractor(input_dir, output_dir, use_logger=True, max_workers=8).extract_all())