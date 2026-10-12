import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

// Adapted from upstream inbox-zero b2ceb6645 (#2123) / 3438e6682 (#3919).
// fetch() would resolve the hostname again after validation (DNS rebinding)
// and follow redirects to anywhere, including the home LAN. This connects only
// to the addresses validateWebhookUrl already vetted, and node:http never
// follows redirects.
export function sendPinnedWebhookRequest({
  url,
  addresses,
  body,
  headers,
}: {
  url: string;
  addresses: string[];
  body: string;
  headers: Record<string, string>;
}): Promise<{ statusCode: number }> {
  const target = new URL(url);
  const pinned = addresses
    .map((address) => ({ address, family: isIP(address) }))
    .filter(
      (entry): entry is { address: string; family: 4 | 6 } =>
        entry.family === 4 || entry.family === 6,
    );
  if (pinned.length === 0) {
    return Promise.reject(new Error("No vetted address to connect to"));
  }

  const lookup = ((_hostname, options, callback) => {
    if (typeof options === "object" && options?.all) {
      callback(null, pinned);
      return;
    }
    callback(null, pinned[0].address, pinned[0].family);
  }) as LookupFunction;

  return new Promise((resolve, reject) => {
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      {
        method: "POST",
        lookup,
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (response) => {
        response.resume();
        response.on("error", reject);
        response.on("end", () =>
          resolve({ statusCode: response.statusCode ?? 0 }),
        );
      },
    );
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}
