/**
 * FleetManager Batch Inspector — App
 * Professional split-pane browser for inspecting Rebus failed messages.
 */
(function () {
  "use strict";

  // ─── Helpers ──────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const qs = (sel, ctx) => (ctx || document).querySelector(sel);

  function fmtTime(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch {
      return iso;
    }
  }

  function truncate(s, max) {
    if (!s) return "";
    return s.length > max ? s.substring(0, max) + "\u2026" : s;
  }

  function escapeHtml(s) {
    if (!s) return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function pluralize(n, s) {
    return `${n} ${s}${n !== 1 ? "s" : ""}`;
  }

  // ─── JSON Syntax Highlighter ──────────────────────────
  function highlightJSON(str) {
    if (!str) return '<span class="json-null">(empty)</span>';
    // Detect first non-whitespace char
    const trimmed = str.trim();
    if (!trimmed) return '<span class="json-null">(empty)</span>';
    const first = trimmed[0];
    if (first !== "{" && first !== "[" && first !== '"') {
      return escapeHtml(str);
    }
    // Try to parse, if valid JSON, syntax-highlight it
    try {
      JSON.parse(trimmed);
    } catch {
      return escapeHtml(str);
    }
    // Tokenize
    const tokens = [];
    let i = 0;
    while (i < str.length) {
      if (str[i] === " " || str[i] === "\n" || str[i] === "\t" || str[i] === "\r") {
        tokens.push({ t: "ws", v: str[i] });
        i++;
      } else if (str[i] === ",") {
        tokens.push({ t: "comma", v: "," });
        i++;
      } else if (str[i] === ":" ) {
        tokens.push({ t: "colon", v: ": " });
        i++;
      } else if (str[i] === "{" || str[i] === "}") {
        tokens.push({ t: "brace", v: str[i] });
        i++;
      } else if (str[i] === "[" || str[i] === "]") {
        tokens.push({ t: "bracket", v: str[i] });
        i++;
      } else if (str[i] === '"') {
        // String — scan to closing quote
        let s = '"';
        i++;
        let escaped = false;
        while (i < str.length) {
          s += str[i];
          if (escaped) { escaped = false; i++; continue; }
          if (str[i] === "\\") { escaped = true; i++; continue; }
          if (str[i] === '"') { i++; break; }
          i++;
        }
        tokens.push({ t: "string", v: s });
      } else if (str[i] === "t" && str.startsWith("true", i)) {
        tokens.push({ t: "boolean", v: "true" });
        i += 4;
      } else if (str[i] === "f" && str.startsWith("false", i)) {
        tokens.push({ t: "boolean", v: "false" });
        i += 5;
      } else if (str[i] === "n" && str.startsWith("null", i)) {
        tokens.push({ t: "null", v: "null" });
        i += 4;
      } else if (str[i] === "-" || (str[i] >= "0" && str[i] <= "9")) {
        let n = str[i];
        i++;
        while (i < str.length && /[0-9.eE+\-]/.test(str[i])) { n += str[i]; i++; }
        tokens.push({ t: "number", v: n });
      } else {
        tokens.push({ t: "other", v: str[i] });
        i++;
      }
    }
    // Now decide if a string is a key or a value
    const clsMap = {
      string: "json-string",
      number: "json-number",
      boolean: "json-boolean",
      null: "json-null",
      brace: "json-brace",
      bracket: "json-bracket",
      comma: "json-comma",
      colon: "json-comma",
      key: "json-key",
    };
    let result = "";
    let prevToken = null;
    for (let ti = 0; ti < tokens.length; ti++) {
      const tok = tokens[ti];
      if (tok.t === "ws") { result += tok.v; prevToken = tok; continue; }
      if (tok.t === "string" && prevToken && (prevToken.t === "brace" || prevToken.t === "comma" || prevToken.t === "ws")) {
        // Check if next meaningful token is colon
        let next = null;
        for (let ni = ti + 1; ni < tokens.length; ni++) {
          if (tokens[ni].t !== "ws") { next = tokens[ni]; break; }
        }
        if (next && next.t === "colon") {
          result += `<span class="json-key">${escapeHtml(tok.v)}</span>`;
          prevToken = tok;
          continue;
        }
      }
      const cls = clsMap[tok.t] || "";
      result += cls ? `<span class="${cls}">${escapeHtml(tok.v)}</span>` : escapeHtml(tok.v);
      prevToken = tok;
    }
    return result;
  }

  // ─── Toast system ─────────────────────────────────────
  function showToast(text, type, duration) {
    const container = $("toastContainer");
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.textContent = text;
    container.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, duration || 2800);
  }

  // ─── Clipboard ────────────────────────────────────────
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied", "success", 1500);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("Copied", "success", 1500);
    }
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

      this._initDOM();
      this._initEvents();
      this._applyConfig();
      this._render();
    }

    // ── Config ─────────────────────────────────────────
    _loadConfig() {
      try {
        const raw = localStorage.getItem("fm_inspector_config");
        if (raw) return JSON.parse(raw);
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
      // Config modal
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

      // Config actions
      this.r.btnTest.addEventListener("click", () => this.testConnection());
      this.r.btnSave.addEventListener("click", () => this.saveAndLoad());

      // Fetch / Load
      this.r.btnFetch.addEventListener("click", () => this.fetchMessages());
      this.r.btnClear.addEventListener("click", () => this.clearMessages());
      this.r.btnDownload.addEventListener("click", () => this._downloadBodies());

      // Search
      this.r.searchInput.addEventListener("input", () => this._applyFilters());
      this.r.clearSearch.addEventListener("click", () => {
        this.r.searchInput.value = "";
        this._applyFilters();
        this.r.searchInput.focus();
      });

      // Sort
      this.r.sortSelect.addEventListener("change", () => this._applyFilters());

      // Filter buttons
      this.r.filterQueue.addEventListener("click", () => this._cycleQueueFilter());
      this.r.filterTags.addEventListener("click", () => this._cycleTagFilter());

      // Expand/collapse all
      this.r.btnExpandAll.addEventListener("click", () => this._expandAll());
      this.r.btnCollapseAll.addEventListener("click", () => this._collapseAll());

      // Detail tabs
      document.querySelectorAll(".tab").forEach((tab) => {
        tab.addEventListener("click", () => this._switchTab(tab.dataset.tab));
      });

      // Detail copy buttons
      this.r.detailCopyId.addEventListener("click", () => copyText(this.r.detailMsgId.textContent));
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

      // Keyboard
      document.addEventListener("keydown", (e) => this._onKey(e));

      // Config: Enter in token field triggers save
      $("cfgToken").addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.saveAndLoad();
      });
      $("cfgAccountId").addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.saveAndLoad();
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
        this.r.configStatus.textContent = "Account ID and Token are required";
        this.r.configStatus.className = "config-status error";
        return;
      }
      const url = `${this.config.apiUrl}/ui/external/failed-messages/counts?accountId=${encodeURIComponent(this.config.accountId)}`;

      this.r.configStatus.textContent = "Testing\u2026";
      this.r.configStatus.className = "config-status";
      this.r.btnTest.disabled = true;

      try {
        const resp = await fetch("/api/ping", {
          cache: "no-store",
          headers: { "X-Fm-Api-Url": this.config.apiUrl },
        });
        // We proxy through our server, so we need to pass token/accountId as params
        // Actually our proxy expects query params - let me use the right endpoint
        const realResp = await fetch(`/api/ping?token=${encodeURIComponent(this.config.token)}&accountId=${encodeURIComponent(this.config.accountId)}`, {
          cache: "no-store",
        });
        const data = await realResp.json();
        if (realResp.ok && data.active !== undefined) {
          this.r.configStatus.textContent = `Connected! ${data.active} active, ${data.archived} archived`;
          this.r.configStatus.className = "config-status success";
          this._setTopbarStatus("connected");
          this.r.statusLeft.textContent = `Connected \u2014 ${data.active} active messages`;
          this._saveConfig();
        } else {
          this.r.configStatus.textContent = `API error: ${data.error || JSON.stringify(data).substring(0, 100)}`;
          this.r.configStatus.className = "config-status error";
          this._setTopbarStatus("error");
        }
      } catch (err) {
        this.r.configStatus.textContent = `Connection failed: ${err.message}`;
        this.r.configStatus.className = "config-status error";
        this._setTopbarStatus("error");
      } finally {
        this.r.btnTest.disabled = false;
      }
    }

    // ── Save & Load ──────────────────────────────────────
    async saveAndLoad() {
      this._readConfigFromUI();
      this._saveConfig();
      this.closeConfig();

      // Test connection first
      this._setTopbarStatus("connecting");
      this.r.statusLeft.textContent = "Testing connection\u2026";
      try {
        const resp = await fetch(`/api/ping?token=${encodeURIComponent(this.config.token)}&accountId=${encodeURIComponent(this.config.accountId)}`, {
          cache: "no-store",
        });
        const data = await resp.json();
        if (resp.ok && data.active !== undefined) {
          this._setTopbarStatus("connected");
          this.r.statusLeft.textContent = `Connected \u2014 ${data.active} active messages`;
          if (this.config.autoLoad !== false) {
            await this.fetchMessages();
          }
        } else {
          this._setTopbarStatus("error");
          this.r.statusLeft.textContent = `Connection failed: ${data.error || "unknown error"}`;
          showToast("Connection failed", "error");
        }
      } catch (err) {
        this._setTopbarStatus("error");
        this.r.statusLeft.textContent = `Connection failed: ${err.message}`;
        showToast("Could not reach server", "error");
      }
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
        // Phase 1: Get IDs
        const idResp = await fetch(`/api/active?token=${encodeURIComponent(this.config.token)}&accountId=${encodeURIComponent(this.config.accountId)}`, {
          signal: this.abortController.signal,
          cache: "no-store",
        });
        const idData = await idResp.json();

        if (!idResp.ok || !idData.ids) {
          this.r.statusLeft.textContent = `Error: ${idData.error || "Failed to fetch IDs"}`;
          this._setTopbarStatus("error");
          showToast("Failed to get message IDs", "error");
          this.isFetching = false;
          this.r.btnFetch.disabled = false;
          this.r.btnFetch.textContent = "\u21BA Load";
          return;
        }

        const ids = idData.ids;
        if (ids.length === 0) {
          this.r.statusLeft.textContent = "No active failed messages found.";
          this._setTopbarStatus("connected");
          this.clearMessages();
          showToast("No messages found", "info");
          this.isFetching = false;
          this.r.btnFetch.disabled = false;
          this.r.btnFetch.textContent = "\u21BA Load";
          return;
        }

        // Phase 2: Batch fetch details
        const BATCH = 50;
        const allResults = {};
        const allErrors = [];
        let fetched = 0;
        let errCount = 0;

        for (let i = 0; i < ids.length; i += BATCH) {
          if (this.abortController.signal.aborted) {
            this.r.statusLeft.textContent = "Fetch cancelled.";
            this._setTopbarStatus("disconnected");
            this.isFetching = false;
            this.r.btnFetch.disabled = false;
            this.r.btnFetch.textContent = "\u21BA Load";
            return;
          }

          const batch = ids.slice(i, i + BATCH);
          const pct = Math.round(((i + batch.length) / ids.length) * 100);
          this.r.statusLeft.textContent = `Fetching messages ${i + 1}\u2013${Math.min(i + BATCH, ids.length)} of ${ids.length} (${pct}%)\u2026`;

          try {
            const resp = await fetch(`/api/batch-details?token=${encodeURIComponent(this.config.token)}&accountId=${encodeURIComponent(this.config.accountId)}&ids=${encodeURIComponent(batch.join(","))}`, {
              signal: this.abortController.signal,
              cache: "no-store",
            });
            const data = await resp.json();
            if (resp.ok && data.results) {
              Object.assign(allResults, data.results);
              fetched += Object.keys(data.results).length;
              if (data.errors) {
                allErrors.push(...data.errors);
                errCount += data.errors.length;
              }
            } else {
              errCount += batch.length;
              batch.forEach((id) => allErrors.push({ id, error: data.error || "Unknown" }));
            }
          } catch (err) {
            if (err.name === "AbortError") break;
            errCount += batch.length;
            batch.forEach((id) => allErrors.push({ id, error: err.message }));
          }
        }

        // Decode bodies
        this.r.statusLeft.textContent = `Decoding ${fetched} message bodies\u2026`;
        this.messages = [];

        for (const [msgId, detail] of Object.entries(allResults)) {
          let decoded = "";
          let decodeErr = null;
          if (detail.body) {
            try { decoded = atob(detail.body); }
            catch (e) { decodeErr = `Base64 decode failed: ${e.message}`; }
          }
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
          });
        }

        // Add errors
        for (const e of allErrors) {
          this.messages.push({
            id: e.id, time: "", queue: "", active: false, exception: null,
            body: "", bodyRaw: "", decodeError: null, tags: [],
            isError: true, errorMsg: typeof e.error === "object" ? JSON.stringify(e.error) : e.error,
          });
        }

        this._applyFilters();
        this._render();
        this._setTopbarStatus("connected");
        this.r.msgCount.textContent = pluralize(this.messages.length, "message");

        const statusText = fetched > 0
          ? `Loaded ${fetched} messages` + (errCount > 0 ? `, ${errCount} errors` : "")
          : "All messages had errors";
        this.r.statusLeft.textContent = statusText;
        this.r.statusRight.textContent = `Last fetch: ${new Date().toLocaleTimeString()}`;

        showToast(`Loaded ${fetched} messages`, errCount > 0 ? "error" : "success");
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

    // ── Apply Filters ──────────────────────────────────
    _applyFilters() {
      const query = this.r.searchInput.value.trim().toLowerCase();
      const sortVal = this.r.sortSelect.value;
      const queueFilter = this.r.filterQueue.dataset.filter || "";
      const tagFilter = this.r.filterTags.dataset.filter || "";

      let filtered = this.messages;

      // Search
      if (query) {
        filtered = filtered.filter((m) => {
          const haystack = (m.id + " " + (m.queue || "") + " " + (m.body || "") + " " + (m.errorMsg || "")).toLowerCase();
          return haystack.includes(query);
        });
      }

      // Queue filter
      if (queueFilter && queueFilter !== "all") {
        filtered = filtered.filter((m) => {
          if (queueFilter === "(empty)") return !m.queue;
          return m.queue === queueFilter;
        });
      }

      this.filtered = filtered;

      // Sort
      switch (sortVal) {
        case "time-desc":
          this.filtered.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
          break;
        case "time-asc":
          this.filtered.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
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

    // ── Render ─────────────────────────────────────────
    _render() {
      this._renderList();
    }

    _renderList() {
      const vp = this.r.listViewport;
      const items = this.filtered;
      vp.innerHTML = "";

      const footer = this.r.listFooter;
      this.r.emptyState.classList.toggle("hidden", items.length > 0);
      footer.classList.toggle("hidden", items.length === 0);

      this.r.rangeInfo.textContent = items.length > 0
        ? `1\u2013${items.length} of ${items.length}`
        : `0 of 0`;

      if (items.length === 0) return;

      // Build rows in a fragment
      const frag = document.createDocumentFragment();
      for (let i = 0; i < items.length; i++) {
        frag.appendChild(this._buildRow(items[i], i));
      }
      vp.appendChild(frag);

      // Scroll to top
      this.r.listContainer.scrollTop = 0;
    }

    _buildRow(msg, idx) {
      const row = document.createElement("div");
      row.className = "msg-row" + (msg.isError ? " error-row" : "");
      row.dataset.idx = idx;
      row.dataset.msgId = msg.id;

      // # column
      const colIdx = document.createElement("span");
      colIdx.className = "col-idx";
      colIdx.textContent = idx + 1;

      // ID column
      const colId = document.createElement("span");
      colId.className = "col-id";
      colId.title = msg.id;
      colId.textContent = truncate(msg.id, 28);

      // Queue column
      const colQueue = document.createElement("span");
      colQueue.className = "col-queue";
      if (msg.queue) {
        const badge = document.createElement("span");
        badge.className = "queue-badge";
        badge.textContent = msg.queue;
        colQueue.appendChild(badge);
      }

      // Time column
      const colTime = document.createElement("span");
      colTime.className = "col-time";
      colTime.textContent = fmtTime(msg.time);

      // Preview column
      const colPrev = document.createElement("span");
      colPrev.className = "col-preview";
      if (msg.isError) {
        colPrev.textContent = "\u26A0\uFE0F " + truncate(msg.errorMsg, 60);
      } else if (msg.decodeError) {
        colPrev.textContent = "\u274C " + msg.decodeError;
      } else {
        const preview = msg.body ? msg.body.split("\n")[0].trim() : "(empty body)";
        colPrev.textContent = truncate(preview, 80);
      }

      row.appendChild(colIdx);
      row.appendChild(colId);
      row.appendChild(colQueue);
      row.appendChild(colTime);
      row.appendChild(colPrev);

      row.addEventListener("click", () => this._selectMessage(idx));
      row.addEventListener("dblclick", () => copyText(msg.id));

      return row;
    }

    _selectMessage(idx) {
      // Deselect previous
      if (this.selectedIndex >= 0) {
        const prev = this.r.listViewport.querySelector(`[data-idx="${this.selectedIndex}"]`);
        if (prev) prev.classList.remove("selected");
      }

      this.selectedIndex = idx;
      this.selectedId = this.filtered[idx]?.id;

      const row = this.r.listViewport.querySelector(`[data-idx="${idx}"]`);
      if (row) {
        row.classList.add("selected");
        row.scrollIntoView({ block: "nearest" });
      }

      const msg = this.filtered[idx];
      if (msg) this._showDetail(msg);
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
        this.r.rawViewer.textContent = msg.bodyRaw;
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

      // Body tab
      if (msg.decodeError) {
        this.r.bodyViewer.innerHTML = `<span style="color: var(--red)">${escapeHtml(msg.decodeError)}</span>`;
      } else {
        this.r.bodyViewer.innerHTML = highlightJSON(msg.body || "(empty body)");
      }

      // Headers tab
      const headerKeys = Object.keys(msg.headers);
      if (headerKeys.length > 0) {
        let html = "<tbody>";
        for (const [key, val] of Object.entries(msg.headers)) {
          if (key.toLowerCase().startsWith("rbs2-")) continue;
          html += `<tr><td class="kv-key">${escapeHtml(key)}</td><td class="kv-val">${escapeHtml(val)}</td></tr>`;
        }
        // RBS2 headers at bottom
        for (const [key, val] of Object.entries(msg.headers)) {
          if (key.toLowerCase().startsWith("rbs2-")) {
            html += `<tr><td class="kv-key" style="color: var(--text-muted)">${escapeHtml(key)}</td><td class="kv-val">${escapeHtml(val)}</td></tr>`;
          }
        }
        html += "</tbody>";
        this.r.headersTable.innerHTML = html;
      } else {
        this.r.headersTable.innerHTML = "<tbody><tr><td style='color: var(--text-muted); padding: 8px'>No headers</td></tr></tbody>";
      }

      // Exception tab
      this.r.exceptionViewer.textContent = msg.exception || "(no exception)";

      // Raw tab
      this.r.rawViewer.textContent = msg.bodyRaw || "(no raw data)";

      // Default to Body tab
      this._switchTab("body");
    }

    _showDetailEmpty() {
      this.r.detailEmpty.classList.remove("hidden");
      this.r.detailContent.classList.add("hidden");
    }

    _switchTab(tabId) {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tabId));
      document.querySelectorAll(".tab-content").forEach((t) => t.classList.toggle("active", t.id === "tab" + tabId.charAt(0).toUpperCase() + tabId.slice(1)));
    }

    // ── Queue / Tag Filters ─────────────────────────────
    _cycleQueueFilter() {
      // Collect all unique queues
      const queues = new Set();
      queues.add("all");
      for (const m of this.messages) {
        if (m.queue) queues.add(m.queue);
        else queues.add("(empty)");
      }
      const arr = [...queues].sort();
      const current = this.r.filterQueue.dataset.filter || "all";
      const idx = arr.indexOf(current);
      const next = arr[(idx + 1) % arr.length];
      this.r.filterQueue.dataset.filter = next;
      this.r.filterQueue.textContent = "Queue: " + (next === "all" ? "All" : next);
      this._applyFilters();
    }

    _cycleTagFilter() {
      // Since tags are free-form, just toggle between All and Has tags
      const current = this.r.filterTags.dataset.filter || "all";
      const next = current === "all" ? "has-tags" : "all";
      this.r.filterTags.dataset.filter = next;
      this.r.filterTags.textContent = "Tags: " + (next === "all" ? "All" : "Tagged");
      this._applyFilters();
    }

    // ── Expand / Collapse ───────────────────────────────
    _expandAll() {
      // Not applicable in split-pane view — detail panel replaces expand
      showToast("Select a message to view in the detail panel", "info");
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
      this.r.listViewport.innerHTML = "";
      this._showDetailEmpty();
      this.r.emptyState.classList.remove("hidden");
      this.r.listFooter.classList.add("hidden");
      this.r.msgCount.textContent = "0 messages";
      this.r.statusLeft.textContent = "Ready";
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
        if (msg.time) lines.push(`Time: ${fmtTime(msg.time)}`);
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

      const content = lines.join("\n");
      const filename = `fleetmanager-bodies-${new Date().toISOString().slice(0, 10)}.txt`;
      this._triggerDownload(content, filename, "text/plain");
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

    // ── Topbar Status ──────────────────────────────────
    _setTopbarStatus(state) {
      const el = this.r.topbarStatus;
      el.className = "topbar-status " + state;
      const texts = { connected: "Connected", disconnected: "Disconnected", connecting: "Connecting\u2026", error: "Error" };
      qs(".status-text", el).textContent = texts[state] || state;
    }

    // ── Keyboard ────────────────────────────────────────
    _onKey(e) {
      // Don't intercept when typing in inputs
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;

      const len = this.filtered.length;
      if (len === 0) return;

      switch (e.key) {
        case "ArrowDown":
        case "j":
          e.preventDefault();
          this._selectMessage(Math.min(this.selectedIndex + 1, len - 1));
          break;
        case "ArrowUp":
        case "k":
          e.preventDefault();
          this._selectMessage(Math.max(this.selectedIndex - 1, 0));
          break;
        case "Home":
          e.preventDefault();
          this._selectMessage(0);
          break;
        case "End":
          e.preventDefault();
          this._selectMessage(len - 1);
          break;
        case "Enter":
          if (this.selectedIndex >= 0) {
            const msg = this.filtered[this.selectedIndex];
            if (msg) copyText(msg.id);
          }
          break;
        case "c":
          if (e.ctrlKey || e.metaKey) break; // native copy
          if (this.selectedIndex >= 0) {
            const msg = this.filtered[this.selectedIndex];
            if (msg) copyText(msg.body || msg.id);
          }
          break;
        case "f":
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this.r.searchInput.focus();
            this.r.searchInput.select();
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