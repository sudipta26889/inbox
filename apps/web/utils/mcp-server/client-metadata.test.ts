import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { SafeError } from "@/utils/error";
import { resolveClientMetadata } from "./client-metadata";

const { lookupMock, requestMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  requestMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));
vi.mock("node:https", () => ({ default: { request: requestMock } }));

const URL_ID = "https://app.example.com/oauth/client.json";
const REDIRECT = "https://app.example.com/callback";
const PUBLIC_V4 = [{ address: "93.184.216.34", family: 4 }];

describe("resolveClientMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.mcpServerClient.findUnique.mockResolvedValue(null);
    prisma.mcpServerClient.upsert.mockImplementation((async (args: any) => ({
      clientId: URL_ID,
      ...args.create,
    })) as any);
    lookupMock.mockResolvedValue(PUBLIC_V4);
    serve({ document: goodDocument() });
  });

  describe("refused URLs", () => {
    it.each([
      ["a non-https URL", "http://app.example.com/client.json"],
      ["port 8443", "https://app.example.com:8443/client.json"],
      ["userinfo", "https://user:pass@app.example.com/client.json"],
      ["a fragment", "https://app.example.com/client.json#x"],
      ["something that is not a URL", "https://"],
    ])("refuses %s without resolving or fetching", async (_name, url) => {
      await expect(resolveClientMetadata(url, REDIRECT)).rejects.toThrow(
        SafeError,
      );
      expect(lookupMock).not.toHaveBeenCalled();
      expect(requestMock).not.toHaveBeenCalled();
    });

    it("accepts the default port spelled out", async () => {
      await expect(
        resolveClientMetadata(
          "https://app.example.com:443/client.json",
          REDIRECT,
        ),
      ).rejects.toThrow(/does not match/);
    });
  });

  describe("refused addresses", () => {
    it.each([
      ["0/8", "0.1.2.3", 4],
      ["10/8", "10.0.0.1", 4],
      ["100.64/10", "100.64.0.1", 4],
      ["127/8", "127.0.0.1", 4],
      ["169.254/16", "169.254.169.254", 4],
      ["172.16/12", "172.16.0.1", 4],
      ["192.168/16", "192.168.1.1", 4],
      ["224/4", "224.0.0.1", 4],
      ["240/4", "240.0.0.1", 4],
      ["broadcast", "255.255.255.255", 4],
      ["::", "::", 6],
      ["::1", "::1", 6],
      ["fc00::/7", "fd12:3456::1", 6],
      ["fe80::/10", "fe80::1", 6],
      ["ff00::/8", "ff02::1", 6],
      ["IPv4-mapped private", "::ffff:10.0.0.1", 6],
      ["IPv4-mapped public", "::ffff:8.8.8.8", 6],
    ])("refuses %s (%s)", async (_name, address, family) => {
      lookupMock.mockResolvedValue([{ address, family }]);

      await expect(resolveClientMetadata(URL_ID, REDIRECT)).rejects.toThrow(
        SafeError,
      );
      expect(requestMock).not.toHaveBeenCalled();
    });

    it("refuses a host that resolves to one public and one private address", async () => {
      lookupMock.mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]);

      await expect(resolveClientMetadata(URL_ID, REDIRECT)).rejects.toThrow(
        SafeError,
      );
      expect(requestMock).not.toHaveBeenCalled();
    });

    it("refuses a host that does not resolve", async () => {
      lookupMock.mockRejectedValue(new Error("ENOTFOUND"));

      await expect(resolveClientMetadata(URL_ID, REDIRECT)).rejects.toThrow(
        SafeError,
      );
    });

    it("allows public IPv4 and IPv6 addresses", async () => {
      for (const found of [
        PUBLIC_V4,
        [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }],
      ]) {
        lookupMock.mockResolvedValue(found);
        await expect(
          resolveClientMetadata(URL_ID, REDIRECT),
        ).resolves.toBeTruthy();
      }
    });
  });

  describe("the connection", () => {
    it("is pinned to the checked address, never resolving the name again", async () => {
      await resolveClientMetadata(URL_ID, REDIRECT);

      const [url, options] = requestMock.mock.calls[0];
      expect(url).toBe(URL_ID);
      expect(options.headers.Accept).toBe("application/json");
      expect(options.timeout).toBe(5000);

      const single = vi.fn();
      options.lookup("app.example.com", {}, single);
      expect(single).toHaveBeenCalledWith(null, "93.184.216.34", 4);

      const all = vi.fn();
      options.lookup("app.example.com", { all: true }, all);
      expect(all).toHaveBeenCalledWith(null, [
        { address: "93.184.216.34", family: 4 },
      ]);
    });
  });

  describe("fetch failures", () => {
    it.each([
      301, 302, 307, 404, 500,
    ])("refuses a %s response and never follows it", async (status) => {
      serve({ status });

      await expect(resolveClientMetadata(URL_ID, REDIRECT)).rejects.toThrow(
        SafeError,
      );
      expect(requestMock).toHaveBeenCalledTimes(1);
      expect(prisma.mcpServerClient.upsert).not.toHaveBeenCalled();
    });

    it("refuses a body over 64 KB and stops reading it", async () => {
      serve({
        chunks: [Buffer.alloc(40 * 1024, 0x20), Buffer.alloc(40 * 1024, 0x20)],
      });

      await expect(resolveClientMetadata(URL_ID, REDIRECT)).rejects.toThrow(
        SafeError,
      );
      expect(lastRequest.destroy).toHaveBeenCalled();
      expect(prisma.mcpServerClient.upsert).not.toHaveBeenCalled();
    });

    it("refuses a request that times out and destroys it", async () => {
      serve({ timeout: true });

      await expect(resolveClientMetadata(URL_ID, REDIRECT)).rejects.toThrow(
        SafeError,
      );
      expect(lastRequest.destroy).toHaveBeenCalled();
    });

    it("refuses a body that is not JSON", async () => {
      serve({ chunks: [Buffer.from("<html>")] });

      await expect(resolveClientMetadata(URL_ID, REDIRECT)).rejects.toThrow(
        SafeError,
      );
    });
  });

  describe("document checks", () => {
    it("refuses a client_id that is not the URL", async () => {
      serve({ document: { ...goodDocument(), client_id: "https://evil/x" } });

      await expect(resolveClientMetadata(URL_ID, REDIRECT)).rejects.toThrow(
        /client_id/,
      );
    });

    it.each([
      [[]],
      [undefined],
      ["https://app.example.com/cb"],
    ])("refuses redirect_uris of %j", async (redirectUris) => {
      serve({ document: { ...goodDocument(), redirect_uris: redirectUris } });

      await expect(resolveClientMetadata(URL_ID, REDIRECT)).rejects.toThrow(
        SafeError,
      );
    });

    it("refuses a redirect_uri entry that fails validation", async () => {
      serve({
        document: {
          ...goodDocument(),
          redirect_uris: [REDIRECT, "ftp://app.example.com/cb"],
        },
      });

      await expect(resolveClientMetadata(URL_ID, REDIRECT)).rejects.toThrow(
        SafeError,
      );
    });

    it("refuses a requested redirect that the document does not list", async () => {
      await expect(
        resolveClientMetadata(URL_ID, "https://app.example.com/other"),
      ).rejects.toThrow(/not listed/);
      expect(prisma.mcpServerClient.upsert).not.toHaveBeenCalled();
    });

    it("refuses client_secret_post", async () => {
      serve({
        document: {
          ...goodDocument(),
          token_endpoint_auth_method: "client_secret_post",
        },
      });

      await expect(resolveClientMetadata(URL_ID, REDIRECT)).rejects.toThrow(
        /public clients/,
      );
      expect(prisma.mcpServerClient.upsert).not.toHaveBeenCalled();
    });

    it("accepts auth method none", async () => {
      serve({
        document: { ...goodDocument(), token_endpoint_auth_method: "none" },
      });

      await expect(
        resolveClientMetadata(URL_ID, REDIRECT),
      ).resolves.toBeTruthy();
    });
  });

  describe("success", () => {
    it("upserts the client from a good document", async () => {
      await resolveClientMetadata(URL_ID, REDIRECT);

      expect(prisma.mcpServerClient.upsert).toHaveBeenCalledWith({
        where: { clientId: URL_ID },
        create: {
          clientId: URL_ID,
          type: "MCP",
          clientName: "Example App",
          redirectUris: [REDIRECT],
          logoUri: "https://app.example.com/logo.png",
          tokenEndpointAuthMethod: "none",
        },
        update: {
          clientName: "Example App",
          redirectUris: [REDIRECT],
          logoUri: "https://app.example.com/logo.png",
          tokenEndpointAuthMethod: "none",
        },
      });
    });

    it("falls back to the host when the document has no name, and drops a non-https logo", async () => {
      serve({
        document: {
          ...goodDocument(),
          client_name: undefined,
          logo_uri: "javascript:alert(1)",
        },
      });

      await resolveClientMetadata(URL_ID, REDIRECT);

      expect(prisma.mcpServerClient.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            clientName: "app.example.com",
            logoUri: null,
          }),
        }),
      );
    });

    it("does not fetch again for a row younger than 24 hours", async () => {
      const row = existingRow(60 * 60 * 1000);
      prisma.mcpServerClient.findUnique.mockResolvedValue(row as any);

      await expect(resolveClientMetadata(URL_ID, REDIRECT)).resolves.toBe(row);
      expect(lookupMock).not.toHaveBeenCalled();
      expect(requestMock).not.toHaveBeenCalled();
    });

    it("fetches again once the row is older than 24 hours", async () => {
      prisma.mcpServerClient.findUnique.mockResolvedValue(
        existingRow(25 * 60 * 60 * 1000) as any,
      );

      await resolveClientMetadata(URL_ID, REDIRECT);

      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("fetches again when a fresh row does not list the requested redirect", async () => {
      prisma.mcpServerClient.findUnique.mockResolvedValue(
        existingRow(1000, ["https://app.example.com/old"]) as any,
      );

      await resolveClientMetadata(URL_ID, REDIRECT);

      expect(requestMock).toHaveBeenCalledTimes(1);
    });
  });
});

function goodDocument() {
  return {
    client_id: URL_ID,
    client_name: "Example App",
    redirect_uris: [REDIRECT],
    logo_uri: "https://app.example.com/logo.png",
  };
}

function existingRow(ageMs: number, redirectUris = [REDIRECT]) {
  return {
    clientId: URL_ID,
    clientName: "Example App",
    redirectUris,
    updatedAt: new Date(Date.now() - ageMs),
  };
}

let lastRequest: EventEmitter & { destroy: ReturnType<typeof vi.fn> };

function serve(behavior: {
  status?: number;
  document?: unknown;
  chunks?: Buffer[];
  timeout?: boolean;
}) {
  requestMock.mockImplementation((_url, _options, callback) => {
    const request = new EventEmitter() as typeof lastRequest &
      Record<string, unknown>;
    request.destroy = vi.fn((error?: Error) => {
      if (error) request.emit("error", error);
    });
    request.end = () => {
      queueMicrotask(() => {
        if (behavior.timeout) {
          request.emit("timeout");
          return;
        }
        const response = new EventEmitter() as EventEmitter &
          Record<string, unknown>;
        response.statusCode = behavior.status ?? 200;
        response.resume = vi.fn();
        callback(response);
        const chunks =
          behavior.chunks ??
          (behavior.document === undefined
            ? []
            : [Buffer.from(JSON.stringify(behavior.document))]);
        for (const chunk of chunks) response.emit("data", chunk);
        response.emit("end");
      });
    };
    lastRequest = request;
    return request;
  });
}
