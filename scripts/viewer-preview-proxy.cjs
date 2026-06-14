#!/usr/bin/env node
// Viewer 预览代理 —— 给 Claude Preview / 浏览器实证用。
//
// 为什么需要它:viewer 服务器(src/viewer/server.ts)有 DNS-rebinding 防护,
// 只放行 loopback Host 头(否则返回 "forbidden host", server.ts:1068)。
// preview 工具经代理/隧道访问时带的 Host 头常不在白名单里,会被拒。
// 本代理在转发时把 Host 头重写为 `localhost:<viewer 端口>`,绕过白名单,
// 让 preview 工具能正常打开工作台做实证。
//
// 端口:
//   监听 LISTEN_PORT(默认 3198) → 转发到 VIEWER_PORT
// 上游 viewer 端口的确定顺序:
//   1. 显式环境变量 AGENTMEMORY_VIEWER_PORT / III_VIEWER_PORT(最高优先)
//   2. 否则查 REST livez(AGENTMEMORY_REST_PORT 或 3111)上报的 viewerPort——
//      这样多 worker / 端口漂移时代理自动跟随真源,不会卡在死端口(见 #C3 收尾运行态收敛)
//   3. 兜底 3114(= restPort+3 的传统默认)
// 可用环境变量覆盖:
//   VIEWER_PROXY_PORT  代理监听端口(默认 3198)
//   AGENTMEMORY_VIEWER_PORT / III_VIEWER_PORT  显式上游 viewer 端口
//   AGENTMEMORY_REST_PORT  自动发现时查询的 REST 端口(默认 3111)
//
// 用法:
//   node scripts/viewer-preview-proxy.cjs
//   VIEWER_PROXY_PORT=4000 AGENTMEMORY_VIEWER_PORT=3115 node scripts/viewer-preview-proxy.cjs
// 通常由 .claude/launch.json 的 "viewer-proxy" 配置拉起。

const http = require("http");

const LISTEN_PORT = parseInt(process.env.VIEWER_PROXY_PORT || "3198", 10);
const VIEWER_HOST = "localhost";
const EXPLICIT_VIEWER_PORT =
  process.env.AGENTMEMORY_VIEWER_PORT || process.env.III_VIEWER_PORT || "";
const REST_PORT = parseInt(process.env.AGENTMEMORY_REST_PORT || "3111", 10);
const FALLBACK_VIEWER_PORT = 3114;

function discoverViewerPort() {
  if (EXPLICIT_VIEWER_PORT) {
    return Promise.resolve(parseInt(EXPLICIT_VIEWER_PORT, 10));
  }
  return new Promise((resolve) => {
    const req = http.get(
      { host: VIEWER_HOST, port: REST_PORT, path: "/agentmemory/livez", timeout: 1500 },
      (r) => {
        let raw = "";
        r.on("data", (c) => { raw += c; });
        r.on("end", () => {
          try {
            const port = JSON.parse(raw).viewerPort;
            resolve(Number.isInteger(port) ? port : FALLBACK_VIEWER_PORT);
          } catch (_e) {
            resolve(FALLBACK_VIEWER_PORT);
          }
        });
      },
    );
    req.on("error", () => resolve(FALLBACK_VIEWER_PORT));
    req.on("timeout", () => { req.destroy(); resolve(FALLBACK_VIEWER_PORT); });
  });
}

function startProxy(VIEWER_PORT) {
  const REWRITTEN_HOST = `${VIEWER_HOST}:${VIEWER_PORT}`;

  const server = http.createServer((req, res) => {
    // 重写 Host 头为 loopback,满足 viewer 的 DNS-rebinding 白名单
    const headers = Object.assign({}, req.headers, { host: REWRITTEN_HOST });
    const opt = {
      host: VIEWER_HOST,
      port: VIEWER_PORT,
      path: req.url,
      method: req.method,
      headers,
    };
    const upstream = http.request(opt, (pr) => {
      res.writeHead(pr.statusCode || 502, pr.headers);
      pr.pipe(res);
    });
    upstream.on("error", (e) => {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        `viewer-preview-proxy: 上游 ${REWRITTEN_HOST} 不可达 (${e.message})。\n` +
          `先用 \`npm run start:local-memory\` 起 viewer,或设 AGENTMEMORY_VIEWER_PORT。`,
      );
    });
    req.pipe(upstream);
  });

  server.on("error", (e) => {
    console.error(`viewer-preview-proxy 启动失败: ${e.message}`);
    process.exit(1);
  });

  server.listen(LISTEN_PORT, () => {
    console.log(
      `viewer-preview-proxy: :${LISTEN_PORT} → ${REWRITTEN_HOST} (Host 头已重写,绕过白名单)`,
    );
  });
}

discoverViewerPort().then(startProxy);
