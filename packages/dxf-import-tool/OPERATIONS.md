# DXF → Pascal 场景：操作说明

## 功能

将 ASCII DXF 中 **LINE**、**LWPOLYLINE**（拆成相邻边）转为 Pascal 编辑器的 **SceneGraph JSON**（`Site → Building → Level → Wall`），用于快速在三维里查看平面几何（每段线对应一堵竖直墙）。

## 环境

- 仓库根目录已安装 [Bun](https://bun.sh)。
- 无需额外 `npm install`（本工具无第三方依赖）。

## 命令

在任意目录执行均可，建议使用**绝对路径**指向 DXF 与输出 JSON。

```bash
bun run /path/to/editor/packages/dxf-import-tool/src/dxf-to-scene.ts \
  --input "/path/to/图纸.dxf" \
  --out "/path/to/editor/apps/editor/public/demos/from-dxf.json" \
  --max-walls 8000
```

### 常用参数

| 参数 | 说明 |
|------|------|
| `--input` / `-i` | DXF 文件路径（必填） |
| `--out` / `-o` | 输出的 SceneGraph JSON 路径（默认 `scene-from-dxf.json`） |
| `--max-walls` | 最多生成多少堵墙（避免一次实体过多） |
| `--min-length-m` | 忽略短于该长度（米）的线段，默认 `0.02` |
| `--wall-height` | 墙高（米），默认 `2.5` |
| `--wall-thickness` | 墙厚（米），默认 `0.15` |
| `--no-offset` | 不使用 `$EXTMIN` 平移原点（默认会平移，减小坐标数值） |
| `--scale-to-meters` | 手动指定「图纸单位 → 米」的乘数（覆盖 HEADER 里 `$INSUNITS` 的换算） |

## 单位与坐标

- 从 DXF **HEADER** 读取 `$INSUNITS`（例如 `4` = 毫米），再换算为米。
- 默认对 XY **减去 `$EXTMIN`**，使场景落在原点附近。

## 在编辑器里加载

1. 将生成的 JSON 放到 `apps/editor/public/demos/`（例如 `from-dxf.json`）。
2. 启动 `bun dev`，打开编辑器页面。
3. 浏览器开发者工具 Console 执行：

```js
const g = await fetch('/demos/from-dxf.json').then((r) => r.json())
localStorage.setItem('pascal-editor-scene', JSON.stringify(g))
location.reload()
```

## 限制

- 仅解析 **LINE / LWPOLYLINE**；块参照、复杂实体类型未处理。
- 结果为「竖直墙条」可视化，不是完整 BIM（房间、门窗、屋顶等需另建管线）。
