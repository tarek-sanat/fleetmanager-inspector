/**
 * Headless DOM test for the FleetManager Batch Inspector front end.
 *
 * Boots index.html in jsdom, stubs fetch, then exercises the parts most likely to
 * regress: virtual scrolling, the tag/queue filters, the JSON highlighter, base64
 * decoding, keyboard navigation and config persistence.
 *
 *     node tests/ui_test.js
 *
 * Requires jsdom (npm install jsdom).
 */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.dirname(__dirname);
const results = [];
let failures = 0;

function check(label, condition, detail) {
  if (!condition) failures++;
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}${condition || !detail ? "" : "  -> " + detail}`);
  results.push([label, condition]);
}

// ── Fake FleetManager data ───────────────────────────────────────────────────
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const N = 5000;
const ids = Array.from({ length: N }, (_, i) => `msg-${String(i).padStart(5, "0")}`);
const details = {};
ids.forEach((id, i) => {
  details[id] = {
    id,
    // Group 100 ids per minute so time ordering is deterministic and unique.
    time: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 100), i % 100)).toISOString(),
    sourceQueue: i % 3 === 0 ? "orders" : i % 3 === 1 ? "billing" : "shipping",
    body: b64(JSON.stringify({ orderId: i, status: "failed", note: "caf\u00e9 \u2603" })),
    exception: i % 10 === 0 ? "System.Exception: boom" : null,
    headers: { "rbs2-msg-id": id, "content-type": "application/json" },
    active: true,
    machineName: "vm-01",
    tags: i % 50 === 0 ? ["urgent"] : [],
  };
});

async function main() {
  const html = fs.readFileSync(path.join(ROOT, "static", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(ROOT, "static", "app.js"), "utf8");

  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "http://localhost:8080/",
  });
  const { window } = dom;
  const document = window.document;

  window.navigator.clipboard = { writeText: async () => {} };
  window.TextDecoder = global.TextDecoder;
  window.atob = (s) => Buffer.from(s, "base64").toString("binary");

  // jsdom's own localStorage is real and writable — use it rather than replacing
  // the accessor (assigning to window.localStorage silently does nothing).
  const storage = window.localStorage;
  storage.clear();

  // jsdom has no layout engine: stub clientHeight so the virtual scroller sees a
  // realistic viewport. Without this every row counts as "visible".
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.id === "listContainer" ? 600 : 0;
    },
  });

  function mkResp(status, obj) {
    return { ok: status >= 200 && status < 300, status, json: async () => obj };
  }

  window.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/ping")) return mkResp(200, { active: N, archived: 0 });
    if (u.includes("/api/active")) return mkResp(200, { ids });
    if (u.includes("/api/batch-details")) {
      const batchIds = decodeURIComponent(u.split("ids=")[1].split("&")[0]).split(",");
      const out = {};
      batchIds.forEach((id) => (out[id] = details[id]));
      return mkResp(200, { results: out, errors: [], total: batchIds.length, fetched: batchIds.length });
    }
    return mkResp(404, { error: "not found" });
  };

  window.eval(appJs);
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  const app = window.app;
  check("app boots", !!app);

  // ── Load data ──────────────────────────────────────────────────────────────
  document.getElementById("cfgAccountId").value = "acct";
  document.getElementById("cfgToken").value = "tok";
  app._readConfigFromUI();
  await app.fetchMessages();

  check(`loaded ${N} messages`, app.messages.length === N, `got ${app.messages.length}`);
  check("no error rows injected", app.messages.every((m) => !m.isError));

  // ── Non-ASCII body survives base64 decoding ────────────────────────────────
  const body0 = JSON.parse(app.messages.find((m) => m.id === "msg-00000").body);
  check("utf-8 body decoded (café ☃)", body0.note === "caf\u00e9 \u2603", JSON.stringify(body0.note));

  // ── Virtual scroller ───────────────────────────────────────────────────────
  const vp = document.getElementById("listViewport");
  check("viewport height reflects full list", vp.style.height === `${N * 30}px`, vp.style.height);
  const rendered = app.pool.filter((r) => r.style.display !== "none").length;
  check("only a window of rows rendered", rendered > 0 && rendered < 100, `rendered=${rendered}`);

  // Scroll; the pool should be reused rather than grown without bound.
  app.r.listContainer.scrollTop = 30000;
  app._onScroll();
  const poolAfter = app.pool.length;
  check("window advanced after scroll", app.renderStart > 0, `start=${app.renderStart}`);
  check("render window stayed bounded", poolAfter < 100, `pool=${poolAfter}`);
  app.r.listContainer.scrollTop = 0;
  app._onScroll();
  check("pool reused on scroll back", app.pool.length === poolAfter, `${poolAfter} -> ${app.pool.length}`);

  // ── Filters: queue ─────────────────────────────────────────────────────────
  document.getElementById("searchInput").value = "";
  document.getElementById("sortSelect").value = "time-desc";
  app._applyFilters();
  const firstSorted = app.filtered[0].id;
  check("time-desc sorts newest first", firstSorted === "msg-04999", firstSorted);

  app.r.filterQueue.dataset.filter = "orders";
  app._applyFilters();
  check(
    "queue filter applied",
    app.filtered.length > 0 && app.filtered.every((m) => m.queue === "orders"),
    `n=${app.filtered.length}`
  );

  // ── Filters: tags (the previously dead feature) ────────────────────────────
  app.r.filterQueue.dataset.filter = "all";
  app._cycleTagFilter();
  check("tag filter cycles to 'tagged'", app.r.filterTags.dataset.filter === "tagged");
  check(
    "tag filter now filters",
    app.filtered.length > 0 && app.filtered.every((m) => m.tags.length > 0),
    `n=${app.filtered.length} of ${N}`
  );
  check("tag filter reduces the set", app.filtered.length === N / 50, `n=${app.filtered.length}`);
  check("filter button shows active state", app.r.filterTags.classList.contains("active"));
  app._cycleTagFilter();
  check("tag filter cycles back to 'all'", app.filtered.length === N, `n=${app.filtered.length}`);

  // ── Search, including exception text ──────────────────────────────────────
  document.getElementById("searchInput").value = "boom";
  app._applyFilters();
  check(
    "search matches exception text",
    app.filtered.length > 0 && app.filtered.every((m) => (m.exception || "").includes("boom")),
    `n=${app.filtered.length}`
  );
  document.getElementById("searchInput").value = "";

  // ── JSON highlighter: array values must not be highlighted as keys ─────────
  // highlightJSON is module-private, so re-evaluate just that slice of the source.
  const hlSrc = appJs.slice(appJs.indexOf("function escapeHtml"), appJs.indexOf("// ─── Toast system"));
  window.eval(hlSrc + "\nwindow.__hl = highlightJSON;");
  const hl = window.__hl;
  check("highlighter: array of strings is not keys", !hl('["x","y"]').includes("json-key"));
  check("highlighter: object key detected", hl('{"a":1}').includes("json-key"));
  check("highlighter: key inside array-of-objects", hl('[{"a":1},{"b":2}]').includes("json-key"));
  check("highlighter: nested object key", hl('{"n":{"d":true}}').includes("json-key"));
  check("highlighter: plain text left alone", !hl("plain text").includes("json-key"));
  check(
    "highlighter: body HTML is escaped (XSS)",
    !hl('{"x":"<img src=x onerror=alert(1)>"}').includes("<img")
  );

  // ── Detail panel ──────────────────────────────────────────────────────────
  app._applyFilters();
  const targetIdx = 3;
  const targetId = app.filtered[targetIdx].id;
  app._selectMessage(targetIdx);
  check("selection populates detail", document.getElementById("detailMsgId").textContent === targetId);
  check("body viewer got JSON highlighting", document.getElementById("bodyViewer").innerHTML.includes("json-key"));
  check("headers table rendered", document.getElementById("headersTable").innerHTML.includes("content-type"));
  check("rbs2 headers dimmed", document.getElementById("headersTable").innerHTML.includes("kv-key-dim"));

  // ── Keyboard navigation ───────────────────────────────────────────────────
  app._selectMessage(0);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  check("ArrowDown advances selection", app.selectedIndex === 1, `idx=${app.selectedIndex}`);

  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  check("End jumps to last", app.selectedIndex === app.filtered.length - 1, `idx=${app.selectedIndex}`);

  // ── Clear resets filter state ─────────────────────────────────────────────
  app.r.filterQueue.dataset.filter = "orders";
  app.clearMessages();
  check("clear resets messages", app.messages.length === 0);
  check("clear resets queue filter", app.r.filterQueue.dataset.filter === "all");
  check("clear resets tag filter", app.r.filterTags.dataset.filter === "all");
  check("clear empties the pool", app.pool.length === 0);

  // ── Config persistence (jsdom's real localStorage) ────────────────────────
  app.config.accountId = "acct";
  app.config.token = "super-secret";
  app._saveTokenlessConfig();
  const stored = JSON.parse(storage.getItem("fm_inspector_config") || "{}");
  check("config persisted", stored.accountId === "acct", JSON.stringify(stored));
  check("token NOT persisted", !("token" in stored), JSON.stringify(Object.keys(stored)));
  check("token still in memory for the session", app.config.token === "super-secret");

  console.log();
  if (failures) {
    console.log(`FAILED (${failures} of ${results.length} checks)`);
    process.exit(1);
  }
  console.log(`All ${results.length} UI checks passed.`);
}

main().catch((err) => {
  console.error("harness error:", err);
  process.exit(2);
});
