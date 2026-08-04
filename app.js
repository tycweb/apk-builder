(() => {
  const tokenInput = document.getElementById("token-input");
  const tokenToggle = document.getElementById("token-toggle");
  const rememberToken = document.getElementById("remember-token");
  const packageInput = document.getElementById("package-input");
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const selectedFileEl = document.getElementById("selected-file");
  const buildBtn = document.getElementById("build-btn");
  const submitError = document.getElementById("submit-error");
  const historyList = document.getElementById("history-list");
  const historyEmpty = document.getElementById("history-empty");

  const POLL_INTERVAL_MS = 8000;
  const LOCAL_KEY_TOKEN = "apkforge_token";
  const LOCAL_KEY_HISTORY = "apkforge_history"; // [{id, expoBuildId, filename, status, createdAt, pageUrl, downloadUrl, error}]

  let selectedFile = null;
  const activePolls = new Set();

  // ---------- token remember (opt-in, local only) ----------

  const savedToken = localStorage.getItem(LOCAL_KEY_TOKEN);
  if (savedToken) {
    tokenInput.value = savedToken;
    rememberToken.checked = true;
  }

  tokenToggle.addEventListener("click", () => {
    const showing = tokenInput.type === "text";
    tokenInput.type = showing ? "password" : "text";
    tokenToggle.textContent = showing ? "show" : "hide";
  });

  function persistTokenIfNeeded() {
    if (rememberToken.checked) {
      localStorage.setItem(LOCAL_KEY_TOKEN, tokenInput.value);
    } else {
      localStorage.removeItem(LOCAL_KEY_TOKEN);
    }
  }

  // ---------- dropzone ----------

  function setSelectedFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      showSubmitError("Please choose a .zip file.");
      return;
    }
    selectedFile = file;
    selectedFileEl.textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`;
    selectedFileEl.classList.remove("hidden");
    updateBuildBtnState();
  }

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => setSelectedFile(e.target.files[0]));

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag-over");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag-over");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    setSelectedFile(file);
  });

  function updateBuildBtnState() {
    buildBtn.disabled = !(selectedFile && tokenInput.value.trim().length > 0);
  }
  tokenInput.addEventListener("input", updateBuildBtnState);

  function showSubmitError(msg) {
    submitError.textContent = msg;
    submitError.classList.remove("hidden");
  }
  function clearSubmitError() {
    submitError.classList.add("hidden");
    submitError.textContent = "";
  }

  // ---------- history (persisted per-browser in localStorage) ----------

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_KEY_HISTORY)) || [];
    } catch (e) {
      return [];
    }
  }
  function saveHistory(list) {
    localStorage.setItem(LOCAL_KEY_HISTORY, JSON.stringify(list.slice(0, 100)));
  }
  function upsertHistoryRecord(record) {
    const list = loadHistory();
    const idx = list.findIndex((r) => r.id === record.id);
    if (idx === -1) list.unshift(record);
    else list[idx] = { ...list[idx], ...record };
    saveHistory(list);
    renderHistory();
  }

  function statusLabel(status) {
    const map = {
      "in-queue": "queued",
      new: "queued",
      "in-progress": "building",
      finished: "finished",
      errored: "error",
      error: "error",
    };
    return map[status] || status;
  }
  function gaugeClass(status) {
    if (status === "finished") return "finished";
    if (status === "errored" || status === "error") return "error";
    if (status === "in-progress") return "building";
    return "";
  }

  function renderHistory() {
    const list = loadHistory();
    historyList.innerHTML = "";
    if (list.length === 0) {
      historyList.appendChild(historyEmpty);
      return;
    }
    list.forEach((rec) => {
      const li = document.createElement("li");
      li.className = "history-item";
      const label = statusLabel(rec.status);
      const time = new Date(rec.createdAt).toLocaleString();
      li.innerHTML = `
        <div class="history-top">
          <span class="history-name">${escapeHtml(rec.filename || "project.zip")}</span>
          <span class="history-time">${time}</span>
        </div>
        <div class="gauge-track"><div class="gauge-fill ${gaugeClass(rec.status)}"></div></div>
        <div class="history-bottom">
          <span class="status-badge ${rec.status}">${label}</span>
          <span class="history-links">
            ${rec.pageUrl ? `<a href="${rec.pageUrl}" target="_blank" rel="noopener">build log</a>` : ""}
            ${rec.downloadUrl ? `<a href="${rec.downloadUrl}" target="_blank" rel="noopener">download APK</a>` : ""}
          </span>
        </div>
        ${rec.error ? `<div class="history-error-msg">${escapeHtml(rec.error)}</div>` : ""}
      `;
      historyList.appendChild(li);
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- polling ----------

  function pollBuild(record, token) {
    if (!record.expoBuildId || activePolls.has(record.expoBuildId)) return;
    activePolls.add(record.expoBuildId);

    const tick = async () => {
      try {
        const res = await fetch(
          `/api/build/${record.expoBuildId}/status?token=${encodeURIComponent(token)}`
        );
        const data = await res.json();
        if (!res.ok) {
          upsertHistoryRecord({ ...record, status: "error", error: JSON.stringify(data.error) });
          activePolls.delete(record.expoBuildId);
          return;
        }
        upsertHistoryRecord({
          ...record,
          status: data.status,
          downloadUrl: data.downloadUrl || null,
          pageUrl: data.logsUrl || record.pageUrl,
          error: data.error ? JSON.stringify(data.error) : null,
        });
        if (data.status === "finished" || data.status === "errored") {
          activePolls.delete(record.expoBuildId);
          return;
        }
      } catch (e) {
        // transient network hiccup; keep trying
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
  }

  function resumePendingPolls() {
    const token = tokenInput.value.trim();
    if (!token) return;
    loadHistory()
      .filter((r) => r.expoBuildId && r.status !== "finished" && r.status !== "errored" && r.status !== "error")
      .forEach((r) => pollBuild(r, token));
  }

  // ---------- submit ----------

  buildBtn.addEventListener("click", async () => {
    clearSubmitError();
    const token = tokenInput.value.trim();
    if (!token || !selectedFile) return;

    persistTokenIfNeeded();

    buildBtn.disabled = true;
    buildBtn.textContent = "Uploading to EAS Build…";

    const formData = new FormData();
    formData.append("expoToken", token);
    formData.append("packageName", packageInput.value.trim());
    formData.append("projectZip", selectedFile);

    try {
      const res = await fetch("/api/build", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        showSubmitError(data.error || "Build submission failed.");
        upsertHistoryRecord(data);
        return;
      }
      upsertHistoryRecord(data);
      pollBuild(data, token);

      // reset the form for the next build
      selectedFile = null;
      fileInput.value = "";
      selectedFileEl.classList.add("hidden");
    } catch (err) {
      showSubmitError("Couldn't reach the build server: " + err.message);
    } finally {
      buildBtn.textContent = "Send to EAS Build";
      updateBuildBtnState();
    }
  });

  renderHistory();
  resumePendingPolls();
})();
