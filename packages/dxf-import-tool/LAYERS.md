# DXF 图层：解析规则与命名匹配（转换用）

本文档约定从 **ASCII DXF** 中读取图层表、理解常见 **建筑/机电** 导出命名，供 `dxf-to-scene` 等转换流程做 **按图层过滤、按楼层拆分、按专业归类** 时参考。

---

## 1. 从 DXF 提取图层名（技术规则）

- 图层定义在 **`TABLE` → `LAYER`** 段中；每条记录为组码 **`0` = `LAYER`** 的符号表项。
- 在每条 **`AcDbLayerTableRecord`** 之后，组码 **`2`** 的下一行即为 **图层名字符串**（可含中文、空格、`$` 等）。
- 实现时注意：不要用「第一个组码 `2`」盲扫整条文件——同一记录内可能还有其它组码；以 **`AcDbLayerTableRecord` → `2` → 名称** 为稳定序列更可靠。
- 图层名 **区分大小写**（按 DXF 原样）；正则匹配时按需加 `i` 标志。

---

## 2. 常见命名模式（用于归类 / 写正则）

### 2.1 外部参照 / 绑定后的长前缀

从 Revit、天正、CAD 绑定 xref 等导出的图纸，图层常带 **工程名 + 分隔符 + 真实层名**，例如：

- 前缀：`某工程名20250422`
- 分隔：`$0$`、`$$0$`（多段路径时可能出现 **双 `$`**）
- 后缀：实际专业层名，如 `A-WALL`、`P-FIRE-消火栓`

**匹配建议**：若只关心「类型」而不关心工程名，可用正则 **去掉前缀**，例如：

- 取 **最后一个** `$` 之后的内容作为「规范层名候选」；或
- 匹配 `\\$0\\$` / `\\$\\$0\\$` 之后的子串（需按实际文件试跑）。

### 2.2 专业前缀（示例，非穷举）

| 前缀 / 模式 | 常见含义 |
|-------------|----------|
| `A-` | 建筑（平面、墙、柱、门窗、标注等） |
| `E-` / `E-GENE-` | 电气或通用图例（视项目而定） |
| `P-` / `P-FIRE-` | 给排水或消防 |
| `M-H-` / `M-V-` 等 `M-` | 暖通（采暖、通风等） |
| 纯中文 | 如「洁具」「房间编号」「板空洞」等说明性层 |

### 2.3 AutoCAD 保留 / 系统层

| 名称 | 说明 |
|------|------|
| `0` | 默认图层 |
| `Defpoints` | 标注定义点，常关闭打印 |

转换时若 **只导出几何墙线**，可 `skip` 或单独处理这些层。

### 2.4 填充层（PUB_HATCH）

`PUB_HATCH`、`A-ANNO-PUB-HATCH` 及带工程前缀的 **`…$PUB_HATCH`** 等为 **填充图案（HATCH）** 所用图层，转换时 **一律忽略**，不参与墙线或空间多边形推断。若出现长名与短名两条层记录，均按 **skip** 处理即可。

---

## 3. 与本工具 CLI 的对应关系

- **`--layer-regex`**：用 **第一个捕获组** 从图层名提取「楼层序号」；默认假设图层名形如「图层 1」…（见 `OPERATIONS.md`）。若图纸使用 **长前缀层名**，应改写正则为 **只针对后缀** 或 **先规范化层名再匹配**（可在预处理脚本中完成）。
- **`--unmatched-layers`**：`skip` 丢弃不匹配层；`level0` 把未匹配线段归到第 0 层。
- 当前管线主要按 **LINE/LWPOLYLINE + 图层** 出墙；**专业语义**（消防、暖通设备层）需在上层业务或后续 JSON 里扩展，本文档仅约定 **命名与解析规则**。

---

## 4. 校验清单（新 DXF 接入时）

1. 用本节 **§1** 方式列出全部图层名，检查是否有意外字符或超长名。
2. 判断是否存在 **xref 式前缀**；决定用「全名」还是「去前缀后缀」做 `layer-regex`。
3. 确认 **系统层** 是否参与导出。
4. 若需多 `Level`，确认楼层数字在图层名中的 **固定模式**，再写捕获型正则。

---

## 5. 图纸图层类型 → Pascal 项目类型（对应关系）

下列映射针对 **建筑平面图** 中常见图层后缀（可先经 **§2.1** 去掉工程前缀，得到「规范层名」再查表）。  
Pascal 侧节点定义见 `packages/core/src/schema/nodes/`；物品目录 **category** 见编辑器 `CatalogCategory`（`furniture` / `appliance` / `bathroom` / `kitchen` / `outdoor` / `window` / `door`）。

### 5.1 结构类（墙、板、屋面）

| 图纸层名特征（规范后缀示例） | Pascal 节点类型 | 说明 |
|------------------------------|-----------------|------|
| `A-WALL`、`WALL`、`A-WALL-MOVE` | **`WallNode`**（`type: wall`） | 墙定位线，与当前 `dxf-to-scene` 输出一致 |
| `A-COLU` | **`WallNode`** 或后续「柱」专用节点 | 核心无独立柱节点时，可先当墙段或仅写入 `metadata` |
| `A-板空洞` | **`SlabNode`** | 板洞轮廓需闭合线 + 洞逻辑，当前管线未实现 |
| `A-ROOF-DRAN` 等屋面排水 | **`RoofNode`** / **屋面** 语义 | 多为 2D 符号线，需与屋顶建模管线配合 |

### 5.2 开口类（门、窗）

| 图纸层名特征 | Pascal 节点类型 | 说明 |
|--------------|-----------------|------|
| `WINDOW`、`A-WIND`、`A-WIND-TEXT`、`WINDOW_TEXT` | **`WindowNode`** / `annotation` | 几何开窗可对应 `WindowNode`；**`*-TEXT`** 多为标注，对应 `annotation`（不生成窗体） |
| `DOOR`、`A-DOOR` 等 | **`DoorNode`** | 若图层仅有文字，同上归为 `annotation` |

### 5.3 空间与标注

| 图纸层名特征 | Pascal 节点类型 | 说明 |
|--------------|-----------------|------|
| `PUB_HATCH`、`A-ANNO-PUB-HATCH` | **`skip`** | **填充图案（HATCH）**，忽略 |
| `房间编号`、`E-GENE-文字`、`A-ANNO-PUB-TEXT` | **`annotation`** | 一般不参与墙线/物品生成，可进 `metadata` |

### 5.4 生活陈设与设备（物品）

| 图纸层名特征 | Pascal 节点类型 | 物品目录 `asset.category` 建议 |
|--------------|-----------------|----------------------------------|
| `洁具`、`LATRINE`、`A-PLAN-LVTRY`（卫生间平面） | **`ItemNode`**（`type: item`） | **`bathroom`** |
| `M-H-散热器片数`、`M-V-排风管设备` | **`ItemNode`** | **`appliance`**（暖通设备） |
| `P-FIRE-消火栓`、`P-FIRE-消火栓-立管` | **`ItemNode`** | **`appliance`**（或后续扩展专用消防类） |
| `A-PLAN-STAIR` | 视几何而定 | 楼梯多为线脚；**无** `StairNode` 时可暂用 `WallNode` 或 `annotation` |
| `A-PLAN-EVTR` | **`annotation`** | 电梯井多为符号/文字 |

「**生活物品**」（家具、软装）在目录中主要落在 **`furniture`**；若图纸未单独分图层，通常无法从图层名可靠推断，需结合块名或图层自定义规则。

### 5.5 程序化映射（实现）

- **`--mapping-file` 样例**：`packages/dxf-import-tool/layer-mapping.example.json`（与上表 §5.1–§5.4 对齐，含一条 xref 长名示例键）。
- 模块：`packages/dxf-import-tool/src/dxf-layer-mapping.ts`
- **`canonicalDxfLayerName()`**：去掉 xref 前缀，得到规范层名。
- **`mapDxfLayerToPascal()`**：返回 `target`（`wall`/`window`/`door`/`item`/`zone`/`slab`/`roof`/`annotation`/`skip`）及 **`item.catalog`** 提示（若适用）。
- **`dxfWallNodeDisplayName()`** / **`dxfTargetDisplayName()`**：生成墙节点展示名与中文语义标签。
- **`dxf-to-scene`** 已接入：按 **`target.kind`** 写入真实 **`type`**（`wall` / `window` / `door` / `item` / `zone` / `slab` / `roof`）；**`skip`** 与 **`annotation`** 不生成节点。详见 `OPERATIONS.md`「墙节点命名与图层语义」与 `src/dxf-scene-nodes.ts`。
