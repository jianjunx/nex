# 会话消息流虚拟渲染

日期:2026-08-01

## 背景

会话内消息流(`ThreadView`)随消息增长出现明显滚动卡顿,规模可达上千条 entry,其中包含大量默认展开的 edit 类工具卡(每张是一个完整的 CodeMirror `unifiedMergeView` 实例)。

现状问题(经代码核查确认):

1. **零虚拟化**:`@tanstack/react-virtual@3.14.8` 已在依赖中(2026-07-24 设计文档的既定选型),但 src 中零引用;`ThreadView.tsx` 用 `renderItems.map` 全量渲染,离屏 DOM 全部常驻。
2. **滚动合成开销**:每条消息包在 `Card`(`src/components/ui/card.tsx:10`)内,硬编码 `backdrop-blur-xl`;表面已是不透明纯色,模糊零视觉效果,但滚动时每张卡各产生一个 backdrop-filter 合成层。
3. **逐 token 全量 reconcile**:Rust 侧对每个 ACP `SessionUpdate` 逐个 emit(`acp_adapter.rs:85-92`)→ 前端每事件一次 immer `set` → `ThreadView.tsx:45` 订阅**整个** `entriesByConversation` map → 整列表重渲染;后台会话的流式事件也会驱动前台视图重渲染。
4. **无组件级 memo**:src 中 `React.memo` 零使用;`groupThreadEntries`(每次渲染 O(n) 重算)与 `groupChunks`(每渲染对累积全文做字符串拼接,O(n²) 趋势)均未记忆化。
5. **工具组 key 不稳定**:`groupThreadEntries.ts:22` 用组内全部 id `join(":")` 作 key,流式追加成员导致整组 remount,展开状态丢失。
6. **顺带发现的功能缺口**:消息冷恢复回退路径 `conversationGetMessages` 固定 `limit=50, offset=0` 且从不翻页,超 50 条历史的会话静默丢失旧消息。

卡顿主诉为**滚动场景**(非流式掉帧),规模为**上千条 + 大量展开 edit 卡**。用户不依赖跨消息长范围选择与原生 Ctrl+F。

## 决策

- 方案:基于既定依赖 `@tanstack/react-virtual` 做真虚拟化(卸载离屏 DOM 与编辑器实例);**不采用** CSS `content-visibility` 轻量路线(不删 DOM,千条规模下初始挂载成本与内存不降,撑不住目标规模)
- 不新增依赖;不替换为 react-virtuoso(与 2026-07-24 选型保持一致;若贴底改写实测过于棘手,换 virtuoso 是可接受的回退,改动面相近)
- 数据层(Rust 事件 → agent.store)不动,改动全部集中在视图层
- 流式节流(rAF 合批)**不在本期范围**,作为后续候选;本期靠虚拟化 + memo + 订阅收窄,流式重渲染面从整表收缩到末尾一行,已大幅缓解
- 接受虚拟化的固有限制:离屏消息无 DOM,跨多屏选择复制与原生页内查找不覆盖未渲染区(用户已确认不依赖)
- 顺带修复 50 条分页缺口(与长会话同域、成本低)

## 架构

```
Rust 逐 token 事件 → agent.store(immer,不动)
        ↓
ThreadView:订阅【当前会话】entries 数组(不再订整张 map)
        ↓
useMemo(groupThreadEntries) ← entries 引用不变则零开销
        ↓
useVirtualizer:只产出可视区 ± overscan 的行
        ↓
memo 化条目组件:entry 引用不变 → 不重渲染(immer 结构共享保证)
```

两个正确性前提(已验证):

1. immer 结构共享下,其他会话的流式更新不改变 `entriesByConversation[activeTabId]` 的数组引用;zustand 以 `Object.is` 比较 selector 结果,引用不变即不重渲染。订阅收窄同时修掉"多会话串扰"。
2. `measureElement` 内置 ResizeObserver:流式撑高末尾条目自动触发重测,`totalSize` 变化驱动贴底 effect——等价替代现有 content 级 ResizeObserver。

## 改动面

| 文件 | 改动 |
|---|---|
| `src/features/agent/thread/ThreadView.tsx` | 接入 `useVirtualizer`(动态测量);订阅收窄至 `entriesByConversation[activeTabId]`(缺省回退模块级稳定空数组常量)与 `sessions[activeTabId]?.status`;`groupThreadEntries` 包 `useMemo`;贴底逻辑改写(见下) |
| `src/features/agent/thread/EntryView.tsx`(新增,自 ThreadView 拆出) | `EntryView` 与助手消息子块 `React.memo`;`groupChunks` 包 `useMemo` 修掉 O(n²) 拼接。拆分理由:ThreadView 已 216 行且职责混杂,顺手改善单元边界 |
| `src/features/agent/thread/toolCardExpansion.ts`(新增) | 工具卡展开状态外提:`Record<toolCallId, boolean>` + 无 persist 的 zustand 小 store(与项目其余 store 同栈,selector 只订自己的 id)。虚拟化卸载/重挂条目时展开状态不丢;`waiting_for_confirmation` 强制展开逻辑保留 |
| `src/features/agent/thread/ToolCallCard.tsx` | `open` 改读写外提 store;`ToolCallGroup` 的 key 由"全组 id join"改为首个 entry id(流式追加成员不再整组 remount) |
| `src/components/ui/card.tsx` | 删除 `backdrop-blur-xl`(零视觉影响,纯 GPU 开销) |
| `src/features/agent/thread/ThreadDiffBlock.tsx` | 延迟挂载:进入可视区先渲染占位(带 min-height),停留约 120ms 后再挂 CodeMirror;卸载早于计时器则不挂载。快速滚过成片 edit 卡时避免反复触发全文档 diff 计算 |
| `src/features/agent/thread/groupThreadEntries.ts` | `tool_group` key 改为首个 entry id |
| `src/stores/conversation.store.ts` / `src/features/projects/restoreProjectConversationTabs.ts` | 消息回退路径改 offset 分页循环取完(limit=50 逐页至返回不足一页) |

## 滚动行为

### 虚拟列表骨架

替换现有 `scroller > content(space-y-3) > map` 三层:

```
<div ref={scrollerRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto">
  <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
    {virtualizer.getVirtualItems().map((vi) => (
      <div
        key={rowKey(vi.index)}
        ref={virtualizer.measureElement}
        data-index={vi.index}
        style={{ position: "absolute", top: 0, left: 0, width: "100%",
                 transform: `translateY(${vi.start}px)` }}
        className="pb-3"          // 替代原 space-y-3,间距计入测量
      >
        {rowContent(vi.index)}    // ToolCallGroup / EntryView / 加载指示器
      </div>
    ))}
  </div>
</div>
```

### 虚拟列表配置

```ts
const virtualizer = useVirtualizer({
  count: renderItems.length + (showLoading ? 1 : 0),  // 加载指示器作为最后一行
  getScrollElement: () => scrollerRef.current,
  overscan: 5,                    // 上下各多渲染 5 行,缓冲 edit 卡 CM 挂载抖动
  estimateSize: (i) => estimateRowHeight(renderItems[i]),
});
```

`estimateRowHeight` 按条目类型估值:`tool_group` ≈ 40px、折叠工具卡 ≈ 48px、展开 edit 卡 ≈ 420px、消息 ≈ 96px。估值只影响滚动条精度,`measureElement` 实测持续校正。

### 贴底状态机

替换现有"ResizeObserver 监听 content + layout effect"方案:

| 触发 | 动作 |
|---|---|
| `onScroll` | 距底 ≤ 80px → `stickToBottomRef = true`,否则 `false`(沿用现有 `NEAR_BOTTOM_PX` 阈值) |
| `useLayoutEffect([count, totalSize])` | 跟随态 → `virtualizer.scrollToIndex(count - 1, { align: "end" })`。流式撑高末尾条目 → `measureElement` 的 ResizeObserver 更新 `totalSize` → effect 重跑 → 继续贴底 |
| 切 tab(`[activeTabId]`) | `stick = true` + `scrollToIndex(count - 1, { align: "end" })` |
| 检测到新的 user_message id | `stick = true` + 强制贴底(现有 `lastUserMsgIdRef` 逻辑原样迁移) |

### 边界情况

- **流式轻微跳动**:末尾未测量行先按估值定位,实测修正触发 `totalSize` 变化再跑一次贴底 effect,一个来回内收敛。react-virtual 聊天场景的已知行为,可接受
- **嵌套滚动容器**:ThinkingBlock(max-h 300px)、edit 卡内容区(max-h 350px)、DiffView(320px)均为封顶自滚,行高稳定可测,虚拟化不干预内部滚动
- **权限确认卡**:waiting 条目追加于末尾,跟随态自然带入视野;用户滚远后行卸载不影响——`respondPermission` 在 store 层,滚回重挂时 `waiting` effect 重新强制展开,行为与现状一致
- **展开状态**:外提 store 以 `toolCallId` 为键,卸载/重挂后还原;ToolCallGroup 首个 id 作 key,流式追加成员不再 remount
- **空会话**:保持现有空态分支,`count === 0` 时不进虚拟列表
- **快速滚过成片 edit 卡**:overscan 5 + ThreadDiffBlock 延迟挂载,滚过去的行计时器未触发即卸载,CodeMirror 实例不会被创建

## 实施顺序

每步独立可验证、可单独回滚:

1. **零行为变化铺垫**:`card.tsx` 移除 `backdrop-blur-xl`;EntryView 拆出并 memo 化;`groupChunks` / `groupThreadEntries` 记忆化;ThreadView 订阅收窄。此步单独上线即有明显收益且风险最低
2. **展开态外提 + key 修复**:`toolCardExpansion.ts`、ToolCallCard / ToolCallGroup 改造
3. **virtualizer 接入**:骨架替换、动态测量、贴底状态机改写
4. **ThreadDiffBlock 延迟挂载**
5. **收尾**:50 条分页修复;种子工具与性能验证;补测试

## 测试

### 测试基建

jsdom 无布局(`offsetHeight` 为 0、无 ResizeObserver),虚拟列表测试统一以基建解决:`ResizeObserver` 全局 stub + mock 滚动容器 `clientHeight / scrollHeight / getBoundingClientRect`,使 `useVirtualizer` 产出真实虚拟行;`initialRect` 选项留作备选。

### 单元测试(vitest)

| 对象 | 断言 |
|---|---|
| `groupThreadEntries` | 分组正确性;流式追加成员时首个 id 的 key 不变 |
| `groupChunks` | 相邻同类型合并正确;entries 引用不变时不重算 |
| `toolCardExpansion` store | 读写正确;未显式设置时回退 `isEdit \|\| waiting` 默认值 |
| immer 结构共享前提 | 更新会话 A 的 entries 后,`entriesByConversation[B]` 引用不变(订阅收窄的地基,必须钉死) |

### 组件测试(testing-library/react)

1. **窗口化生效**:灌 1000 条 entries,DOM 中行数 < 60(视口 + overscan)
2. **跟随贴底**:贴底态追加条目 → `scrollToIndex` 触发 / `scrollTop` 落底
3. **上滚取消跟随**:模拟 scroll 距底 > 80px → 追加条目 → 不跳底
4. **切 tab 重置**:切换后恢复跟随并到底
5. **串扰修复**:后台会话派发流式更新 → 前台 ThreadView 渲染计数不增加
6. **展开态跨重挂**:手动展开工具卡 → 模拟行卸载再挂载 → 仍为展开

### 性能验收(手动)

- 种子工具:向 store 注入合成数据——2000 条 entries 含约 300 张展开态 edit 卡,模拟目标规模;开发期临时入口,验证后删除或移入测试夹具
- 环境:`pnpm dev` 浏览器(Tauri 与浏览器跑同一份 React 代码,性能特征一致),DevTools Performance 面板前后对比
- 验收标准:
  - 线程容器 DOM 行数与消息总数解耦(2000 条时 < 60 行)
  - 快速滚动无 > 50ms 长任务,主观流畅
  - React Profiler 下流式时每 chunk 仅重渲染末尾一行
  - 同时挂载的 CodeMirror 实例数 ≤ 视口行 + overscan

### 回归清单(手动)

权限卡自动展开并可点、ThinkingBlock 内部滚动、edit 卡 diff 内容正确、空态、发新消息强制贴底、页签拖拽排序不受影响。

## 后续候选(不在本期)

- Rust 侧事件合批 / 前端 rAF 节流,进一步压流式频率
- 会话内消息搜索(替代被虚拟化限制的原生 Ctrl+F)
- FileTree / SearchPanel 等同构全量列表的虚拟化(同模式复用)
