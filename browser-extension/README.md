# Agent Memory Lab 浏览器插件

这是 Agent Memory Lab 的浏览器插件 MVP，用来把网页上下文保存到本地记忆工作台。

## 现在支持

- 检查本地 Agent Memory Lab 服务是否在线
- 保存当前网页为记忆线索
- 把当前网页上的一条观察保存为经验
- 一键打开本地工作台首页
- 一键打开 Skill 管理台
- 支持自定义 API 地址、Viewer 地址和访问密钥

## 本地预览

1. 打开 Chrome / Edge：`chrome://extensions`
2. 打开“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本目录：`browser-extension`
5. 确保本地服务已启动：`agentmemory viewer`
6. 点击浏览器工具栏里的 Agent Memory Lab 图标

默认连接：

```text
API: http://localhost:3111
Viewer: http://localhost:3113
```

## 还缺什么

- 页面右键菜单：保存选中文本为记忆
- 网页侧边栏：边浏览边整理
- 自动识别论文、GitHub、飞书、Notion 等页面类型
- 保存前隐私预览
- 与 Viewer 的“待审阅记忆”队列联动
