import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { MachineClient } from "./machineClient.js";
import { registerMachineProxyRoutes } from "./machineProxyRoutes.js";

const machineId = "remote /?";
const sessionId = "session /?";
const cwd = "/repo with spaces";
const mediaId = "a".repeat(64);
const mediaBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe("remote session media federation", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("qualifies projected media for the selected machine and proxies the returned raw path", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const query = new URLSearchParams({ cwd }).toString();
    const encodedSessionId = encodeURIComponent(sessionId);
    const localMediaPath = `api/machines/local/sessions/${encodedSessionId}/media/${mediaId}?${query}`;
    const messagePage = {
      messages: [
        {
          role: "toolResult",
          content: [
            {
              type: "image",
              mimeType: "image/png",
              src: localMediaPath,
              byteSize: mediaBytes.byteLength,
            },
          ],
        },
      ],
      start: 0,
      total: 1,
    };
    const remoteRequests: { method: string; path: string }[] = [];
    const client: MachineClient = {
      request(method, path) {
        remoteRequests.push({ method, path });
        if (path.includes("/messages?")) {
          return Promise.resolve({
            statusCode: 200,
            headers: { "content-type": "application/json" },
            body: Readable.from([JSON.stringify(messagePage)]),
          });
        }
        if (path.includes("/media/")) {
          return Promise.resolve({
            statusCode: 200,
            headers: {
              "content-type": "image/png",
              "cache-control": "private, max-age=31536000, immutable",
              "content-length": String(mediaBytes.byteLength),
            },
            body: Readable.from([mediaBytes]),
          });
        }
        throw new Error(`Unexpected remote request: ${method} ${path}`);
      },
      requestJson(method, path) {
        remoteRequests.push({ method, path });
        if (!path.includes("/messages?"))
          throw new Error(`Unexpected remote JSON request: ${method} ${path}`);
        return Promise.resolve({
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: messagePage,
        });
      },
      connectWebSocket() {
        throw new Error("WebSocket not expected");
      },
    };
    registerMachineProxyRoutes(app, {
      remoteClient: (requestedMachineId) =>
        Promise.resolve(requestedMachineId === machineId ? client : undefined),
    });

    const machinePrefix = `/api/machines/${encodeURIComponent(machineId)}`;
    const messagesPath = `${machinePrefix}/sessions/${encodedSessionId}/messages?${query}`;
    const messages = await app.inject({ method: "GET", url: messagesPath });
    const expectedMediaPath = `api/machines/${encodeURIComponent(machineId)}/sessions/${encodedSessionId}/media/${mediaId}?${query}`;
    const projectedSrc: unknown = messages.json<{
      messages: { content: { src: unknown }[] }[];
    }>().messages[0]?.content[0]?.src;
    const media = await app.inject({
      method: "GET",
      url: `/${expectedMediaPath}`,
    });

    expect.soft(messages.statusCode).toBe(200);
    expect.soft(projectedSrc).toBe(expectedMediaPath);
    expect.soft(media.statusCode).toBe(200);
    expect.soft(media.headers["content-type"]).toBe("image/png");
    expect
      .soft(media.headers["cache-control"])
      .toBe("private, max-age=31536000, immutable");
    expect.soft(media.rawPayload).toEqual(mediaBytes);
    expect(remoteRequests).toEqual([
      {
        method: "GET",
        path: `/api/sessions/${encodedSessionId}/messages?${query}`,
      },
      {
        method: "GET",
        path: `/api/sessions/${encodedSessionId}/media/${mediaId}?${query}`,
      },
    ]);
  });
});
