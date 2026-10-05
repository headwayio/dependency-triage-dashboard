"use strict";

// config.allowedHosts — trusting a hostname like localhost, for `tailscale serve`.
//
// The guarded routes reject any Host or Origin that isn't loopback (DNS rebinding and
// CSRF). allowedHosts lets a reverse-proxy name through both checks, and nothing else.
// /api/open-urls is the probe: with an empty list it answers 400 once the guard passes,
// so 400 means "allowed" and 403 means "rejected" without opening anything.

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { startServer } = require("./helpers/harness");

const TAILNET = "omarchy.example.ts.net";

/** POST with explicit Host/Origin headers, which fetch() won't let us set. */
function probe(server, { host, origin }) {
  const { port } = new URL(server.url);
  const body = JSON.stringify({ urls: [] });
  const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Host: host };
  if (origin) headers.Origin = origin;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/open-urls", method: "POST", headers }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, error: JSON.parse(text).error }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function serve(t, config) {
  const server = await startServer({ config });
  t.after(() => server.stop());
  return server;
}

test("loopback is still trusted with no allowedHosts", async (t) => {
  const server = await serve(t, {});
  assert.equal((await probe(server, { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" })).status, 400);
});

test("a hostname that isn't allowed is rejected", async (t) => {
  const server = await serve(t, {});
  const res = await probe(server, { host: TAILNET });
  assert.equal(res.status, 403);
  assert.equal(res.error, "non-local host");
});

test("an allowed hostname passes both the Host and Origin checks", async (t) => {
  const server = await serve(t, { allowedHosts: [TAILNET] });
  assert.equal((await probe(server, { host: TAILNET, origin: `https://${TAILNET}` })).status, 400);
  assert.equal((await probe(server, { host: TAILNET.toUpperCase() })).status, 400, "hostnames are case-insensitive");
});

test("an allowed Host doesn't let another site's Origin through", async (t) => {
  const server = await serve(t, { allowedHosts: [TAILNET] });
  const res = await probe(server, { host: TAILNET, origin: "https://evil.example" });
  assert.equal(res.status, 403);
  assert.equal(res.error, "cross-origin request rejected");
});

test("a string allowedHosts is ignored, not substring-matched", async (t) => {
  const server = await serve(t, { allowedHosts: `x.${TAILNET}` });
  assert.equal((await probe(server, { host: TAILNET })).status, 403);
});
