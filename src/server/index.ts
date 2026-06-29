import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export function createAppServer() {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      writeJson(res, 200, { ok: true });
      return;
    }

    writeJson(res, 404, { error: "not_found" });
  });
}

function writeJson(res: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
