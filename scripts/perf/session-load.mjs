#!/usr/bin/env node
// [perf-loop] "打开大会话"反馈回路 v2
// - 手机仿真：视口+触控+CPU 降速（默认 4x）
// - 统计 REST + WebSocket 字节
// - 容忍页面 reload（PWA SW 接管），以"消息数稳定"为终点
//
// 退出码: 0 = GREEN（稳定耗时 <= budget），1 = RED
import { chromium } from "playwright";

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

const base = arg("--url", "http://127.0.0.1:8600");
const project = arg("--project", "3023f957-b595-46fa-b106-80ed05bd9f3d");
const session = arg("--session", "01a04b4c-c648-7b43-ba37-a32048f37898");
const cpuRate = Number(arg("--cpu", "4"));
const budgetMs = Number(arg("--budget-ms", "20000"));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
const netKbps = Number(arg("--net-kbps", "4096")); // 默认 4Mbps，模拟较好 4G；--net-kbps 0 关闭
if (netKbps > 0) {
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 100,
    downloadThroughput: netKbps * 125,
    uploadThroughput: netKbps * 125,
  });
}

// REST 字节
const apiBytes = new Map();
page.on("response", async (resp) => {
  const url = resp.url();
  if (url.includes("/api/")) {
    const len = Number(resp.headers()["content-length"] ?? 0);
    if (len > 0) {
      const key = (url.startsWith(base) ? url.slice(base.length) : url).replace(/\?.*$/, "");
      apiBytes.set(key, (apiBytes.get(key) ?? 0) + len);
    }
  }
});

// WebSocket 帧字节
let wsRxBytes = 0;
let wsUrl = "";
page.on("websocket", (ws) => {
  wsUrl = ws.url().replace(base, "");
  ws.on("framereceived", (data) => {
    wsRxBytes += typeof data.payload === "string" ? data.payload.length : data.payload?.length ?? 0;
  });
});

let navigations = 0;
page.on("framenavigated", (f) => {
  if (f === page.mainFrame()) navigations++;
});

const t0 = Date.now();
await page.goto(`${base}/?project=${project}&session=${session}`, { waitUntil: "commit", timeout: 120000 });

// 轮询到"稳定"：消息数 > 0 且连续 3 秒不变；期间容忍 reload
let firstMsgMs = null;
let lastCount = -1;
let lastChangeAt = Date.now();
let stable = false;
const deadline = Date.now() + (netKbps > 0 ? 300000 : 120000);
while (Date.now() < deadline) {
  const count = await page
    .locator(".chat .msg").count()
    .catch(() => -1); // 导航期间会失败，算作 -1 继续等
  const now = Date.now();
  if (count > 0) {
    if (firstMsgMs === null) firstMsgMs = now - t0;
    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = now;
    } else if (now - lastChangeAt >= 3000) {
      stable = true;
      break;
    }
  }
  await page.waitForTimeout(300);
}
const stableMs = Date.now() - t0;

const metrics = await page
  .evaluate(() => ({
    domNodes: document.getElementsByTagName("*").length,
    longTasks: window.__longTasks ?? [],
  }))
  .catch(() => ({ domNodes: -1, longTasks: [] }));
const msgCount = await page.locator(".chat .msg").count().catch(() => -1);

const result = {
  firstMsgMs,
  stableMs,
  stable,
  reloads: navigations - 1,
  msgs: msgCount,
  domNodes: metrics.domNodes,
  longTaskCount: metrics.longTasks.length,
  longTaskTotalMs: Math.round(metrics.longTasks.reduce((a, b) => a + b, 0)),
  wsUrl,
  wsRxKB: Math.round(wsRxBytes / 1024),
  restKB: Math.round([...apiBytes.values()].reduce((a, b) => a + b, 0) / 1024),
  topRest: Object.fromEntries([...apiBytes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => [k, Math.round(v / 1024) + "KB"])),
  cpuThrottle: cpuRate,
};
console.log(JSON.stringify(result, null, 2));

await browser.close();
if (!stable || stableMs > budgetMs) {
  console.error(`RED: stable=${stable} stableMs=${stableMs} > budget ${budgetMs}ms`);
  process.exit(1);
}
console.log(`GREEN: stable ${stableMs}ms <= budget ${budgetMs}ms`);
