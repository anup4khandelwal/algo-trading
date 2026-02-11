import http from "node:http";
import { createHash } from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const PORT = 8000;

function checksum(apiKey: string, requestToken: string, apiSecret: string): string {
  const raw = `${apiKey}${requestToken}${apiSecret}`;
  return createHash("sha256").update(raw).digest("hex");
}

async function exchangeToken(requestToken: string) {
  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error("KITE_API_KEY and KITE_API_SECRET must be set in env");
  }

  const form = new URLSearchParams({
    api_key: apiKey,
    request_token: requestToken,
    checksum: checksum(apiKey, requestToken, apiSecret)
  });

  const res = await fetch("https://api.kite.trade/session/token", {
    method: "POST",
    headers: { "X-Kite-Version": "3" },
    body: form
  });

  const json = (await res.json()) as {
    status: string;
    data?: { access_token: string };
    message?: string;
  };

  if (!res.ok || json.status !== "success" || !json.data?.access_token) {
    throw new Error(`Token exchange failed: ${res.status} ${json.message ?? ""}`);
  }

  return json.data.access_token;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname !== "/kite/callback") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }

    const requestToken = url.searchParams.get("request_token");
    if (!requestToken) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing request_token");
      return;
    }

    const accessToken = await exchangeToken(requestToken);

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<h3>Access token generated</h3><p>Copy it from the terminal logs.</p>`
    );

    console.log("KITE_ACCESS_TOKEN=", accessToken);
    await updateEnvFile(accessToken);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Error generating access token. Check server logs.");
    console.error(err);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Kite callback server listening on http://127.0.0.1:${PORT}/kite/callback`);
});

async function updateEnvFile(accessToken: string) {
  const fs = await import("node:fs/promises");
  const path = ".env";
  let content = "";
  try {
    content = await fs.readFile(path, "utf-8");
  } catch {
    content = "";
  }

  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  const createdAt = new Date().toISOString();
  const filtered = lines.filter(
    (l) =>
      !l.startsWith("KITE_ACCESS_TOKEN=") &&
      !l.startsWith("KITE_ACCESS_TOKEN_CREATED_AT=")
  );
  filtered.push(`KITE_ACCESS_TOKEN=${accessToken}`);
  filtered.push(`KITE_ACCESS_TOKEN_CREATED_AT=${createdAt}`);
  await fs.writeFile(path, filtered.join("\n") + "\n");
}
