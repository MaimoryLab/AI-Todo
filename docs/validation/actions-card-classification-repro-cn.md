# 待办页卡片分类显示复现流程

本文用于复现 Viewer `#actions` 待办页的卡片分类展示，重点验证 `inbox` 已回应结果能在网页端看到。

## 前置条件

在仓库根目录运行：

```bash
npm run build
npm run start:local-memory
```

新开终端确认工作台状态：

```bash
npm run check:workbench
```

以自检输出的 Viewer 地址为准。常见地址是：

```text
http://127.0.0.1:3115/#actions
```

如果端口不是 `3115`，使用 `npm run check:workbench` 输出的 Viewer 端口。

## 构造已回应数据

创建一条 Agent question：

```bash
created=$(curl -s -X POST http://127.0.0.1:3111/agentmemory/inbox/ask \
  -H 'Content-Type: application/json' \
  -d '{"body":"分类显示验证：这条已回应应出现在已回应归档。","fromAgent":"classification-check"}')

id=$(printf '%s' "$created" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{let j=JSON.parse(s); console.log(j.item && j.item.id || j.id || "")})')
```

把这条 question 标记为已回应：

```bash
curl -s -X POST http://127.0.0.1:3111/agentmemory/inbox/answer \
  -H 'Content-Type: application/json' \
  -d "{\"id\":\"$id\",\"answer\":\"auto-ok\"}"
```

## 网页端检查

打开待办页：

```text
http://127.0.0.1:3115/#actions
```

检查点：

- 顶部指标显示 `待回应 / 待确认 / 待跟进 / 进行中 / 已完成`。
- 页面出现 `已回应 1 条` 的折叠入口。
- 展开 `已回应` 后，可以看到来源 `classification-check`。
- 展开内容包含原 question 文案。
- 展开内容包含 `你已回复：auto-ok`。

## 预期结果

`answered` 状态的 inbox question 不再从网页端消失，而是进入只读归档区。用户可以在待办页看到自己已经回复了什么，briefing 的已读或 dismissed 项进入 `已知悉`，不再伪装成待办。
