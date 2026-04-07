## 转换脚本

### 使用方式

> 浏览器打开后，基于localStorage重新加载

```javascript
const g = await fetch('/demos/example.json').then((r) => r.json())
localStorage.setItem('pascal-editor-scene', JSON.stringify(g))
location.reload()
```

### 单楼层测试文件转换

``` shell
bun run src/dxf-to-scene.ts \
  --input "/Volumes/Ti600/Workspace/DEMO/Lucas/editor/Drawing1.dxf" \
  --out "/Volumes/Ti600/Workspace/DEMO/Lucas/editor/apps/editor/public/demos/example_single.json" \
  --mapping-file layer-mapping.Drawing5.json \
  --merge-double-wall-lines \
  --max-walls 8000
```

### 多楼层测试文件转换（整楼）

可选用更强合并以减小墙段数量（**单层**平面内合并后墙段数通常更易落在几百量级；**全楼**总墙节点数会随层数增加）：

``` shell
bun run src/dxf-to-scene.ts \
  --input "/Volumes/Ti600/Workspace/DEMO/Lucas/editor/Drawing5.dxf" \
  --out "/Volumes/Ti600/Workspace/DEMO/Lucas/editor/apps/editor/public/demos/example.json" \
  --mapping-file layer-mapping.Drawing5.json \
  --merge-double-wall-lines \
  --max-walls 8000 \
  --double-wall-min-length-ratio 0 \
  --colinear-gap-merge-max-m 10 \
  --colinear-gap-merge-general-direction \
  --colinear-gap-merge-axis-align-deg 8
```

---

### 万象汇测试

### 单楼层测试文件转换

``` shell
bun run src/dxf-to-scene.ts \
  --input "/Volumes/Ti600/Workspace/DEMO/Lucas/editor/1F.dxf" \
  --out "/Volumes/Ti600/Workspace/DEMO/Lucas/editor/apps/editor/public/demos/example_1F.json" \
  --mapping-file layer-mapping.Drawing5.json \
  --merge-double-wall-lines \
  --max-walls 8000
```
