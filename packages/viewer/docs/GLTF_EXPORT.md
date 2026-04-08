# GLB / glTF 导出说明

## 流程概览

1. **克隆**要导出的子树（编辑器使用 `scene-renderer` 的 `Object3D.clone(true)`；独立 Viewer 使用整场景克隆并去掉 `EDITOR_LAYER` 上的对象）。
2. 调用 **`prepareObject3DForGltfExport`**（`packages/viewer/src/lib/gltf-export-prepare.ts`）：
   - **不可见几何**：`Material.visible === false` 的 Mesh / Line / Points 不会写入 glTF（glTF 无该字段，否则会变成默认不透明白板）。若该节点仍有子物体（如窗体根 hitbox 下的框与玻璃），则改为 **`Group`** 承接变换与子层级；`Object3D.visible === false` 的节点由 `GLTFExporter`（`onlyVisible`）自行跳过。
   - **元数据**：从 `useRegistry` 写入的 `pascalNodeId` / `pascalNodeType` 向下遍历，向每个对象写入 `userData.type` 与 `userData.nodeId`（与 `GLTF_EXPORT_USERDATA_KEYS` 一致），`GLTFExporter` 会将其序列化为 **`extras`**。
   - **材质**：将 WebGPU 的 `MeshStandardNodeMaterial`、`MeshBasicNodeMaterial` 等转为 **glTF 导出器兼容** 的 `MeshStandardMaterial` / `MeshBasicMaterial` / `MeshPhysicalMaterial` 等，避免 PBR 与节点材质在 glTF 中丢失或退化。

窗、门相对墙体的外立面偏移由 **`getWindowExteriorFlushLocalZ`**（`@pascal-app/core`）在 **`WindowRenderer` / `WindowSystem`** 中统一计算，使洞口 CSG 与窗框同步，导出 GLB 时从外侧也更容易看到窗框与玻璃。

## `extras` 字段（节点）

| 键名 | 含义 |
|------|------|
| `type` | Pascal 节点类型，例如 `wall`、`window`、`door` |
| `nodeId` | 节点 id，例如 `wall_abc123` |

注册根节点上仍保留 `pascalNodeId` / `pascalNodeType`（由 `@pascal-app/core` 的 `useRegistry` 维护），子网格通过继承得到上述 `type` / `nodeId`。

## 当前支持的导出物体类型（与 `sceneRegistry.byType` 一致）

以下类型在场景中会注册根 `Object3D`，导出时均可打上 `type` / `nodeId`，并对子网格做材质转换：

| 类型 | 说明 |
|------|------|
| `site` | 场地 |
| `building` | 建筑 |
| `level` | 楼层 |
| `wall` | 墙 |
| `slab` | 板 |
| `ceiling` | 天花 |
| `roof` | 屋顶 |
| `roof-segment` | 屋顶分段 |
| `door` | 门 |
| `window` | 窗 |
| `item` | 置入物品（GLB 等） |
| `zone` | 区域 |
| `scan` | 扫描 |
| `guide` | 辅助指引 |

## 能力受限或未单独作为「类型」导出的内容

### 受限类型（见 `GLTF_EXPORT_LIMITED_TYPES`）

- **`zone`**：依赖 `ZONE_LAYER` 与编辑器后处理，在普通 glTF 查看器中观感与编辑器不一致。
- **`guide`**：编辑辅助，通常不是最终交付几何。
- **`scan`**：依赖外部资源与 KTX2 等，体积可能很大。
- **`level` / `site` / `building`**：多为容器或空变换，可见内容多在子节点。

### 非 Pascal 节点、无 `type` 的对象

- **网格、辅助体、工具预览**等未经过 `useRegistry` 的对象，不会带有 `pascalNodeId`，也不会在继承链上得到 `type` / `nodeId`（除非其父节点带有注册信息，子节点会继承父级 `type` / `nodeId`）。
- **编辑器专用层**（`EDITOR_LAYER`）：在 Viewer 自带 `ExportSystem` 中会在导出前移除，不包含在 GLB 中。

### 不属于「未支持的 Pascal 类型」

Schema 中定义的所有节点类型均已注册到 `sceneRegistry.byType`，**没有**单独的「Schema 有但完全不能导出」的列表；差异主要体现在 **材质还原度** 与 **是否在通用查看器中好看**（见上表「受限」）。

## 相关源码

- 规则：`packages/viewer/src/lib/gltf-export-rules.ts`
- 准备：`packages/viewer/src/lib/gltf-export-prepare.ts`
- 注册标签：`packages/core/src/hooks/scene-registry/scene-registry.ts`（`PASCAL_NODE_ID_KEY` / `PASCAL_NODE_TYPE_KEY`）
