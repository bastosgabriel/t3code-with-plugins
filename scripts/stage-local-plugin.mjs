import * as NodeFSP from "node:fs/promises";

const { token, directory, port } = JSON.parse(await NodeFSP.readFile("/dev/stdin", "utf8"));
const origin = `http://127.0.0.1:${port}`;
const response = await fetch(`${origin}/api/auth/websocket-ticket/rpc`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10000),
});
if (!response.ok)
  throw new Error(`Local authentication failed (${response.status}). Keep the fork app open.`);
const { ticket } = await response.json();
const url = new URL(`${origin.replace("http:", "ws:")}/ws`);
url.searchParams.set("orchestrationProtocol", "2");
url.searchParams.set("wsTicket", ticket);
const socket = new WebSocket(url);
let sequence = 0;
const pending = new Map();
const closed = () => {
  for (const { reject } of pending.values())
    reject(new Error("Connection lost; inspect Plugins settings before retrying installation."));
  pending.clear();
};
socket.addEventListener("close", closed);
socket.addEventListener("error", closed);
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(String(data));
  for (const item of Array.isArray(message) ? message : [message]) {
    if (item._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
    if (item._tag !== "Exit") continue;
    const request = pending.get(String(item.requestId));
    if (!request) continue;
    pending.delete(String(item.requestId));
    if (item.exit._tag === "Success") request.resolve(item.exit.value);
    else
      request.reject(
        new Error("Plugin operation failed; inspect Plugins settings before retrying."),
      );
  }
});
function rpc(tag, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = String(++sequence);
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
  });
}
const timeout = setTimeout(() => {
  closed();
  socket.close();
}, 20000);
try {
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Cannot connect to the running local fork.")),
      { once: true },
    );
    socket.addEventListener("close", () => reject(new Error("Connection closed before opening.")), {
      once: true,
    });
  });
  const before = await rpc("plugins.list");
  if (!before.some((plugin) => plugin.manifest.id === "obsidian-tickets" && plugin.enabled)) {
    throw new Error("Expected the existing enabled Obsidian tickets plugin; left unchanged.");
  }
  await rpc("plugins.manage", { action: "install", directory });
  const after = await rpc("plugins.list");
  if (
    !after.some(
      (plugin) => plugin.manifest.id === "obsidian-tickets" && plugin.pendingVersion !== null,
    )
  ) {
    throw new Error("Plugin staging was not confirmed; inspect Plugins settings before retrying.");
  }
  console.log("Plugin update staged through the running server; activation awaits restart.");
} finally {
  clearTimeout(timeout);
  socket.close();
}
