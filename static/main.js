class TreeSelector {
	constructor(app) {
		this.app = app;
		this.treeCollapseState = this.loadCollapseCache();
		// Try desktop container first, fallback to drawer container (mobile), else create one
		this.controlsContentDiv = document.getElementById("controls-content") || document.getElementById('drawer-controls-content');
		if (!this.controlsContentDiv) {
			const controlsRoot = document.getElementById('controls');
			if (controlsRoot) {
				const div = document.createElement('div');
				div.id = 'controls-content';
				controlsRoot.insertBefore(div, controlsRoot.firstChild);
				this.controlsContentDiv = div;
			} else if (document.body) {
				const div = document.createElement('div');
				div.id = 'controls-content';
				document.body.appendChild(div);
				this.controlsContentDiv = div;
			}
		}
		this.__treeSelectorRendered = false;
	}


	getCollapseCacheKey() {
		return `tree_collapse_${this.app.currentCharacter}`;
	}
	saveCollapseCache() {
		try {
			localStorage.setItem(this.getCollapseCacheKey(), JSON.stringify(this.treeCollapseState));
		} catch (e) {}
	}
	loadCollapseCache() {
		let cache = localStorage.getItem(this.getCollapseCacheKey());
		if (!cache) return {};
		try { return JSON.parse(cache); } catch (e) { return {}; }
	}

	getSelectionCacheKey() {
		return `character_selection_${this.app.currentCharacter}`;
	}
	saveSelectionCache(rootNode) {
		function collect(node) {
			let result = {};
			if (node.Children) {
				for (let key in node.Children) result[key] = collect(node.Children[key]);
			}
			if (node.SpriteRenderer && node.SpriteRenderer.Sprite) result.__selected = !!node.__selected;
			return result;
		}
		try {
			localStorage.setItem(this.getSelectionCacheKey(), JSON.stringify(collect(rootNode)));
		} catch (e) {}
	}
	loadSelectionCache(rootNode) {
		let cache = localStorage.getItem(this.getSelectionCacheKey());
		if (!cache) return;
		try { cache = JSON.parse(cache); } catch (e) { return; }
		function restore(node, cacheObj) {
			if (!cacheObj) return;
			if (node.Children) {
				for (let key in node.Children) restore(node.Children[key], cacheObj[key]);
			}
			if (node.SpriteRenderer && node.SpriteRenderer.Sprite && typeof cacheObj.__selected !== "undefined") {
				node.__selected = !!cacheObj.__selected;
			}
		}
		restore(rootNode, cache);
	}
	clearSelectionCache() {
		localStorage.removeItem(this.getSelectionCacheKey());
	}

	// 判断节点或其子节点是否含有 SpriteRenderer.Sprite
	static hasLeafSprite(node) {
		if (node.SpriteRenderer && node.SpriteRenderer.Sprite) return true;
		if (node.Children) {
			for (let key in node.Children) {
				if (TreeSelector.hasLeafSprite(node.Children[key])) return true;
			}
		}
		return false;
	}

	// 新增：返回按 Name 排序的子节点键数组（避免重复排序逻辑）
	static sortedChildKeys(children) {
		if (!children) return [];
		return Object.keys(children).sort((a, b) => {
			const nameA = (children[a] && children[a].Name) || "";
			const nameB = (children[b] && children[b].Name) || "";
			return nameA.localeCompare(nameB, 'zh-CN');
		});
	}

	// 收集所有选中的叶节点（多选）
	getSelectedLeafNodes(node) {
		let result = [];
		let isLeaf = !node.Children || Object.keys(node.Children).length === 0;
		if (isLeaf && node.SpriteRenderer && node.SpriteRenderer.Sprite && node.__selected) {
			result.push(node);
		}
		if (node.Children) {
			for (let key in node.Children) {
				result = result.concat(this.getSelectedLeafNodes(node.Children[key]));
			}
		}
		return result;
	}

	// 同名连锁同步
	syncLinkedLeafsByName(name, selected) {
		// 收集所有匹配节点（保持原来包含匹配逻辑）
		let matches = [];
		function traverseCollect(node) {
			if (node.SpriteRenderer && node.SpriteRenderer.Sprite && node.Name && node.Name !== name && node.Name.includes(name)) {
				matches.push(node);
			}
			if (node.Children) {
				for (let key in node.Children) traverseCollect(node.Children[key]);
			}
		}
		traverseCollect(this.app.rootNode);

		if (!matches.length) return;

		// 正则检测后缀形如 _01、_02、_3 等
		const suffixRe = /^(.*)_(\d+)$/;

		// 分组：带后缀按前缀分组，不带后缀单独处理
		let groups = new Map(); // key: prefix, value: array of {node, idx}
		for (let node of matches) {
			let m = node.Name.match(suffixRe);
			if (m) {
				let prefix = m[1];
				let idx = parseInt(m[2], 10);
				if (!groups.has(prefix)) groups.set(prefix, []);
				groups.get(prefix).push({ node, idx });
			} else {
				// 非后缀直接设置（和之前行为一致）
				node.__selected = selected;
			}
		}

		// 对每个带后缀的组，只选择 idx 最小的一个，其余取消选择
		for (let [prefix, arr] of groups.entries()) {
			// 找到最小 idx 的节点（如果相同 idx 多个，选第一个遇到的）
			arr.sort((a, b) => a.idx - b.idx);
			let first = arr[0];
			// 设定选中状态：第一个为 selected，其余为 false
			first.node.__selected = selected;
			for (let i = 1; i < arr.length; i++) {
				arr[i].node.__selected = false;
			}
		}
	}

	setLeafSelected(node, selected) {
		node.__selected = selected;
		if (node.Name) this.syncLinkedLeafsByName(node.Name, selected);
	}

	selectEnabledIfNoneSelected(otherLeafs) {
		let hasSelected = otherLeafs.some(n => n.__selected);
		if (!hasSelected && otherLeafs.length > 0) {
			let enabledIdx = otherLeafs.findIndex(n => n.SpriteRenderer.Enabled);
			otherLeafs.forEach((n, i) => this.setLeafSelected(n, i === enabledIdx && enabledIdx !== -1));
		}
	}
	selectEnabledIfNoneSelectedByNode(node) {
		if (node && node.Children) {
			let otherLeafs = Object.values(node.Children).filter(n => n.SpriteRenderer && n.SpriteRenderer.Sprite);
			this.selectEnabledIfNoneSelected(otherLeafs);
		}
	}

	// 渲染整个树（与原 renderTreeSelector 行为对应）
	render(rootNode) {
		// Ensure we have a container to render into. Try to resolve again in case DOM changed.
		if (!this.controlsContentDiv) {
			this.controlsContentDiv = document.getElementById("controls-content") || document.getElementById('drawer-controls-content');
		}
		if (!this.controlsContentDiv) return; // nothing to render into yet
		this.controlsContentDiv.innerHTML = "";

		// 回读折叠状态（保持）
		this.treeCollapseState = this.loadCollapseCache();

		const isFirstRender = !window.__treeSelectorRendered;
		window.__treeSelectorRendered = true;

		let hasCache = false;
		if (isFirstRender) {
			hasCache = !!localStorage.getItem(this.getSelectionCacheKey());
			if (hasCache) this.loadSelectionCache(rootNode);
		}

		// 寻找特殊节点引用
		let armsNode = null, armLNode = null, armRNode = null;
		function findSpecialNodes(node) {
			if (node.Name === "Arms") armsNode = node;
			if (node.Name === "ArmL") armLNode = node;
			if (node.Name === "ArmR") armRNode = node;
			if (node.Children) for (let k in node.Children) findSpecialNodes(node.Children[k]);
		}
		findSpecialNodes(rootNode);

		// 递归渲染
		const singleSelectGroups = ["ArmL", "ArmR", "Arms", "Eyes", "Mouth", "Eyes01", "Mouth01"];
		const that = this;

		function renderNode(node, path = []) {
			if (!TreeSelector.hasLeafSprite(node)) return null;

			const nodeDiv = document.createElement("div");
			nodeDiv.className = "tree-parent-group";

			const headerDiv = document.createElement("div");
			headerDiv.className = "tree-header";
			headerDiv.style.cursor = "pointer";

			const nodeKey = path.concat(node.Name || "").join("/");
			let collapsed = !!that.treeCollapseState[nodeKey];

			const toggleBtn = document.createElement("span");
			toggleBtn.className = "tree-toggle";
			toggleBtn.textContent = collapsed ? "▶" : "▼";
			headerDiv.appendChild(toggleBtn);

			const titleSpan = document.createElement("span");
			titleSpan.className = "tree-title";
			titleSpan.textContent = node.Name || "(未命名)";
			headerDiv.appendChild(titleSpan);

			nodeDiv.appendChild(headerDiv);

			const gridDiv = document.createElement("div");
			gridDiv.className = "thumb-grid";
			gridDiv.style.display = collapsed ? "none" : "grid";

			// 收集直接叶节点子节点并排序
			let leafNodes = [];
			if (node.Children) {
				const sortedKeys = TreeSelector.sortedChildKeys(node.Children);
				for (let key of sortedKeys) {
					let child = node.Children[key];
					if (child.SpriteRenderer && child.SpriteRenderer.Sprite) leafNodes.push(child);
				}
			}

			const isSingleSelect = singleSelectGroups.includes(node.Name);

			// 首次渲染初始化选择状态（无缓存）
			if (isFirstRender && leafNodes.length > 0 && !hasCache) {
				let hasEnabled = leafNodes.some(n => n.SpriteRenderer.Enabled);
				if (isSingleSelect) {
					let idx = leafNodes.findIndex(n => n.SpriteRenderer.Enabled);
					leafNodes.forEach((n, i) => n.__selected = (i === idx && hasEnabled ? true : false));
				} else {
					leafNodes.forEach(n => n.__selected = !!n.SpriteRenderer.Enabled && hasEnabled);
				}
			}

			leafNodes.forEach((childNode, idx) => {
				const thumbDiv = document.createElement("div");
				thumbDiv.className = "thumb-node";
				if (childNode.__selected) thumbDiv.classList.add("selected");

				const img = document.createElement("img");
				img.className = "thumb-img";
				img.src = `/images/character/${that.app.currentCharacter}/${childNode.SpriteRenderer.Sprite.Name}.webp`;
				img.alt = childNode.Name || "";
				thumbDiv.appendChild(img);

				const nameDiv = document.createElement("div");
				nameDiv.className = "thumb-name";
				nameDiv.textContent = childNode.Name || "(未命名)";
				thumbDiv.appendChild(nameDiv);

				thumbDiv.onclick = function() {
					// Arms 与 ArmL/ArmR 互斥逻辑，同原实现
					if (node.Name === "Arms" && childNode.__selected === false) {
						if (armLNode && armLNode.Children) Object.values(armLNode.Children).forEach(n => that.setLeafSelected(n, false));
						if (armRNode && armRNode.Children) Object.values(armRNode.Children).forEach(n => that.setLeafSelected(n, false));
					} else if (node.Name === "Arms" && childNode.__selected === true) {
						that.selectEnabledIfNoneSelectedByNode(armLNode);
						that.selectEnabledIfNoneSelectedByNode(armRNode);
					}
                    

					if ((node.Name === "ArmL" || node.Name === "ArmR") && !childNode.__selected) {
						if (armsNode && armsNode.Children) {
							Object.values(armsNode.Children)
								.filter(n => n.SpriteRenderer && n.SpriteRenderer.Sprite)
								.forEach(n => that.setLeafSelected(n, false));
						}
						let otherNode = node.Name === "ArmL" ? armRNode : armLNode;
						that.selectEnabledIfNoneSelectedByNode(otherNode);
					}

					if (isSingleSelect) {
						// 新增：如果是 ArmL / ArmR 分组，点击已选项时直接忽略（禁止手动取消）
						if ((node.Name === "ArmL" || node.Name === "ArmR") && childNode.__selected) {
							return;
						}

						if (childNode.__selected) {
							that.setLeafSelected(childNode, false);
						} else {
							leafNodes.forEach(n => { if (n.__selected) that.setLeafSelected(n, false); });
							that.setLeafSelected(childNode, true);
						}
					} else {
						that.setLeafSelected(childNode, !childNode.__selected);
					}

					that.saveSelectionCache(rootNode);
					that.render(rootNode);
					that.app.renderer.composeAndDraw();
				};

				gridDiv.appendChild(thumbDiv);
			});

			nodeDiv.appendChild(gridDiv);

			const childrenDiv = document.createElement("div");
			childrenDiv.className = "tree-children";
			childrenDiv.style.display = collapsed ? "none" : "block";

			if (node.Children) {
				const sortedKeys = TreeSelector.sortedChildKeys(node.Children);
				for (let key of sortedKeys) {
					let child = node.Children[key];
					if (child.Children && Object.keys(child.Children).length > 0) {
						const childTree = renderNode(child, path.concat(node.Name || ""));
						if (childTree) childrenDiv.appendChild(childTree);
					}
				}
			}

			nodeDiv.appendChild(childrenDiv);

			headerDiv.onclick = function() {
				collapsed = !collapsed;
				gridDiv.style.display = collapsed ? "none" : "grid";
				childrenDiv.style.display = collapsed ? "none" : "block";
				toggleBtn.textContent = collapsed ? "▶" : "▼";
				that.treeCollapseState[nodeKey] = collapsed;
				that.saveCollapseCache();
			};

			return nodeDiv;
		}

		const tree = renderNode(rootNode);
		if (tree) this.controlsContentDiv.appendChild(tree);
	}
}

class Renderer {
	constructor(app) {
		this.app = app;
		this.offscreenCanvas = null;
		this.offscreenCtx = null;
		this.offscreenWidth = 0;
		this.offscreenHeight = 0;
		this.maskAlphaCache = {}; // 缓存 mask
		this.firstDraw = true;
	}

	// 主画布绘制（使用 app.view 与 offscreenCanvas）
	drawToMainCanvas() {
		const canvas = this.app.canvas;
		const ctx = this.app.ctx;
		if (!canvas || !ctx) return;
		// Clear using display size aware clearing
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		if (!this.offscreenCanvas) return;

		// Ensure backing store matches display size
		let dpr = window.devicePixelRatio || 1;
		const displayWidth = Math.round(canvas.clientWidth * dpr);
		const displayHeight = Math.round(canvas.clientHeight * dpr);
		if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
			canvas.width = displayWidth;
			canvas.height = displayHeight;
		}

		ctx.save();
		if (this.app.panzoom && this.app.panzoom.isActive) {
			// When panzoom is active the visual transform is handled by CSS transform
			// so just draw the offscreen canvas to fit the physical canvas
			try {
				ctx.drawImage(this.offscreenCanvas, 0, 0, canvas.width, canvas.height);
			} catch (e) {
				// fallback if drawImage with sizing fails
				ctx.drawImage(this.offscreenCanvas, 0, 0);
			}
		} else {
			let scale = this.app.view.scale || 1;
			let offsetX = (this.app.view.offsetX || 0) * dpr;
			let offsetY = (this.app.view.offsetY || 0) * dpr;

			if (this.firstDraw && this.offscreenWidth > 0 && this.offscreenHeight > 0) {
				let scaleX = canvas.width / this.offscreenWidth;
				let scaleY = canvas.height / this.offscreenHeight;
				scale = Math.min(scaleX, scaleY, 1);
				offsetX = (canvas.width - this.offscreenWidth * scale) / 2;
				offsetY = (canvas.height - this.offscreenHeight * scale) / 2;
				this.app.view.scale = scale;
				this.app.view.offsetX = offsetX / dpr;
				this.app.view.offsetY = offsetY / dpr;
				this.firstDraw = false;
			}

			ctx.translate(offsetX, offsetY);
			ctx.scale(scale, scale);
			ctx.drawImage(this.offscreenCanvas, 0, 0);
		}
		ctx.restore();
	}

	// 合成并绘制（核心函数，参考原 composeAndDraw）
	composeAndDraw() {
		const t0 = performance.now();
		let selectedNodes = this.app.selector.getSelectedLeafNodes(this.app.rootNode);
		selectedNodes.sort((a, b) => {
			let sa = a.SpriteRenderer.SortingOrder || 0;
			let sb = b.SpriteRenderer.SortingOrder || 0;
			return sa - sb;
		});
		const t1 = performance.now();
		console.log(`[composeAndDraw] 选中节点收集与排序耗时: ${(t1-t0).toFixed(2)}ms`);

		let loadPromises = selectedNodes.map(node => {
			let sprite = node.SpriteRenderer.Sprite;
			if (!sprite || !sprite.Name) return Promise.resolve(null);
			let img = new Image();
			img.src = `/images/character/${this.app.currentCharacter}/${sprite.Name}.webp`;
			return new Promise(resolve => {
				img.onload = () => resolve({img, node});
				img.onerror = () => resolve(null);
			});
		});

		loadPromises.length === 0 && console.log("[composeAndDraw] 无需加载图片");

		Promise.all(loadPromises).then(results => {
			const t2 = performance.now();
			console.log(`[composeAndDraw] 图片加载耗时: ${(t2-t1).toFixed(2)}ms`);

			let imagesInfo = [];
			let bboxes = [];
			results.forEach(res => {
				if (!res) return;
				let {img, node} = res;
				let trans = node.Transform || {};
				let pos = trans.Position || {x:0, y:0, z:0};
				let scale = trans.Scale || {x:1, y:1};
				let pixels_to_units = (node.SpriteRenderer.Sprite.PixelsToUnits) || 100.0;
				let pivot = node.SpriteRenderer.Sprite.Pivot || {x:0.5, y:0.5};
				let scaled_w = img.width * scale.x;
				let scaled_h = img.height * scale.y;
				let color = node.SpriteRenderer.Color || {r:1,g:1,b:1,a:1};
				let px = pos.x * pixels_to_units;
				let py = pos.y * pixels_to_units;
				let pivot_offset_x = pivot.x * scaled_w;
				let pivot_offset_y = pivot.y * scaled_h;
				let left = px - pivot_offset_x;
				let right = left + scaled_w;
				let top = py + (scaled_h - pivot_offset_y);
				let bottom = top - scaled_h;
				bboxes.push([left, top, right, bottom]);
				imagesInfo.push({
					img, px, py, pivot_offset_x, pivot_offset_y, scaled_w, scaled_h, color, left, top, spriteName: node.SpriteRenderer.Sprite.Name, scale, node
				});
			});

			if (!imagesInfo.length) return;

			let min_x = Math.min(...bboxes.map(b=>b[0]));
			let max_x = Math.max(...bboxes.map(b=>b[2]));
			let min_y = Math.min(...bboxes.map(b=>b[3]));
			let max_y = Math.max(...bboxes.map(b=>b[1]));
			this.offscreenWidth = Math.ceil(max_x - min_x);
			this.offscreenHeight = Math.ceil(max_y - min_y);

			this.offscreenCanvas = document.createElement("canvas");
			this.offscreenCanvas.width = this.offscreenWidth;
			this.offscreenCanvas.height = this.offscreenHeight;
			this.offscreenCtx = this.offscreenCanvas.getContext("2d");
			this.offscreenCtx.clearRect(0, 0, this.offscreenWidth, this.offscreenHeight);

			// 清空 mask 缓存（每次合成新建或保留？保留可以重用；这里清空以避免孤立缓存）
			this.maskAlphaCache = {};

			const t3 = performance.now();
			console.log(`[composeAndDraw] 图片信息与bbox计算耗时: ${(t3-t2).toFixed(2)}ms`);

			const t4_start = performance.now();
			imagesInfo.forEach((info, idx) => {
				const t_layer_start = performance.now();
				let {img, px, py, pivot_offset_x, pivot_offset_y, scaled_w, scaled_h, color, left, top, scale, node} = info;

				// 临时 canvas 处理并缩放
				const t_canvas_start = performance.now();
				let tempCanvas = document.createElement("canvas");
				tempCanvas.width = Math.max(1, Math.ceil(scaled_w));
				tempCanvas.height = Math.max(1, Math.ceil(scaled_h));
				let tempCtx = tempCanvas.getContext("2d");
				tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
				tempCtx.save();
				// 为了避免二次放缩模糊，先 drawImage 原图到缩放后的大小
				tempCtx.drawImage(img, 0, 0, tempCanvas.width, tempCanvas.height);
				tempCtx.restore();
				const t_canvas_end = performance.now();

				// 颜色应用（替代 getImageData，使用 source-in 技巧）
				const t_color_start = performance.now();
				if (!(color.r === 1 && color.g === 1 && color.b === 1 && color.a === 1)) {
					let colorCanvas = document.createElement("canvas");
					colorCanvas.width = tempCanvas.width;
					colorCanvas.height = tempCanvas.height;
					let colorCtx = colorCanvas.getContext("2d");
					colorCtx.clearRect(0, 0, colorCanvas.width, colorCanvas.height);
					colorCtx.fillStyle = `rgba(${Math.round(color.r*255)}, ${Math.round(color.g*255)}, ${Math.round(color.b*255)}, ${color.a})`;
					colorCtx.fillRect(0, 0, colorCanvas.width, colorCanvas.height);
					colorCtx.globalCompositeOperation = "source-in";
					colorCtx.drawImage(tempCanvas, 0, 0);
					tempCanvas = colorCanvas;
				}
				const t_color_end = performance.now();

				let paste_x = Math.round(px - pivot_offset_x - min_x);
				let paste_y = Math.round(max_y - py - (scaled_h - pivot_offset_y));

				// mask 处理
				const t_mask_start = performance.now();
				let floats = null;
				if (node.SpriteRenderer.Materials && node.SpriteRenderer.Materials.length > 0) {
					floats = node.SpriteRenderer.Materials[0].Floats || {};
				}
				let stencilRef = floats && floats._StencilRef ? floats._StencilRef : 0;
				let stencilComp = floats && floats._StencilComp ? floats._StencilComp : 0;

				if (stencilRef !== 0 && stencilComp === 8) {
					// 被 mask 图层：记录到 mask 缓存并同时绘制到最终结果
					let maskObj = this.ensureMaskCanvas(stencilRef);
					let maskCtx = maskObj.ctx;
					maskCtx.globalCompositeOperation = "source-over";
					maskCtx.drawImage(tempCanvas, paste_x, paste_y);

					let materialName = (node.SpriteRenderer.Materials && node.SpriteRenderer.Materials[0].Name) || "";
					this.offscreenCtx.globalCompositeOperation = this.getCompositeOp(materialName);
					this.offscreenCtx.globalAlpha = 1;
					this.offscreenCtx.drawImage(tempCanvas, paste_x, paste_y);
					this.offscreenCtx.globalCompositeOperation = "source-over";
				}
				else if (stencilRef !== 0 && stencilComp === 4) {
					// 使用之前的 mask 缓存对本图层裁剪
					let maskObj = this.maskAlphaCache[stencilRef];
					if (maskObj) {
						let maskedCanvas = document.createElement("canvas");
						maskedCanvas.width = tempCanvas.width;
						maskedCanvas.height = tempCanvas.height;
						let maskedCtx = maskedCanvas.getContext("2d");

						// 把 mask 的对应区域绘制到 maskedCanvas
						maskedCtx.drawImage(
							maskObj.canvas,
							paste_x, paste_y, tempCanvas.width, tempCanvas.height,
							0, 0, tempCanvas.width, tempCanvas.height
						);

						// 用 source-in 将 tempCanvas 裁剪到 mask
						maskedCtx.globalCompositeOperation = "source-in";
						maskedCtx.drawImage(tempCanvas, 0, 0);

						let materialName = (node.SpriteRenderer.Materials && node.SpriteRenderer.Materials[0].Name) || "";
						this.offscreenCtx.globalCompositeOperation = this.getCompositeOp(materialName);

						this.offscreenCtx.globalAlpha = 1;
						this.offscreenCtx.drawImage(maskedCanvas, paste_x, paste_y);
						this.offscreenCtx.globalCompositeOperation = "source-over";
					}
				} else {
					// 普通图层
					let materialName = (node.SpriteRenderer.Materials && node.SpriteRenderer.Materials[0].Name) || "";
					this.offscreenCtx.globalCompositeOperation = this.getCompositeOp(materialName);
					this.offscreenCtx.globalAlpha = 1;
					this.offscreenCtx.drawImage(tempCanvas, paste_x, paste_y);
					this.offscreenCtx.globalCompositeOperation = "source-over";
				}
				const t_mask_end = performance.now();

				const t_layer_end = performance.now();
				console.log(`[composeAndDraw] 图层${idx}(${node.Name || ''})耗时: 总${(t_layer_end-t_layer_start).toFixed(2)}ms, ` +
					`canvas+缩放${(t_canvas_end-t_canvas_start).toFixed(2)}ms, ` +
					`颜色${(t_color_end-t_color_start).toFixed(2)}ms, ` +
					`mask/绘制${(t_mask_end-t_mask_start).toFixed(2)}ms`);
			});
			const t4_end = performance.now();
			console.log(`[composeAndDraw] 图层合成耗时: ${(t4_end-t4_start).toFixed(2)}ms`);

			// 合成完成后绘制到主画布（居中缩放）
			const t6_start = performance.now();
			this.drawToMainCanvas();
			const t6_end = performance.now();
			console.log(`[composeAndDraw] 主画布绘制耗时: ${(t6_end-t6_start).toFixed(2)}ms`);
			console.log(`[composeAndDraw] 总耗时: ${(t6_end-t0).toFixed(2)}ms`);
		});

	}

	saveImage() {
		if (!this.offscreenCanvas) return;
		let dataURL = this.offscreenCanvas.toDataURL("image/webp", 1.0);
		let a = document.createElement("a");
		a.href = dataURL;
		a.download = `${this.app.currentCharacter}.webp`;
		a.click();
	}

	// 新增：根据材质名返回合成模式
	getCompositeOp(materialName) {
		if (!materialName) return "source-over";
		if (materialName.startsWith("Naninovel_Multiply")) return "multiply";
		if (materialName.startsWith("Naninovel_Softlight")) return "luminosity";
		return "source-over";
	}

	// 新增：确保 mask canvas 存在并返回对象
	ensureMaskCanvas(stencilRef) {
		if (!this.maskAlphaCache[stencilRef]) {
			let maskCanvas = document.createElement("canvas");
			maskCanvas.width = this.offscreenWidth;
			maskCanvas.height = this.offscreenHeight;
			let maskCtx = maskCanvas.getContext("2d");
			maskCtx.clearRect(0, 0, this.offscreenWidth, this.offscreenHeight);
			this.maskAlphaCache[stencilRef] = {canvas: maskCanvas, ctx: maskCtx};
		}
		return this.maskAlphaCache[stencilRef];
	}
}

class App {
	constructor(rootNode, currentCharacter) {
		this.rootNode = rootNode;
		this.currentCharacter = currentCharacter || window.currentCharacter || "unknown";
		// DOM
		this.parentSelect = document.getElementById("parentSelect");
		this.childSelect = document.getElementById("childSelect");
		this.canvas = document.getElementById("canvas");
		this.ctx = this.canvas.getContext("2d");
		this.saveBtn = document.getElementById("saveBtn");

		// 视图状态（拖拽 & 缩放）
		this.view = {
			scale: 1,
			offsetX: 0,
			offsetY: 0,
			dragging: false,
			dragStartX: 0,
			dragStartY: 0,
			lastOffsetX: 0,
			lastOffsetY: 0
		};

		this.isSplitterDragging = false;

		// 子系统
		this.selector = new TreeSelector(this);
		this.renderer = new Renderer(this);

		// Panzoom manager will enable touch-friendly pan/zoom using @panzoom/panzoom
		this.panzoom = null;

		// 事件与初始化
		this.initEvents();
		this.selector.render(this.rootNode);
		this.renderer.composeAndDraw();

		// Initialize Panzoom if available
		if (window.Panzoom) {
			this.panzoom = new PanzoomManager(this);
			this.panzoom.init();
		}

		// 初始化移动抽屉引用
		this.mobileDrawer = document.getElementById('mobile-drawer');
		this.drawerHandle = document.getElementById('drawer-handle');
		this.drawerContent = document.getElementById('drawer-controls-content');

		// 保证移动抽屉内按钮运行：绑定移动版按钮到现有功能
		const saveMobile = document.getElementById('saveBtn_mobile');
		if (saveMobile) saveMobile.onclick = () => this.renderer.saveImage();
		const backMobile = document.getElementById('backBtn_mobile');
		if (backMobile) backMobile.onclick = () => { window.location.href = '/'; };
		const resetMobile = document.getElementById('resetBtn_mobile');
		if (resetMobile) resetMobile.onclick = () => {
			this.selector.clearSelectionCache();
			localStorage.removeItem(this.selector.getCollapseCacheKey());
			window.__treeSelectorRendered = false;
			this.selector.render(this.rootNode);
			this.renderer.composeAndDraw();
		};

		// 绑定抽屉事件
		this.setupDrawer();

		// 根据视口决定 selector 渲染目标：移动端渲染到抽屉内，桌面渲染到 controls
		const isMobile = window.innerWidth <= 800 && this.drawerContent;
		if (isMobile) {
			// 替换 selector 的容器引用并渲染
			this.selector.controlsContentDiv = this.drawerContent;
			this.selector.render(this.rootNode);
			// 自动展开抽屉（移动端直接展示选择器）
			if (this.openDrawer) this.openDrawer();
		} else {
			this.selector.controlsContentDiv = document.getElementById('controls-content');
			this.selector.render(this.rootNode);
		}

		// 暴露给外部（主脚本）
		window.app = this;
	}

	// 抽屉相关的初始化与事件绑定
	setupDrawer() {
		if (!this.mobileDrawer || !this.drawerHandle) return;
		const drawer = this.mobileDrawer;
		const handle = this.drawerHandle;
		let startY = 0, startHeight = 0, dragging = false, touchMoved = false;

		// 将 open/close 方法暴露到实例上，便于外部调用（比如备用按钮）
		this.openDrawer = () => {
			drawer.style.display = 'block'; // 强制显示（覆盖 media query 仅用于调试/降级）
			drawer.classList.remove('drawer-closed');
			drawer.classList.add('drawer-open');
			drawer.setAttribute('aria-hidden', 'false');
		};
		this.closeDrawer = () => {
			drawer.classList.remove('drawer-open');
			drawer.classList.add('drawer-closed');
			drawer.setAttribute('aria-hidden', 'true');
			// 恢复 display（如果媒体查询会隐藏的话）
			if (window.innerWidth > 800) drawer.style.display = '';
		};

		handle.addEventListener('click', (e) => {
			if (drawer.classList.contains('drawer-open')) this.closeDrawer();
			else this.openDrawer();
		});

		// touch drag
		handle.addEventListener('touchstart', (e) => {
			dragging = true;
			touchMoved = false;
			startY = e.touches[0].clientY;
			startHeight = drawer.getBoundingClientRect().height;
			e.preventDefault();
		}, { passive: false });

		handle.addEventListener('touchmove', (e) => {
			if (!dragging) return;
			let dy = startY - e.touches[0].clientY; // 向上为正
			// 如果移动超过阈值，视为拖动
			if (Math.abs(dy) > 6) touchMoved = true;
			let newHeight = Math.max(48, Math.min(window.innerHeight * 0.9, startHeight + dy));
			drawer.style.height = newHeight + 'px';
			e.preventDefault();
		}, { passive: false });

			handle.addEventListener('touchend', (e) => {
				dragging = false;
				// 如果是轻触（无明显移动），则视为 tap，切换抽屉
				if (!touchMoved) {
					if (drawer.classList.contains('drawer-open')) this.closeDrawer(); else this.openDrawer();
				} else {
					let rect = drawer.getBoundingClientRect();
					// 如果高度超过屏幕的一半则打开，否则关闭
					if (rect.height > window.innerHeight * 0.4) this.openDrawer(); else this.closeDrawer();
				}
				drawer.style.height = '';
				e.preventDefault();
			}, { passive: false });

		// 不使用按钮打开抽屉（遵循用户要求），保留 openDrawer/closeDrawer 方法供内部调用
	}

	// 新增：从容器设置 canvas 尺寸
	setCanvasSizeFromContainer() {
		const canvasContainer = document.getElementById("canvas-container");
		if (!canvasContainer) return;
		const rect = canvasContainer.getBoundingClientRect();
		this.canvas.width = rect.width;
		this.canvas.height = rect.height;
	}

	// 新增：统一绑定按钮
	attachButton(id, handler) {
		const el = document.getElementById(id);
		if (el) el.onclick = handler;
	}

	initEvents() {
		// 拖拽
		this.canvas.addEventListener("mousedown", (e) => {
			this.view.dragging = true;
			this.view.dragStartX = e.clientX;
			this.view.dragStartY = e.clientY;
			this.view.lastOffsetX = this.view.offsetX;
			this.view.lastOffsetY = this.view.offsetY;
		});
		window.addEventListener("mousemove", (e) => {
			if (this.view.dragging) {
				this.view.offsetX = this.view.lastOffsetX + (e.clientX - this.view.dragStartX);
				this.view.offsetY = this.view.lastOffsetY + (e.clientY - this.view.dragStartY);
				this.renderer.drawToMainCanvas();
			}
		});
		window.addEventListener("mouseup", () => {
			this.view.dragging = false;
			this.renderer.drawToMainCanvas();
		});

		// 滚轮缩放
		this.canvas.addEventListener("wheel", (e) => {
			// If panzoom is active, let it handle wheel events
			if (this.panzoom && this.panzoom.isActive) return;
			e.preventDefault();
			let oldScale = this.view.scale;
			if (e.deltaY < 0) this.view.scale *= 1.1;
			else this.view.scale /= 1.1;
			let rect = this.canvas.getBoundingClientRect();
			let mx = e.clientX - rect.left;
			let my = e.clientY - rect.top;
			this.view.offsetX = mx - (mx - this.view.offsetX) * (this.view.scale / oldScale);
			this.view.offsetY = my - (my - this.view.offsetY) * (this.view.scale / oldScale);
			this.renderer.drawToMainCanvas();
		}, { passive: false });

		// 窗口大小自适应（非分割线拖动时）
		window.addEventListener("resize", () => {
			if (this.isSplitterDragging) return;
			this.setCanvasSizeFromContainer();
			this.renderer.drawToMainCanvas();
		});
		// 立即触发一次大小调整
		this.setCanvasSizeFromContainer();

		// 分割线拖动（保留原有优化）
		(function(that){
			const splitter = document.getElementById("splitter");
			const controls = document.getElementById("controls");
			if (!splitter || !controls) return;
			let dragging = false;
			let lastWidth = null;
			let animationFrameId = null;

			function updateWidth(e) {
				const layoutRect = document.getElementById("main-layout").getBoundingClientRect();
				let newWidth = e.clientX - layoutRect.left;
				newWidth = Math.max(200, Math.min(newWidth, 800));
				if (lastWidth !== newWidth) {
					controls.style.flexBasis = newWidth + "px";
					lastWidth = newWidth;
					that.isSplitterDragging = true;
					that.setCanvasSizeFromContainer();
					that.renderer.drawToMainCanvas();
				}
			}

			splitter.addEventListener("mousedown", function(e) {
				dragging = true;
				that.isSplitterDragging = true;
				document.body.style.cursor = "ew-resize";
				document.body.style.userSelect = "none";
			});
			window.addEventListener("mousemove", function(e) {
				if (!dragging) return;
				if (animationFrameId) return;
				animationFrameId = requestAnimationFrame(() => {
					updateWidth(e);
					animationFrameId = null;
				});
			});
			window.addEventListener("mouseup", function() {
				if (dragging) {
					dragging = false;
					that.isSplitterDragging = false;
					document.body.style.cursor = "";
					document.body.style.userSelect = "";
					animationFrameId = null;
				}
			});
		})(this);

		// 按钮事件：保存/返回/重置
		this.attachButton("saveBtn", () => this.renderer.saveImage());
		this.attachButton("backBtn", () => { window.location.href = '/'; });
		this.attachButton("resetBtn", () => {
			this.selector.clearSelectionCache();
			localStorage.removeItem(this.selector.getCollapseCacheKey());
			window.__treeSelectorRendered = false;
			this.selector.render(this.rootNode);
			this.renderer.composeAndDraw();
		});

		// Drawer 交互：手柄点击/拖拽打开/关闭抽屉（仅在移动端）
		// 抽屉事件在构造函数中 setupDrawer() 里绑定（确保 DOM 已存在）

		// 触摸事件支持：单指平移，双指捏合缩放
		let lastTouchDist = 0;
		let lastTouchCenter = null;
		let gestureMode = null; // "pan" 或 "zoom"

		this.canvas.addEventListener('touchstart', (e) => {
			if (this.panzoom && this.panzoom.isActive) return;

			if (e.touches.length === 1) {
				gestureMode = "pan";
				const t = e.touches[0];
				this.view.dragging = true;
				this.view.dragStartX = t.clientX;
				this.view.dragStartY = t.clientY;
				this.view.lastOffsetX = this.view.offsetX;
				this.view.lastOffsetY = this.view.offsetY;
			} else if (e.touches.length === 2) {
				gestureMode = "zoom";
				// 初始化捏合
				const t0 = e.touches[0], t1 = e.touches[1];
				lastTouchDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
				lastTouchCenter = { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
			}

			// 阻止页面滚动以获得更好的交互
			e.preventDefault();
		}, { passive: false });

		this.canvas.addEventListener('touchmove', (e) => {
			if (this.panzoom && this.panzoom.isActive) return;

			if (gestureMode === "pan" && e.touches.length === 1 && this.view.dragging) {
				const t = e.touches[0];
				this.view.offsetX = this.view.lastOffsetX + (t.clientX - this.view.dragStartX);
				this.view.offsetY = this.view.lastOffsetY + (t.clientY - this.view.dragStartY);
				this.renderer.drawToMainCanvas();
			} else if (gestureMode === "zoom" && e.touches.length === 2) {
				const t0 = e.touches[0], t1 = e.touches[1];
				const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
				const center = { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
				if (lastTouchDist > 0) {
					let oldScale = this.view.scale;
					let factor = dist / lastTouchDist;
					this.view.scale = Math.max(0.1, Math.min(5, this.view.scale * factor));
					// 根据中心点调整偏移以实现以双指中心为缩放锚点
					let rect = this.canvas.getBoundingClientRect();
					let mx = center.x - rect.left;
					let my = center.y - rect.top;
					this.view.offsetX = mx - (mx - this.view.offsetX) * (this.view.scale / oldScale);
					this.view.offsetY = my - (my - this.view.offsetY) * (this.view.scale / oldScale);
					this.renderer.drawToMainCanvas();
				}
				lastTouchDist = dist;
				lastTouchCenter = center;
			}

			e.preventDefault();
		}, { passive: false });

		this.canvas.addEventListener('touchend', (e) => {
			if (e.touches.length === 0) {
				this.view.dragging = false;
				lastTouchDist = 0;
				lastTouchCenter = null;
				gestureMode = null; // 重置模式
			}
			e.preventDefault();
		});

	}
}

const app = new App(rootNode, currentCharacter);
