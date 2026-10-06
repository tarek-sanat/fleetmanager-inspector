/**
 * FleetManager Batch Inspector — App
 * Professional split-pane browser for inspecting Rebus failed messages.
 *
 * Renders the message list with a virtual scroller so 10k+ rows stay responsive,
 * and supports filtering by free-text, queue and tag.
 */
(function () {
  "use strict";

  // ─── Tunables ─────────────────────────────────────────
  const ROW_HEIGHT = 30; // must match .msg-row min-height in style.css
  const OVERSCAN = 8; // extra rows rendered above/below the viewport
  const FETCH_BATCH = 50; // IDs per /api/batch-details call
  const SEARCH_DEBOUNCE = 180; // ms

  // ─── Helpers ──────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const qs = (sel, ctx) => (ctx || document).querySelector(sel);

  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function truncate(s, max) {
    if (!s) return "";
    return s.length > max ? s.substring(0, max) + "\u2026" : s;
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function pluralize(n, s) {
    return `${n} ${s}${n !== 1 ? "s" : ""}`;
  }

  /**
   * Decode a base64 message body. Returns { text, error }.
   * Uses TextDecoder over a byte array so non-ASCII payloads survive; falls back
   * to raw atob() when TextDecoder/atob choke on the input.
   */
  function decodeBase64(b64) {
    if (!b64) return { text: "", error: null };
    try {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return { text: new TextDecoder("utf-8").decode(bytes), error: null };
    } catch (e) {
      try {
        return { text: atob(b64), error: null };
      } catch {
        return { text: "", error: `Base64 decode failed: ${e.message}` };
      }
    }
  }

  // ─── JSON Syntax Highlighter ──────────────────────────
  function highlightJSON(str) {
    if (!str) return '<span class="json-null">(empty)</span>';
    const trimmed = str.trim();
    if (!trimmed) return '<span class="json-null">(empty)</span>';

    const first = trimmed[0];
    if (first !== "{" && first !== "[" && first !== '"') return escapeHtml(str);
    try {
      JSON.parse(trimmed);
    } catch {
      return escapeHtml(str);
    }

    const tokens = tokenizeJSON(str);
    const clsMap = {
      string: "json-string",
      number: "json-number",
      boolean: "json-boolean",
      null: "json-null",
      brace: "json-brace",
      bracket: "json-bracket",
      comma: "json-comma",
      colon: "json-comma",
    };

    // A string is a KEY only when it sits in an object and the next meaningful
    // token is a colon. Tracking `inObject` stops array values being highlighted
    // as keys (the old bug: `ws` was treated as a key-preceding context).
    let result = "";
    const stack = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.t === "ws") {
        result += tok.v;
        continue;
      }
      if (tok.t === "brace") {
        if (tok.v === "{") stack.push("{");
        else stack.pop();
      } else if (tok.t === "bracket") {
        if (tok.v === "[") stack.push("[");
        else stack.pop();
      }

      if (tok.t === "string" && stack[stack.length - 1] === "{") {
        let next = null;
        for (let ni = i + 1; ni < tokens.length; ni++) {
          if (tokens[ni].t !== "ws") {
            next = tokens[ni];
            break;
          }
        }
        if (next && next.t === "colon") {
          result += `<span class="json-key">${escapeHtml(tok.v)}</span>`;
          continue;
        }
      }
      const cls = clsMap[tok.t];
      result += cls ? `<span class="${cls}">${escapeHtml(tok.v)}</span>` : escapeHtml(tok.v);
    }
    return result;
  }

  function tokenizeJSON(str) {
    const tokens = [];
    let i = 0;
    const isWs = (c) => c === " " || c === "\n" || c === "\t" || c === "\r";
    while (i < str.length) {
      const c = str[i];
      if (isWs(c)) {
        tokens.push({ t: "ws", v: c });
        i++;
      } else if (c === ",") {
        tokens.push({ t: "comma", v: "," });
        i++;
      } else if (c === ":") {
        tokens.push({ t: "colon", v: ": " });
        i++;
      } else if (c === "{" || c === "}") {
        tokens.push({ t: "brace", v: c });
        i++;
      } else if (c === "[" || c === "]") {
        tokens.push({ t: "bracket", v: c });
        i++;
      } else if (c === '"') {
        let s = '"';
        i++;
        let escaped = false;
        while (i < str.length) {
          const ch = str[i];
          s += ch;
          if (escaped) {
            escaped = false;
            i++;
            continue;
          }
          if (ch === "\\") {
            escaped = true;
            i++;
            continue;
          }
          if (ch === '"') {
            i++;
            break;
          }
          i++;
        }
        tokens.push({ t: "string", v: s });
      } else if (c === "t" && str.startsWith("true", i)) {
        tokens.push({ t: "boolean", v: "true" });
        i += 4;
      } else if (c === "f" && str.startsWith("false", i)) {
        tokens.push({ t: "boolean", v: "false" });
        i += 5;
      } else if (c === "n" && str.startsWith("null", i)) {
        tokens.push({ t: "null", v: "null" });
        i += 4;
      } else if (c === "-" || (c >= "0" && c <= "9")) {
        let n = c;
        i++;
        while (i < str.length && /[0-9.eE+\-]/.test(str[i])) {
          n += str[i];
          i++;
        }
        tokens.push({ t: "number", v: n });
      } else {
        tokens.push({ t: "other", v: c });
        i++;
      }
    }
    return tokens;
  }

  // ─── Toast system ─────────────────────────────────────
  function showToast(text, type, duration) {
    const container = $("toastContainer");
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.textContent = text;
    container.appendChild(el);
    setTimeout(() => {
      if (el.parentNode) el.remove();
    }, duration || 2800);
  }

  // ─── Clipboard ────────────────────────────────────────
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied", "success", 1500);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        showToast("Copied", "success", 1500);
      } catch {
        showToast("Copy failed", "error");
      }
      document.body.removeChild(ta);
    }
  }

  function debounce(fn, wait) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  // ─── App Class ────────────────────────────────────────
  class FleetManagerApp {
    constructor() {
      this.messages = [];
      this.filtered = [];
      this.selectedIndex = -1;
      this.selectedId = null;
      this.abortController = null;
      this.isFetching = false;
      this.config = this._loadConfig();

      // Virtual scrolling state
      this.renderStart = 0;
      this.renderEnd = 0;
      this.pool = [];

      this._initDOM();
      this._initEvents();
      this._applyConfig();
      this._render();
    }

    // ── Config ─────────────────────────────────────────
    _loadConfig() {
      try {
        const raw = localStorage.getItem("fm_inspector_config");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (!parsed.apiUrl) parsed.apiUrl = "https://manager.rebus.fm";
          return parsed;
        }
      } catch {}
      return { apiUrl: "https://manager.rebus.fm", accountId: "", token: "", autoLoad: true };
    }

    _saveConfig() {
      try {
        localStorage.setItem("fm_inspector_config", JSON.stringify(this.config));
      } catch {}
    }

    _applyConfig() {
      $("cfgApiUrl").value = this.config.apiUrl;
      $("cfgAccountId").value = this.config.accountId;
      $("cfgToken").value = this.config.token;
      $("cfgAutoLoad").checked = this.config.autoLoad !== false;
    }

    _readConfigFromUI() {
      this.config.apiUrl = $("cfgApiUrl").value.trim() || "https://manager.rebus.fm";
      this.config.accountId = $("cfgAccountId").value.trim();
      this.config.token = $("cfgToken").value.trim();
      this.config.autoLoad = $("cfgAutoLoad").checked;
    }

    /** Headers the proxy needs: token-bearing requests carry the chosen API URL. */
    _apiHeaders() {
      return { "X-Fm-Api-Url": this.config.apiUrl || "https://manager.rebus.fm" };
    }

    // ── DOM refs ────────────────────────────────────────
    _initDOM() {
      this.r = {
        topbarStatus: $("topbarStatus"),
        msgCount: $("msgCount"),
        btnConfig: $("btnConfig"),
        btnFetch: $("btnFetch"),
        btnEmptyConfig: $("btnEmptyConfig"),
        searchInput: $("searchInput"),
        clearSearch: $("clearSearch"),
        filterQueue: $("filterQueue"),
        filterTags: $("filterTags"),
        sortSelect: $("sortSelect"),
        listHeaders: $("listHeaders"),
        listViewport: $("listViewport"),
        listContainer: $("listContainer"),
        listFooter: $("listFooter"),
        rangeInfo: $("rangeInfo"),
        btnExpandAll: $("btnExpandAll"),
        btnCollapseAll: $("btnCollapseAll"),
        btnClear: $("btnClear"),
        btnDownload: $("btnDownload"),
        emptyState: $("emptyState"),
        modal: $("configModal"),
        closeConfig: $("closeConfig"),
        btnTest: $("btnTest"),
        btnSave: $("btnSave"),
        toggleToken: $("toggleToken"),
        configStatus: $("configStatus"),
        detailEmpty: $("detailEmpty"),
        detailContent: $("detailContent"),
        detailMsgId: $("detailMsgId"),
        detailCopyId: $("detailCopyId"),
        detailQueue: $("detailQueue"),
        detailTime: $("detailTime"),
        detailMachine: $("detailMachine"),
        detailActive: $("detailActive"),
        bodyViewer: $("bodyViewer"),
        headersTable: $("headersTable"),
        exceptionViewer: $("exceptionViewer"),
        rawViewer: $("rawViewer"),
        detailCopyBody: $("detailCopyBody"),
        detailCopyRaw: $("detailCopyRaw"),
        detailCopyAll: $("detailCopyAll"),
        statusLeft: $("statusLeft"),
        statusRight: $("statusRight"),
      };
    }

    // ── Events ──────────────────────────────────────────
    _initEvents() {
      this.r.btnConfig.addEventListener("click", () => this.openConfig());
      this.r.btnEmptyConfig.addEventListener("click", () => this.openConfig());
      this.r.closeConfig.addEventListener("click", () => this.closeConfig());
      this.r.modal.addEventListener("click", (e) => {
        if (e.target === this.r.modal) this.closeConfig();
      });
      this.r.toggleToken.addEventListener("click", () => {
        const inp = $("cfgToken");
        inp.type = inp.type === "password" ? "text" : "password";
      });

      this.r.btnTest.addEventListener("click", () => this.testConnection());
      this.r.btnSave.addEventListener("click", () => this.saveAndLoad());

      this.r.btnFetch.addEventListener("click", () => this.fetchMessages());
      this.r.btnClear.addEventListener("click", () => this.clearMessages());
      this.r.btnDownload.addEventListener("click", () => this._downloadBodies());

      // Search (debounced)
      const runSearch = debounce(() => this._applyFilters(), SEARCH_DEBOUNCE);
      this.r.searchInput.addEventListener("input", runSearch);
      this.r.clearSearch.addEventListener("click", () => {
        this.r.searchInput.value = "";
        this._applyFilters();
        this.r.searchInput.focus();
      });

      this.r.sortSelect.addEventListener("change", () => this._applyFilters());
      this.r.filterQueue.addEventListener("click", () => this._cycleQueueFilter());
      this.r.filterTags.addEventListener("click", () => this._cycleTagFilter());

      this.r.btnExpandAll.addEventListener("click", () => this._expandAll());
      this.r.btnCollapseAll.addEventListener("click", () => this._collapseAll());

      document.querySelectorAll(".tab").forEach((tab) => {
        tab.addEventListener("click", () => this._switchTab(tab.dataset.tab));
      });

      this.r.detailCopyId.addEventListener("click", () =>
        copyText(this.r.detailMsgId.textContent)
      );
      this.r.detailCopyBody.addEventListener("click", () => {
        const msg = this._selectedMessage();
        if (msg) copyText(msg.body || "(no body)");
      });
      this.r.detailCopyRaw.addEventListener("click", () => {
        const msg = this._selectedMessage();
        if (msg) copyText(msg.bodyRaw || "(no raw)");
      });
      this.r.detailCopyAll.addEventListener("click", () => {
        const msg = this._selectedMessage();
        if (msg) copyText(JSON.stringify(msg, null, 2));
      });

      document.addEventListener("keydown", (e) => this._onKey(e));

      // Virtual scroller: repaint the window on scroll / resize.
      this.r.listContainer.addEventListener("scroll", () => this._onScroll(), {
        passive: true,
      });
      window.addEventListener("resize", debounce(() => this._renderList(), 100));

      // Config: Enter in token/account field triggers save
      ["cfgToken", "cfgAccountId", "cfgApiUrl"].forEach((id) => {
        $(id).addEventListener("keydown", (e) => {
          if (e.key === "Enter") this.saveAndLoad();
        });
      });
    }

    // ── Config Modal ────────────────────────────────────
    openConfig() {
      this._applyConfig();
      this.r.configStatus.textContent = "";
      this.r.modal.classList.remove("hidden");
      setTimeout(() => $("cfgAccountId").focus(), 100);
    }

    closeConfig() {
      this.r.modal.classList.add("hidden");
    }

    // ── Test Connection ─────────────────────────────────
    async testConnection() {
      this._readConfigFromUI();
      if (!this.config.accountId || !this.config.token) {
        this._setConfigStatus("Account ID and Token are required", "error");
        return;
      }

      this._setConfigStatus("Testing\u2026", "");
      this.r.btnTest.disabled = true;

      try {
        const resp = await fetch(this._pingUrl(), {
          cache: "no-store",
          headers: this._apiHeaders(),
        });
        const data = await resp.json();
        if (resp.ok && typeof data.active === "number") {
          this._setConfigStatus(
            `Connected! ${data.active} active, ${data.archived} archived`,
            "success"
          );
          this._setTopbarStatus("connected");
          this.r.statusLeft.textContent = `Connected \u2014 ${data.active} active messages`;
          this.config.token = "";
          // Persist account + URL but never the token.
          this._saveConfig();
          this.config.token = $("cfgToken").value.trim();
        } else {
          this._setConfigStatus(this._errorText(data), "error");
          this._setTopbarStatus("error");
        }
      } catch (err) {
        this._setConfigStatus(`Connection failed: ${err.message}`, "error");
        this._setTopbarStatus("error");
      } finally {
        this.r.btnTest.disabled = false;
      }
    }

    _setConfigStatus(text, cls) {
      this.r.configStatus.textContent = text;
      this.r.configStatus.className = "config-status" + (cls ? " " + cls : "");
    }

    _pingUrl() {
      return `/api/ping?token=${encodeURIComponent(this.config.token)}&accountId=${encodeURIComponent(this.config.accountId)}`;
    }

    /** Render an upstream error payload into something a human can act on. */
    _errorText(data) {
      if (!data) return "Unknown error";
      if (typeof data === "string") return data;
      const base = data.error || "Request failed";
      if (data.detail) {
        return `${base} \u2014 ${String(data.detail).replace(/\s+/g, " ").slice(0, 160)}`;
      }
      return base;
    }

    // ── Save & Load ──────────────────────────────────────
    async saveAndLoad() {
      this._readConfigFromUI();
      this._saveTokenlessConfig();
      this.closeConfig();

      this._setTopbarStatus("connecting");
      this.r.statusLeft.textContent = "Testing connection\u2026";
      try {
        const resp = await fetch(this._pingUrl(), {
          cache: "no-store",
          headers: this._apiHeaders(),
        });
        const data = await resp.json();
        if (resp.ok && typeof data.active === "number") {
          this._setTopbarStatus("connected");
          this.r.statusLeft.textContent = `Connected \u2014 ${data.active} active messages`;
          if (this.config.autoLoad !== false) await this.fetchMessages();
        } else {
          this._setTopbarStatus("error");
          this.r.statusLeft.textContent = `Connection failed: ${this._errorText(data)}`;
          showToast("Connection failed", "error");
        }
      } catch (err) {
        this._setTopbarStatus("error");
        this.r.statusLeft.textContent = `Connection failed: ${err.message}`;
        showToast("Could not reach server", "error");
      }
    }

    /** Persist everything except the bearer token (kept in memory for the session). */
    _saveTokenlessConfig() {
      const token = this.config.token;
      try {
        const { token: _drop, ...rest } = this.config;
        localStorage.setItem("fm_inspector_config", JSON.stringify(rest));
      } catch {}
      this.config.token = token;
    }

    // ── Fetch Messages ──────────────────────────────────
    async fetchMessages() {
      if (this.isFetching) return;
      if (!this.config.accountId || !this.config.token) {
        this.openConfig();
        return;
      }

      this.isFetching = true;
      this.abortController = new AbortController();
      this.r.btnFetch.disabled = true;
      this.r.btnFetch.textContent = "\u23F3 Loading\u2026";
      this._setTopbarStatus("connecting");
      this.r.statusLeft.textContent = "Fetching message IDs\u2026";

      try {
        const idResp = await fetch(
          `/api/active?token=${encodeURIComponent(this.config.token)}&accountId=${encodeURIComponent(this.config.accountId)}`,
          { signal: this.abortController.signal, cache: "no-store", headers: this._apiHeaders() }
        );
        const idData = await idResp.json();

        if (!idResp.ok || !Array.isArray(idData.ids)) {
          this.r.statusLeft.textContent = `Error: ${this._errorText(idData)}`;
          this._setTopbarStatus("error");
          showToast(this._errorText(idData), "error", 5000);
          return;
        }

        const ids = idData.ids;
        if (ids.length === 0) {
          this.r.statusLeft.textContent = "No active failed messages found.";
          this._setTopbarStatus("connected");
          this.clearMessages();
          showToast("No messages found", "info");
          return;
        }

        const { results, errors } = await this._fetchDetails(ids);
        this._buildMessages(results, errors);

        this._applyFilters();
        this._setTopbarStatus("connected");
        this.r.msgCount.textContent = pluralize(this.messages.length, "message");

        const fetched = Object.keys(results).length;
        const statusText =
          fetched > 0
            ? `Loaded ${fetched} messages` + (errors.length ? `, ${errors.length} errors` : "")
            : "All messages had errors";
        this.r.statusLeft.textContent = statusText;
        this.r.statusRight.textContent = `Last fetch: ${new Date().toLocaleTimeString()}`;
        showToast(`Loaded ${fetched} messages`, errors.length ? "error" : "success");
      } catch (err) {
        if (err.name === "AbortError") {
          this.r.statusLeft.textContent = "Fetch cancelled.";
        } else {
          this.r.statusLeft.textContent = `Error: ${err.message}`;
          showToast("Fetch failed", "error");
        }
      } finally {
        this.isFetching = false;
        this.r.btnFetch.disabled = false;
        this.r.btnFetch.textContent = "\u21BA Load";
      }
    }

    /** Sequentially walk batches of IDs, calling the parallel batch endpoint. */
    async _fetchDetails(ids) {
      const results = {};
      const errors = [];
      const total = ids.length;

      for (let i = 0; i < total; i += FETCH_BATCH) {
        if (this.abortController.signal.aborted) break;

        const batch = ids.slice(i, i + FETCH_BATCH);
        const done = Math.min(i + FETCH_BATCH, total);
        const pct = Math.round((done / total) * 100);
        this.r.statusLeft.textContent = `Fetching messages ${i + 1}\u2013${done} of ${total} (${pct}%)\u2026`;

        try {
          const resp = await fetch(
            `/api/batch-details?token=${encodeURIComponent(this.config.token)}&accountId=${encodeURIComponent(this.config.accountId)}&ids=${encodeURIComponent(batch.join(","))}`,
            { signal: this.abortController.signal, cache: "no-store", headers: this._apiHeaders() }
          );
          const data = await resp.json();
          if (resp.ok && data.results) {
            Object.assign(results, data.results);
            if (data.errors) errors.push(...data.errors);
          } else {
            batch.forEach((id) => errors.push({ id, error: data.error || "Unknown" }));
          }
        } catch (err) {
          if (err.name === "AbortError") break;
          batch.forEach((id) => errors.push({ id, error: err.message }));
        }
      }
      return { results, errors };
    }

    _buildMessages(results, errors) {
      this.r.statusLeft.textContent = `Decoding ${Object.keys(results).length} message bodies\u2026`;
      this.messages = [];

      for (const [msgId, detail] of Object.entries(results)) {
        const { text: decoded, error: decodeErr } = decodeBase64(detail.body);
        this.messages.push({
          id: msgId,
          time: detail.time,
          queue: detail.sourceQueue,
          active: detail.active,
          exception: detail.exception,
          machineName: detail.machineName,
          headers: detail.headers || {},
          body: decoded,
          bodyRaw: detail.body || "(no body)",
          decodeError: decodeErr,
          tags: detail.tags || [],
          expiration: detail.expiration,
          isError: false,
        });
      }

      for (const e of errors) {
        this.messages.push({
          id: e.id,
          time: "",
          queue: "",
          active: false,
          exception: null,
          machineName: "",
          headers: {},
          body: "",
          bodyRaw: "",
          decodeError: null,
          tags: [],
          isError: true,
          errorMsg: typeof e.error === "object" ? this._errorText(e.error) : String(e.error),
        });
      }
    }

    // ── Apply Filters ──────────────────────────────────
    _applyFilters() {
      const query = this.r.searchInput.value.trim().toLowerCase();
      const sortVal = this.r.sortSelect.value;
      const queueFilter = this.r.filterQueue.dataset.filter || "all";
      const tagFilter = this.r.filterTags.dataset.filter || "all";

      let filtered = this.messages;

      if (query) {
        filtered = filtered.filter((m) => {
          const haystack = (
            m.id +
            " " +
            (m.queue || "") +
            " " +
            (m.body || "") +
            " " +
            (m.exception || "") +
            " " +
            (m.errorMsg || "")
          ).toLowerCase();
          return haystack.includes(query);
        });
      }

      if (queueFilter && queueFilter !== "all") {
        filtered = filtered.filter((m) =>
          queueFilter === "(empty)" ? !m.queue : m.queue === queueFilter
        );
      }

      if (tagFilter === "tagged") {
        filtered = filtered.filter((m) => (m.tags || []).length > 0);
      }

      this.filtered = filtered;

      const byTime = (a, b) => (a.time || "").localeCompare(b.time || "");
      switch (sortVal) {
        case "time-desc":
          this.filtered.sort((a, b) => byTime(b, a));
          break;
        case "time-asc":
          this.filtered.sort(byTime);
          break;
        case "queue":
          this.filtered.sort((a, b) => (a.queue || "").localeCompare(b.queue || ""));
          break;
        case "id":
          this.filtered.sort((a, b) => a.id.localeCompare(b.id));
          break;
      }

      this.selectedIndex = -1;
      this.selectedId = null;
      this._renderList();
      this._showDetailEmpty();
    }

    // ── Render (virtual) ────────────────────────────────
    _render() {
      this._renderList();
    }

    _renderList() {
      const items = this.filtered;
      const container = this.r.listContainer;
      const total = items.length;

      this.r.emptyState.classList.toggle("hidden", total > 0);
      this.r.listFooter.classList.toggle("hidden", total === 0);
      this.r.listHeaders.classList.toggle("hidden", total === 0);

      this.r.rangeInfo.textContent = total > 0 ? `1\u2013${total} of ${total}` : "0 of 0";

      if (total === 0) {
        this.r.listViewport.innerHTML = "";
        this.r.listViewport.style.height = "0px";
        this.pool = [];
        return;
      }

      // Full scrollable height so the native scrollbar is correct.
      this.r.listViewport.style.height = `${total * ROW_HEIGHT}px`;
      this._renderWindow(true);
    }

    /** Paint only the rows visible in the viewport (± overscan). */
    _renderWindow(reset) {
      const container = this.r.listContainer;
      const items = this.filtered;
      const total = items.length;
      if (total === 0) return;

      const scrollTop = container.scrollTop;
      const viewportH = container.clientHeight || 600;

      let start = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
      start = Math.max(0, start);
      let end = Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN;
      end = Math.min(total, end);

      if (!reset && start === this.renderStart && end === this.renderEnd) return;
      this.renderStart = start;
      this.renderEnd = end;

      const vp = this.r.listViewport;
      // Reuse a pool of row elements instead of rebuilding the DOM every scroll.
      const needed = end - start;
      this._ensurePool(needed);

      for (let p = 0; p < this.pool.length; p++) {
        const row = this.pool[p];
        if (p < needed) {
          this._fillRow(row, items[start + p], start + p);
          row.style.display = "";
        } else {
          row.style.display = "none";
        }
      }

      // Header must line up with the rows' left edge. Offset by scrollbar width
      // so headers don't drift when the vertical scrollbar appears.
      const scrollbar = container.offsetWidth - container.clientWidth;
      this.r.listHeaders.style.paddingRight = `${12 + scrollbar}px`;
    }

    _ensurePool(n) {
      const vp = this.r.listViewport;
      while (this.pool.length < n) {
        const row = document.createElement("div");
        row.className = "msg-row";
        row.addEventListener("click", () => this._selectMessage(Number(row.dataset.idx)));
        row.addEventListener("dblclick", () => copyText(row.dataset.msgId));
        this.pool.push(row);
        vp.appendChild(row);
      }
    }

    _fillRow(row, msg, idx) {
      if (!msg) {
        row.style.display = "none";
        return;
      }
      row.dataset.idx = idx;
      row.dataset.msgId = msg.id;
      row.style.top = `${idx * ROW_HEIGHT}px`;
      row.className =
        "msg-row" +
        (msg.isError ? " error-row" : "") +
        (idx === this.selectedIndex ? " selected" : "");
      row.title = msg.id;

      const preview = msg.isError
        ? "\u26A0\uFE0F " + truncate(msg.errorMsg, 90)
        : msg.decodeError
          ? "\u274C " + msg.decodeError
          : truncate(msg.body ? msg.body.split("\n")[0].trim() : "(empty body)", 100);

      row.innerHTML =
        `<span class="col-idx">${idx + 1}</span>` +
        `<span class="col-id">${escapeHtml(truncate(msg.id, 28))}</span>` +
        `<span class="col-queue">${msg.queue ? `<span class="queue-badge">${escapeHtml(msg.queue)}</span>` : ""}</span>` +
        `<span class="col-time">${escapeHtml(fmtTime(msg.time))}</span>` +
        `<span class="col-preview">${escapeHtml(preview)}</span>`;
    }

    _onScroll() {
      if (this.filtered.length === 0) return;
      this._renderWindow(false);
    }

    _selectMessage(idx) {
      if (idx < 0 || idx >= this.filtered.length) return;
      const prev = this.selectedIndex;
      this.selectedIndex = idx;
      this.selectedId = this.filtered[idx]?.id;

      // Repaint just the two affected rows.
      const rows = this.pool;
      for (const row of rows) {
        const rIdx = Number(row.dataset.idx);
        if (rIdx === prev) row.classList.remove("selected");
        if (rIdx === idx) row.classList.add("selected");
      }

      // Keep the selection inside the rendered window; scroll if it isn't visible.
      this._scrollRowIntoView(idx);
      const msg = this.filtered[idx];
      if (msg) this._showDetail(msg);
    }

    _scrollRowIntoView(idx) {
      const container = this.r.listContainer;
      const top = idx * ROW_HEIGHT;
      const bottom = top + ROW_HEIGHT;
      if (top < container.scrollTop) {
        container.scrollTop = top;
      } else if (bottom > container.scrollTop + container.clientHeight) {
        container.scrollTop = bottom - container.clientHeight;
      }
      // Repaint on the next frame: reading scrollTop right after writing it can
      // return the pre-scroll value in some engines, which would paint a stale
      // window. The passive scroll listener also repaints, so this is a safety net.
      requestAnimationFrame(() => this._renderWindow(false));
    }

    _selectedMessage() {
      if (this.selectedIndex >= 0 && this.selectedIndex < this.filtered.length) {
        return this.filtered[this.selectedIndex];
      }
      return null;
    }

    // ── Detail Panel ────────────────────────────────────
    _showDetail(msg) {
      this.r.detailEmpty.classList.add("hidden");
      this.r.detailContent.classList.remove("hidden");

      if (msg.isError) {
        this.r.detailMsgId.textContent = msg.id;
        this.r.detailQueue.textContent = "ERROR";
        this.r.detailQueue.className = "detail-tag archive-tag";
        this.r.detailTime.textContent = "";
        this.r.detailMachine.textContent = "";
        this.r.detailActive.textContent = "";
        this.r.bodyViewer.innerHTML = `<span style="color: var(--red)">${escapeHtml(msg.errorMsg)}</span>`;
        this.r.headersTable.innerHTML = "";
        this.r.exceptionViewer.textContent = "";
        this.r.rawViewer.textContent = "";
        this._switchTab("body");
        return;
      }

      this.r.detailMsgId.textContent = msg.id;
      this.r.detailQueue.textContent = msg.queue || "(no queue)";
      this.r.detailQueue.className = "detail-tag queue-tag";
      this.r.detailTime.textContent = fmtTime(msg.time);
      this.r.detailTime.className = "detail-tag time-tag";
      this.r.detailMachine.textContent = msg.machineName || "";
      this.r.detailMachine.className = "detail-tag machine-tag";
      this.r.detailActive.textContent = msg.active ? "Active" : "Archived";
      this.r.detailActive.className = "detail-tag " + (msg.active ? "active-tag" : "archive-tag");

      if (msg.decodeError) {
        this.r.bodyViewer.innerHTML = `<span style="color: var(--red)">${escapeHtml(msg.decodeError)}</span>`;
      } else {
        this.r.bodyViewer.innerHTML = highlightJSON(msg.body || "(empty body)");
      }

      const headerKeys = Object.keys(msg.headers);
      if (headerKeys.length > 0) {
        let html = "<tbody>";
        for (const [key, val] of Object.entries(msg.headers)) {
          if (key.toLowerCase().startsWith("rbs2-")) continue;
          html += `<tr><td class="kv-key">${escapeHtml(key)}</td><td class="kv-val">${escapeHtml(val)}</td></tr>`;
        }
        for (const [key, val] of Object.entries(msg.headers)) {
          if (key.toLowerCase().startsWith("rbs2-")) {
            html += `<tr><td class="kv-key kv-key-dim">${escapeHtml(key)}</td><td class="kv-val">${escapeHtml(val)}</td></tr>`;
          }
        }
        html += "</tbody>";
        this.r.headersTable.innerHTML = html;
      } else {
        this.r.headersTable.innerHTML =
          "<tbody><tr><td class='kv-empty'>No headers</td></tr></tbody>";
      }

      this.r.exceptionViewer.textContent = msg.exception || "(no exception)";
      this.r.rawViewer.textContent = msg.bodyRaw || "(no raw data)";
      this._switchTab("body");
    }

    _showDetailEmpty() {
      this.r.detailEmpty.classList.remove("hidden");
      this.r.detailContent.classList.add("hidden");
    }

    _switchTab(tabId) {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tabId));
      document.querySelectorAll(".tab-content").forEach((t) =>
        t.classList.toggle("active", t.id === "tab" + tabId.charAt(0).toUpperCase() + tabId.slice(1))
      );
    }

    // ── Queue / Tag Filters ─────────────────────────────
    _cycleQueueFilter() {
      const queues = new Set(["all"]);
      for (const m of this.messages) queues.add(m.queue || "(empty)");
      const arr = [...queues].sort();
      const current = this.r.filterQueue.dataset.filter || "all";
      const next = arr[(arr.indexOf(current) + 1) % arr.length];
      this.r.filterQueue.dataset.filter = next;
      this.r.filterQueue.textContent = "Queue: " + (next === "all" ? "All" : next);
      this.r.filterQueue.classList.toggle("active", next !== "all");
      this._applyFilters();
    }

    _cycleTagFilter() {
      const current = this.r.filterTags.dataset.filter || "all";
      const next = current === "all" ? "tagged" : "all";
      this.r.filterTags.dataset.filter = next;
      this.r.filterTags.textContent = "Tags: " + (next === "all" ? "All" : "Tagged");
      this.r.filterTags.classList.toggle("active", next !== "all");
      this._applyFilters();
    }

    // ── Expand / Collapse ───────────────────────────────
    _expandAll() {
      showToast("Select a message to view it in the detail panel", "info");
    }

    _collapseAll() {
      this._showDetailEmpty();
    }

    // ── Clear ──────────────────────────────────────────
    clearMessages() {
      this.messages = [];
      this.filtered = [];
      this.selectedIndex = -1;
      this.selectedId = null;
      this.pool = [];
      this.renderStart = this.renderEnd = 0;
      this.r.listViewport.innerHTML = "";
      this.r.listViewport.style.height = "0px";
      this._showDetailEmpty();
      this.r.emptyState.classList.remove("hidden");
      this.r.listFooter.classList.add("hidden");
      this.r.listHeaders.classList.add("hidden");
      this.r.msgCount.textContent = "0 messages";
      this.r.statusLeft.textContent = "Ready";
      // Reset filters so a stale queue/tag filter doesn't hide the next load.
      this.r.filterQueue.dataset.filter = "all";
      this.r.filterQueue.textContent = "Queue: All";
      this.r.filterQueue.classList.remove("active");
      this.r.filterTags.dataset.filter = "all";
      this.r.filterTags.textContent = "Tags: All";
      this.r.filterTags.classList.remove("active");
      this.r.searchInput.value = "";
    }

    // ── Download ─────────────────────────────────────────
    _downloadBodies() {
      const items = this.filtered;
      if (items.length === 0) {
        showToast("No messages to download", "error");
        return;
      }

      const lines = [];
      const SEP = "\u2550".repeat(72);

      for (let i = 0; i < items.length; i++) {
        const msg = items[i];
        lines.push(SEP);
        lines.push(`Message #${i + 1}`);
        lines.push(`Message ID: ${msg.id}`);
        if (msg.queue) lines.push(`Queue: ${msg.queue}`);
        if (msg.time) lines.push(`Time: ${msg.time}`);
        if (msg.machineName) lines.push(`Machine: ${msg.machineName}`);
        if (msg.tags && msg.tags.length > 0) lines.push(`Tags: ${msg.tags.join(", ")}`);
        lines.push(SEP);
        lines.push("");
        if (msg.isError) {
          lines.push(`[ERROR] ${msg.errorMsg}`);
        } else if (msg.decodeError) {
          lines.push(`[DECODE ERROR] ${msg.decodeError}`);
        } else {
          lines.push(msg.body || "(empty body)");
        }
        lines.push("");
        lines.push("");
      }

      const filename = `fleetmanager-bodies-${new Date().toISOString().slice(0, 10)}.txt`;
      this._triggerDownload(lines.join("\n"), filename, "text/plain");
      showToast(`Downloaded ${items.length} bodies as ${filename}`, "success");
    }

    _triggerDownload(content, filename, mimeType) {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    }

    // ── Topbar / Status ─────────────────────────────────
    _setTopbarStatus(state) {
      const el = this.r.topbarStatus;
      el.className = "topbar-status " + state;
      const texts = {
        connected: "Connected",
        disconnected: "Disconnected",
        connecting: "Connecting\u2026",
        error: "Error",
      };
      qs(".status-text", el).textContent = texts[state] || state;
    }

    // ── Keyboard ────────────────────────────────────────
    _onKey(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;

      // Ctrl/Cmd+F focuses search from anywhere.
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        this.r.searchInput.focus();
        this.r.searchInput.select();
        return;
      }

      const len = this.filtered.length;
      if (len === 0) return;
      const next = this.selectedIndex < 0 ? 0 : this.selectedIndex + 1;

      switch (e.key) {
        case "ArrowDown":
        case "j":
          e.preventDefault();
          this._selectMessage(Math.min(next, len - 1));
          break;
        case "ArrowUp":
        case "k":
          e.preventDefault();
          this._selectMessage(Math.max(this.selectedIndex - 1, 0));
          break;
        case "PageDown":
          e.preventDefault();
          this._selectMessage(Math.min(this.selectedIndex + 10, len - 1));
          break;
        case "PageUp":
          e.preventDefault();
          this._selectMessage(Math.max(this.selectedIndex - 10, 0));
          break;
        case "Home":
          e.preventDefault();
          this._selectMessage(0);
          break;
        case "End":
          e.preventDefault();
          this._selectMessage(len - 1);
          break;
        case "Enter": {
          const msg = this._selectedMessage();
          if (msg) copyText(msg.id);
          break;
        }
        case "c":
          if (e.ctrlKey || e.metaKey) break;
          {
            const msg = this._selectedMessage();
            if (msg) copyText(msg.body || msg.id);
          }
          break;
        case "n":
        case "N":
          this.r.btnFetch.click();
          break;
      }
    }
  }

  // ─── Boot ─────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    window.app = new FleetManagerApp();
  });
})();
