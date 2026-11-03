
# ApiTrack 流程编排画布设计规范 (Design System)

## 1. 设计理念与核心原则

针对 **ApiTrack 接口自动化测试平台** 的高频次、长时长的使用场景，流程编排（Flow Canvas）区域采用 **“背景后退，节点浮出”** 的现代极简设计语言（Refined Light 主题）。

* **视觉降噪**：去除生硬的深色边框，减少视觉干扰，让内容本身（接口数据、变量、状态）成为视觉焦点。
* **物理层级 (Z-Axis)**：摒弃纯平面的白色堆叠，利用“冷灰背景 + 纯白实体卡片 + 弥散阴影”构建清晰的 Z 轴空间感，降低长时间作业的视觉疲劳。
* **流畅交互**：节点在悬浮（Hover）时通过轻微的阴影放大和位移，提供明确的交互反馈。

---

## 2. 核心色彩与视觉变量

建议在前端项目中将以下值抽取为全局 CSS 变量（CSS Variables）或 Design Token，以便后期快速支持多主题切换。

* **画布背景色 (Canvas Background)**：`#F0F2F5` （冷浅灰色，有效拉开与节点的对比）
* **节点背景色 (Node Background)**：`#FFFFFF` （纯白，保证内部文本与图标的高对比度）
* **节点边框 (Node Border)**：`1px solid rgba(0, 0, 0, 0.02)` （极弱边框，仅作边缘极化处理）
* **节点常规阴影 (Node Shadow - Default)**：`0 4px 16px rgba(0, 0, 0, 0.06)` （柔和的弥散阴影）
* **节点悬浮阴影 (Node Shadow - Hover)**：`0 6px 20px rgba(0, 0, 0, 0.1)` （加深的阴影，增强浮动感）
* **圆角规范 (Border Radius)**：`8px` （中性偏圆润，兼顾专业感与亲和力）

---

## 3. 标准 CSS 代码实现 (可直接复用)

以下代码适用于 React Flow、Vue Flow 或自定义的画布组件。请确保将其挂载到项目的全局样式表中。

```css
/* 1. 画布底板样式：背景后退 */
.flow-canvas-container {
    background-color: #F0F2F5 !important;
}

/* 2. 流程节点基础样式：节点浮出 */
.flow-node-card {
    background-color: #FFFFFF !important;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06) !important;
    border: 1px solid rgba(0, 0, 0, 0.02) !important;
    border-radius: 8px !important;
    /* 增加过渡动画，提升交互平滑度 */
    transition: box-shadow 0.2s ease, transform 0.2s ease !important; 
}

/* 3. 流程节点交互样式：悬浮反馈 */
.flow-node-card:hover {
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.1) !important;
    transform: translateY(-1px); /* 轻微上浮 */
}
```

## 4. 后续演进建议 (To-Do)
### 4.1 多主题系统支持 (Theme System)
为满足开发/测试人员长时间高强度使用的诉求，建议在系统全局引入主题切换能力（如在右上角个人设置中增加暗色模式/护眼模式入口）。

深色模式 (Dark Mode)：推荐使用柔和深灰底色（如 #1E1E1E）配合亮深灰节点（如 #2D2D30），避免使用纯黑，降低视觉疲劳。

实现方案：将前文提到的颜色值全部转化为 CSS 变量（例如 var(--canvas-bg)），通过切换 body 标签上的 data-theme 属性实现无缝切换。

### 4.2 复杂嵌套结构的视觉强化
针对当前存在的多层级复合节点（例如 LOOP 循环、IF 条件判断）：

底色区分：建议给子节点的包裹容器（Container）增加一层极微弱的底色（如 background-color: #FAFAFA），以强化视觉上的包裹感。

边界虚线：外层容器可使用 1px dashed #D9D9D9 的虚线边框，避免与实体执行节点混淆。