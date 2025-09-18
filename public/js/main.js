// public/js/main.js
console.log(">>> main.js loaded <<<");

// --- глобальный перехватчик 401 для fetch ---
(() => {
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const res = await origFetch(...args);

    if (res && res.status === 401) {
      let msg = "Сессия истекла. Войдите заново.";
      try {
        const clone = res.clone();
        const data = await clone.json().catch(() => null);
        if (data?.message) msg = data.message;
      } catch (_) {}

      if (window.Swal) {
        try {
          await Swal.fire("Требуется вход", msg, "warning");
        } catch (_) {}
      }
      window.location.href = "/login";
      throw new Error("UNAUTHORIZED_401");
    }

    return res;
  };
})();

document.addEventListener("DOMContentLoaded", () => {
  const socket = io();

  // ====== BACKEND ENDPOINTS ======
  const URL_UPLOAD = "/customer/upload";
  const URL_START = "/customer/start-sending";
  const URL_STOP = "/customer/stop-sending";

  // ====== DOM: WhatsApp ======
  const whatsappStatusText = document.getElementById("whatsapp-status-text");
  const whatsappStatusValue = document.getElementById("whatsapp-status-value");
  const connectBtn = document.getElementById("connect-whatsapp-btn");
  const deleteBtn = document.getElementById("delete-session-btn");
  const howtoLink = document.getElementById("wa-howto-link");
  const howtoModal = document.getElementById("howto-modal");
  const qrModal = document.getElementById("qr-modal");
  const qrContainer = document.getElementById("qr-code-container");
  const qrTimerText = document.getElementById("qr-timer-text");
  const closeModalBtn = qrModal ? qrModal.querySelector(".close-button") : null;

  // ====== DOM: Upload ======
  const fileArea = document.getElementById("file-upload-area");
  const uploadHowtoLink = document.getElementById("upload-howto-link");
  const uploadHowtoModal = document.getElementById("upload-howto-modal");
  const uploadHowtoClose = uploadHowtoModal ? uploadHowtoModal.querySelector(".close-button") : null;
  const fileInput = document.getElementById("clients-file-input");
  const fileHint = document.getElementById("file-upload-hint");
  const fileNameDisplay = document.getElementById("fileNameDisplay");
  const uploadStatusIcon = document.getElementById("upload-status-icon");
  const purgeBtn = document.getElementById("purge-clients-btn");
  const purgeHint = document.getElementById("purge-clients-hint");

  // ====== DOM: Параметры рассылки ======
  const timezoneSelect = document.getElementById("timezone-select");
  const tzStatusIcon = document.getElementById("timezone-status-icon");
  const bottomBar = document.querySelector(".fixed-bottom-bar");
  const msgTemplate = document.getElementById("message-template");
  const msgCounter = document.getElementById("message-counter");
  const emojiBtn = document.getElementById("emoji-btn");
  const emojiPicker = document.getElementById("emoji-picker");
  const messageCardStatusIcon = document.getElementById("message-card-status-icon");
  const addressingRadios = Array.from(document.querySelectorAll('input[name="addressingOption"]'));
  const addressingAndDelayIcon = document.getElementById("addressing-and-delay-status-icon");
  const msgCountRadios = Array.from(document.querySelectorAll('input[name="msgCount"]'));

  // ====== DOM: Управление рассылкой и прогресс ======
  const startBtn = document.getElementById("start-btn");
  const stopBtn = document.getElementById("stop-btn");
  const overallStatusText = document.getElementById("overall-status-text");

  const noticeBox = document.getElementById("campaign-notice");
  const noticeText = document.getElementById("campaign-notice-text");

  const progressBarFills = Array.from(document.querySelectorAll(".progress-bar-fill"));
  const progressLabel = document.getElementById("progress-bar-label");
  const totalFooter = document.getElementById("total-count-footer");
  const sentFooter = document.getElementById("sent-count-footer");
  const pendingFooter = document.getElementById("pending-count-footer");
  const failedFooter = document.getElementById("failed-count-footer");

  // ====== DOM: Alert banner (красная плашка) ======
  const alertBanner = document.getElementById("campaign-alert");
  const alertText = document.getElementById("campaign-alert-text");

  // ====== STATE ======
  let currentStatus = "closed"; // whatsapp
  let qrTimerInterval = null;
  let manualConnectRequested = false;
  let isFirstQr = true;

  // загрузка файла
  let uploadCompleted = false;
  let stopNotifyShown = false;

  // кампания
  let isCampaignActive = false;
  let campaignId = null; // ID из планировщика

  let schedulerPauseActive = false;
  const LS_SCHEDULER_PAUSE = "scheduler_pause_active"; // "1" | "0"
  const LS_RISK_PAUSE_UNTIL = "risk_pause_until_ts"; // timestamp ms

  // прогресс
  const MSG_MAXLEN = 2000;
  let totalCount = 0;
  let sentCount = 0;
  let failedCount = 0;
  let maxClients = null;

  // ====== UTILS ======
  const show = (el, display = "inline-flex") => {
    if (el) {
      el.style.display = display;
      el.hidden = false;
    }
  };
  const hide = (el) => {
    if (el) {
      el.style.display = "none";
      el.hidden = true;
    }
  };
  const setDisabled = (el, v) => {
    const apply = (node, disabled) => {
      if (!node) return;
      // если это кнопка/инпут — используем стандартный disabled
      if ("disabled" in node) {
        node.disabled = !!disabled;
      }
      // универсально для любых элементов
      if (disabled) {
        node.classList.add("is-disabled");
        node.setAttribute("aria-disabled", "true");
        node.style.pointerEvents = "none";
      } else {
        node.classList.remove("is-disabled");
        node.removeAttribute("aria-disabled");
        node.style.pointerEvents = "";
      }
    };

    if (Array.isArray(el)) {
      el.forEach((n) => apply(n, v));
    } else {
      apply(el, v);
    }
  };

  function openHowto() {
    howtoModal?.classList.add("is-open");
    howtoModal?.setAttribute("aria-hidden", "false");
  }
  function closeHowto() {
    howtoModal?.classList.remove("is-open");
    howtoModal?.setAttribute("aria-hidden", "true");
  }

  howtoLink?.addEventListener("click", (e) => {
    e.preventDefault();
    openHowto();
  });

  howtoModal?.addEventListener("click", (e) => {
    const t = e.target;
    if (t && (t.dataset.close === "1" || t.classList.contains("howto-modal__backdrop"))) {
      closeHowto();
    }
  });

  uploadHowtoLink?.addEventListener("click", () => {
    if (uploadHowtoModal) uploadHowtoModal.style.display = "block";
  });

  uploadHowtoClose?.addEventListener("click", () => {
    if (uploadHowtoModal) uploadHowtoModal.style.display = "none";
  });

  window.addEventListener("click", (e) => {
    if (e.target === uploadHowtoModal && uploadHowtoModal) {
      uploadHowtoModal.style.display = "none";
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && howtoModal?.classList.contains("is-open")) closeHowto();
  });

  function showNotice(html, kind = "info") {
    if (!noticeBox || !noticeText) return;
    noticeText.innerHTML = html;
    noticeBox.classList.remove("info", "warn", "pause");
    noticeBox.classList.add(kind);
    noticeBox.hidden = false;
    noticeBox.style.display = "block";
  }
  function hideNotice() {
    if (!noticeBox || !noticeText) return;
    noticeText.innerHTML = "";
    noticeBox.hidden = true;
    noticeBox.style.display = "none";
  }

  // === Счётчик длины сообщения
  if (msgTemplate && msgCounter) {
    const updateLocalCounter = () => {
      const len = (msgTemplate.value || "").length;
      msgCounter.textContent = `${len} / ${MSG_MAXLEN}`;
      msgCounter.style.color = len >= MSG_MAXLEN ? "red" : "";
    };
    msgTemplate.addEventListener("input", updateLocalCounter);
    updateLocalCounter();
  }

  function updateMsgCounter() {
    if (!msgCounter || !msgTemplate) return;
    const len = (msgTemplate.value || "").length;
    msgCounter.textContent = `${len} / ${MSG_MAXLEN}`;
    if (len > MSG_MAXLEN) msgCounter.classList.add("over");
    else msgCounter.classList.remove("over");
  }
  function enforceMessageLimit(e) {
    if (!msgTemplate) return;
    let v = msgTemplate.value || "";
    if (v.length > MSG_MAXLEN) {
      msgTemplate.value = v.slice(0, MSG_MAXLEN);
      if (e && typeof e.preventDefault === "function") e.preventDefault();
      if (window.Swal) {
        Swal.fire("Слишком длинно", `Максимум ${MSG_MAXLEN} символов. Лишнее было обрезано.`, "warning");
      } else {
        alert(`Слишком длинно. Максимум ${MSG_MAXLEN} символов. Лишнее было обрезано.`);
      }
    }
    updateMsgCounter();
  }

  msgTemplate?.addEventListener("input", enforceMessageLimit);

  const setIconConnected = (iconEl, connected) => {
    if (!iconEl) return;
    iconEl.classList.remove("status-connected", "status-disconnected");
    iconEl.classList.add(connected ? "status-connected" : "status-disconnected");
    const i = iconEl.querySelector("i");
    if (i) {
      i.classList.remove("fa-check-circle", "fa-times-circle");
      i.classList.add(connected ? "fa-check-circle" : "fa-times-circle");
    }
  };
  const swal = (title, text, icon = "info") => {
    if (window.Swal) return Swal.fire(title, text, icon);
    alert(`${title}\n\n${text}`);
  };

  function showAlert(htmlText) {
    if (!alertBanner || !alertText) return;
    alertText.innerHTML = htmlText;
    alertBanner.style.display = "block";
  }
  function hideAlert() {
    if (!alertBanner) return;
    alertBanner.style.display = "none";
    if (alertText) alertText.innerHTML = "";
  }

  (function syncBottomBarHeight() {
    if (bottomBar) {
      const h = bottomBar.offsetHeight || 72;
      document.documentElement.style.setProperty("--bottom-bar-h", `${h}px`);
    }
  })();

  function scrollToBottomBar() {
    if (bottomBar?.scrollIntoView) {
      bottomBar.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    setTimeout(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
    }, 50);
  }

  emojiBtn?.addEventListener("click", () => {
    if (!emojiPicker) return;
    const willShow = emojiPicker.style.display !== "block";
    emojiPicker.style.display = willShow ? "block" : "none";

    if (willShow) {
      scrollToBottomBar();
      msgTemplate?.focus();
    }
  });

  emojiPicker?.addEventListener("emoji-click", (event) => {
    const emoji = event.detail?.unicode || "";
    if (!emoji || !msgTemplate) return;

    if (typeof msgTemplate.selectionStart === "number") {
      const { selectionStart: start, selectionEnd: end, value: v } = msgTemplate;
      msgTemplate.value = v.slice(0, start) + emoji + v.slice(end);
      const pos = start + emoji.length;
      msgTemplate.selectionStart = msgTemplate.selectionEnd = pos;
      msgTemplate.focus();
    } else {
      msgTemplate.value += emoji;
    }

    msgTemplate.dispatchEvent(new Event("input"));
    emojiPicker.style.display = "none";
  });

  // ====== ЛОГИКА ГОТОВНОСТИ UI ======
  function getSelectedRadioValue(list) {
    const el = list.find((r) => r && r.checked);
    return el ? el.value : null;
  }

  function allParamsReady() {
    const waReady = currentStatus === "open" || currentStatus === "connected";
    const tzReady = !!timezoneSelect?.value;
    const msgReady = !!msgTemplate?.value?.trim() && /\(\(\s*клиент\s*\)\)/i.test(msgTemplate.value || "");
    const addressing =
      getSelectedRadioValue(addressingRadios) ||
      document.querySelector('input[name="addressingOption"]:checked')?.value;
    const countVal =
      getSelectedRadioValue(msgCountRadios) || document.querySelector('input[name="msgCount"]:checked')?.value;

    const addrReady = !!addressing;
    const countReady = !!countVal;
    const uploadReady = !!uploadCompleted;
    return waReady && tzReady && msgReady && addrReady && countReady && uploadReady;
  }

  function updateOverallReadyState() {
    if (!overallStatusText) return;
    if (isCampaignActive) return;

    const ready = allParamsReady();

    if (msgCounter && msgTemplate) {
      msgCounter.textContent = `${(msgTemplate.value || "").length} / ${MSG_MAXLEN}`;
    }

    if (ready) {
      overallStatusText.textContent = "Готов";
      overallStatusText.classList.add("status-text-ready");
      overallStatusText.classList.remove("status-text-running");
    } else {
      overallStatusText.textContent = "Не готов";
      overallStatusText.classList.remove("status-text-ready", "status-text-running");
    }

    setDisabled(startBtn, !ready);
    setDisabled(stopBtn, true);
  }

  function markAddressingAndDelay() {
    const okAddr = !!getSelectedRadioValue(addressingRadios);
    const okCount = !!getSelectedRadioValue(msgCountRadios);
    setIconConnected(addressingAndDelayIcon, okAddr && okCount);
  }

  // ====== QUIET HOURS (21:00–10:00 по TZ) ======
  function parseTzOffsetHours(tzStr) {
    if (!tzStr || typeof tzStr !== "string") return null;
    const s = tzStr.trim().toUpperCase();
    // поддержка: "UTC+3", "GMT-4", "UTC +5", "+3", "-5", "3"
    const m = s.match(/^(?:(?:UTC|GMT)\s*)?([+-]?\d{1,2})$/);
    if (!m) return null;
    const off = parseInt(m[1], 10);
    // типичный рабочий диапазон смещений
    if (!Number.isFinite(off) || off < -12 || off > 14) return null;
    return off;
  }
  function isQuietHoursNow(tzStr) {
    const off = parseTzOffsetHours(tzStr);
    if (off == null || !Number.isFinite(off)) return false;
    const nowUtc = new Date();
    const local = new Date(nowUtc.getTime() + off * 3600 * 1000);
    const h = local.getUTCHours();
    return h >= 21 || h < 10;
  }

  let quietHoursTimer = null;
  function updateQuietHoursBanner() {
    const tz = timezoneSelect?.value || null;
    const qh = tz ? isQuietHoursNow(tz) : false;

    if (isCampaignActive && qh) {
      // показываем только если нет более приоритетных пауз
      if (!riskPauseActive && !schedulerPauseActive) {
        showNotice(
          "Рассылка приостановлена с 21:00 до 10:00 (тихие часы).<br>После этого времени она продолжится автоматически.",
          "warn"
        );
      }
    } else {
      // скрываем, если нет других активных пауз
      if (!riskPauseActive && !schedulerPauseActive) {
        hideNotice();
      }
    }
  }
  function startQuietHoursWatcher() {
    clearInterval(quietHoursTimer);
    quietHoursTimer = setInterval(updateQuietHoursBanner, 30 * 1000);
    updateQuietHoursBanner();
  }

  // ====== RISK-PAUSE (локальный 24ч обратный отсчёт) ======
  let riskPauseActive = false;
  let riskPauseTimer = null;
  let riskPauseRemainingSec = 0;

  function formatHMS(totalSec) {
    const s = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const parts = [];
    if (h > 0)
      parts.push(
        `${h} час${h % 10 === 1 && h !== 11 ? "" : h % 10 >= 2 && h % 10 <= 4 && (h < 10 || h > 20) ? "а" : "ов"}`
      );
    if (m > 0)
      parts.push(
        `${m} минут${m % 10 === 1 && m !== 11 ? "а" : m % 10 >= 2 && m % 10 <= 4 && (m < 10 || m > 20) ? "ы" : ""}`
      );
    parts.push(
      `${sec} секунд${
        sec % 10 === 1 && sec !== 11 ? "а" : sec % 10 >= 2 && sec % 10 <= 4 && (sec < 10 || sec > 20) ? "ы" : ""
      }`
    );
    return parts.join(" ");
  }

  function updateRiskPauseBanner() {
    if (!riskPauseActive) return;
    const until = readRiskPauseUntil();
    const remainMs = until - Date.now();
    if (remainMs <= 0) {
      stopRiskPause();
      updateQuietHoursBanner();
      return;
    }
    const remainSec = Math.ceil(remainMs / 1000);
    const txt =
      `Риск-пауза на ${formatHMS(remainSec)}.<br>` +
      `Это снижает риск блокировки номера. По окончании рассылка продолжится автоматически.`;
    showNotice(txt, "pause");
  }

  function startRiskPause(seconds) {
    riskPauseActive = true;
    const sec = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 24 * 3600;
    const until = Date.now() + sec * 1000;
    persistRiskPauseUntil(until);
    clearInterval(riskPauseTimer);
    riskPauseTimer = setInterval(updateRiskPauseBanner, 1000);
    updateRiskPauseBanner();
  }

  function stopRiskPause() {
    riskPauseActive = false;
    clearInterval(riskPauseTimer);
    riskPauseTimer = null;
    clearRiskPausePersist();
    if (!schedulerPauseActive) hideNotice();
    updateQuietHoursBanner();
  }

  function persistSchedulerPause(active) {
    schedulerPauseActive = !!active;
    try {
      localStorage.setItem(LS_SCHEDULER_PAUSE, active ? "1" : "0");
    } catch (_) {}
  }
  function readSchedulerPause() {
    try {
      return localStorage.getItem(LS_SCHEDULER_PAUSE) === "1";
    } catch (_) {
      return false;
    }
  }

  function persistRiskPauseUntil(tsMs) {
    try {
      localStorage.setItem(LS_RISK_PAUSE_UNTIL, String(tsMs || ""));
    } catch (_) {}
  }
  function readRiskPauseUntil() {
    try {
      const v = localStorage.getItem(LS_RISK_PAUSE_UNTIL);
      const n = v ? Number(v) : 0;
      return Number.isFinite(n) ? n : 0;
    } catch (_) {
      return 0;
    }
  }
  function clearRiskPausePersist() {
    try {
      localStorage.removeItem(LS_RISK_PAUSE_UNTIL);
    } catch (_) {}
  }

  // === SETTINGS: загрузка и автосейв ===
  function applySettingsToUI(s) {
    if (timezoneSelect && typeof s.timezone === "string") {
      timezoneSelect.value = s.timezone;
      setIconConnected(tzStatusIcon, !!timezoneSelect.value);
    }
    if (msgTemplate && typeof s.message_draft === "string") {
      msgTemplate.value = s.message_draft;
      const valid = !!msgTemplate.value.trim() && /\(\(\s*клиент\s*\)\)/i.test(msgTemplate.value);
      setIconConnected(messageCardStatusIcon, valid);
    }
    if (Array.isArray(addressingRadios) && s.addressing_option) {
      const el = addressingRadios.find((r) => r.value === s.addressing_option);
      if (el) el.checked = true;
    }
    if (Array.isArray(msgCountRadios) && s.daily_limit_pref != null) {
      const el = msgCountRadios.find((r) => Number(r.value) === Number(s.daily_limit_pref));
      if (el) el.checked = true;
    }
    updateOverallReadyState();
    updateQuietHoursBanner();
  }

  async function loadSettings() {
    try {
      const cache = JSON.parse(localStorage.getItem("wa_settings") || "null");
      if (cache) applySettingsToUI(cache);
    } catch (_) {}

    try {
      const r = await fetch("/customer/settings", { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (r.ok && d?.success && d.data) {
        applySettingsToUI(d.data);
        localStorage.setItem("wa_settings", JSON.stringify(d.data));
      }
    } catch (_) {}
  }

  let settingsSaveTimer = null;
  function queueSaveSettings() {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(saveSettings, 500);
  }
  async function saveSettings() {
    const payload = {
      timezone: timezoneSelect?.value || null,
      message_draft: msgTemplate?.value || "",
      addressing_option: document.querySelector('input[name="addressingOption"]:checked')?.value || "auto",
      daily_limit_pref: Number(document.querySelector('input[name="msgCount"]:checked')?.value) || null,
      max_clients_pref: null,
    };
    localStorage.setItem("wa_settings", JSON.stringify(payload));
    try {
      await fetch("/customer/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (_) {}
    updateQuietHoursBanner();
  }

  timezoneSelect?.addEventListener("change", () => {
    setIconConnected(tzStatusIcon, !!timezoneSelect.value);
    updateOverallReadyState();
    updateQuietHoursBanner();
  });

  msgTemplate?.addEventListener("input", (e) => {
    queueSaveSettings();
    updateOverallReadyState();
  });

  addressingRadios.forEach((r) =>
    r.addEventListener("change", () => {
      queueSaveSettings();
      updateOverallReadyState();
    })
  );
  msgCountRadios.forEach((r) =>
    r.addEventListener("change", () => {
      queueSaveSettings();
      updateOverallReadyState();
    })
  );

  // === CAMPAIGN SNAPSHOT ===
  async function bootstrapCampaignState() {
    try {
      const r = await fetch("/customer/campaign/state", { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.success) return;

      maxClients = Number.isFinite(Number(d.max_clients)) ? Number(d.max_clients) : null;

      updateUI(d.whatsapp?.state || "closed");

      const c = d.campaign;
      if (!c) return;
      if (c.campaignId && !campaignId) campaignId = c.campaignId;

      setCounts({
        total: c.total || 0,
        sent: c.sent || 0,
        remaining: c.remaining != null ? c.remaining : Math.max(0, (c.total || 0) - (c.sent || 0)),
        failed: c.failed || 0,
      });

      const s = c.status || "stopped";
      if (s === "running") {
        isCampaignActive = true;
        overallStatusText && (overallStatusText.textContent = "В процессе. Сообщения отправляются каждые 30–160 сек.");
        overallStatusText && overallStatusText.classList.add("status-text-running");
        setDisabled(startBtn, true);
        setDisabled(stopBtn, false);
        lockMain();
        restoreNoticesFromStorage();
      } else if (String(s).startsWith("paused_")) {
        isCampaignActive = true;
        overallStatusText && (overallStatusText.textContent = "На паузе");
        setDisabled(startBtn, true);
        setDisabled(stopBtn, false);
        lockMain();
        restoreNoticesFromStorage();
      } else if (s === "completed") {
        isCampaignActive = false;
        campaignId = null;
        overallStatusText && (overallStatusText.textContent = "Завершено");
        setDisabled(startBtn, false);
        setDisabled(stopBtn, true);
        unlockMain();
      } else {
        isCampaignActive = false;
        campaignId = null;
        overallStatusText && (overallStatusText.textContent = "Остановлено");
        setDisabled(startBtn, false);
        setDisabled(stopBtn, true);
        unlockMain();
      }
    } catch (_) {}
  }

  // ====== WHATSAPP UI ======
  function updateUI(status, qrCodeString = null) {
    currentStatus = status;

    let statusText;
    let statusClass;

    if (status === "open" || status === "connected") {
      statusText = "Подключено";
      statusClass = "wa-status-connected";
      hideAlert();
    } else if (status === "qr") {
      statusText = "Ожидание QR-кода";
      statusClass = "wa-status-waiting";
    } else if (status === "logged_out") {
      // <- отдельная ветка: считаем как "отключен, требуется вход"
      statusText = "Требуется вход";
      statusClass = "wa-status-disconnected";
    } else if (status === "connecting" || status === "loading" || status === "reconnecting") {
      statusText = "Подключение...";
      statusClass = "wa-status-connecting";
    } else {
      statusText = "Не подключен";
      statusClass = "wa-status-disconnected";
      if (!isCampaignActive) hideAlert();
    }

    if (whatsappStatusText) {
      const valueEl = typeof whatsappStatusValue !== "undefined" ? whatsappStatusValue : null;
      const target = valueEl || whatsappStatusText;

      if (valueEl) valueEl.textContent = statusText;
      else whatsappStatusText.innerHTML = "Статус: " + statusText;

      target.classList.remove(
        "wa-status-connected",
        "wa-status-disconnected",
        "wa-status-waiting",
        "wa-status-connecting"
      );
      target.classList.add(statusClass);
    }

    // Кнопки
    if (status === "open" || status === "connected") {
      hide(connectBtn);
      show(deleteBtn);
      setDisabled(deleteBtn, false);
    } else if (status === "qr") {
      show(connectBtn);
      setDisabled(connectBtn, true);
      show(deleteBtn);
      setDisabled(deleteBtn, false);
    } else if (status === "logged_out") {
      // Разрешаем пользователю снова подключиться/удалить сессию
      show(connectBtn);
      setDisabled(connectBtn, false);
      show(deleteBtn);
      setDisabled(deleteBtn, false);
    } else if (status === "connecting" || status === "loading" || status === "reconnecting") {
      show(connectBtn);
      setDisabled(connectBtn, true);
      show(deleteBtn);
      setDisabled(deleteBtn, true);
    } else {
      // closed / не подключен
      show(connectBtn);
      setDisabled(connectBtn, false);
      hide(deleteBtn);
      setDisabled(deleteBtn, false);
    }

    // Модалка QR
    if (manualConnectRequested && (status === "connecting" || status === "loading" || status === "reconnecting")) {
      qrModal?.classList.add("active");
      if (qrContainer) {
        qrContainer.innerHTML = "";
        qrContainer.textContent = "Ожидание QR-кода...";
      }
      return;
    }

    if (status === "qr" && manualConnectRequested) {
      qrModal?.classList.add("active");
      if (qrCodeString) {
        if (qrContainer) {
          qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(
            qrCodeString
          )}" alt="QR Code">`;
        }
      } else {
        if (qrContainer) {
          const url = `/qr.png?ts=${Date.now()}`;
          qrContainer.innerHTML = `<img src="${url}" alt="QR Code">`;
        }
      }
      if (!qrTimerInterval) startQrTimer();
    } else {
      // Для всех статусов, кроме "connecting/loading/reconnecting/qr", закрываем модалку
      if (!["connecting", "loading", "reconnecting", "qr"].includes(status)) {
        qrModal?.classList.remove("active");
        stopQrTimer();
        isFirstQr = true;
      }
    }
  }

  function startQrTimer() {
    let timeLeft = isFirstQr ? 60 : 20;
    isFirstQr = false;
    if (qrTimerText) qrTimerText.textContent = `QR-код обновится через: ${timeLeft} сек`;
    clearInterval(qrTimerInterval);
    qrTimerInterval = setInterval(() => {
      timeLeft--;
      if (timeLeft > 0) {
        if (qrTimerText) qrTimerText.textContent = `QR-код обновится через: ${timeLeft} сек`;
      } else {
        clearInterval(qrTimerInterval);
        qrTimerInterval = null;
        if (qrTimerText) qrTimerText.textContent = "QR-код устарел. Попробуйте снова.";
      }
    }, 1000);
  }

  function stopQrTimer() {
    clearInterval(qrTimerInterval);
    qrTimerInterval = null;
    if (qrTimerText) qrTimerText.textContent = "";
  }

  // ====== WhatsApp: кнопки ======
  connectBtn?.addEventListener("click", async () => {
    manualConnectRequested = true;
    updateUI("connecting");
    qrModal?.classList.add("active");
    if (qrContainer) qrContainer.textContent = "Ожидание QR-кода...";
    try {
      const res = await fetch("/customer/init-whatsapp-client", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!data.success) {
        swal("Ошибка", data.message || "Не удалось запустить WhatsApp", "error");
        manualConnectRequested = false;
        updateUI("closed");
        qrModal?.classList.remove("active");
      } else {
        socket.emit("request_whatsapp_status");
      }
    } catch (err) {
      swal("Ошибка", "Не удалось отправить запрос", "error");
      manualConnectRequested = false;
      updateUI("closed");
      qrModal?.classList.remove("active");
    }
  });

  deleteBtn?.addEventListener("click", () => {
    if (!window.Swal) {
      fetch("/customer/delete-whatsapp-session", { method: "POST", headers: { "Content-Type": "application/json" } });
      return;
    }
    Swal.fire({
      title: "Удалить сессию?",
      text: "После удаления придётся подключить WhatsApp заново.",
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Да, удалить",
      cancelButtonText: "Отмена",
    }).then((result) => {
      if (result.isConfirmed) {
        fetch("/customer/delete-whatsapp-session", { method: "POST", headers: { "Content-Type": "application/json" } });
      }
    });
  });

  closeModalBtn?.addEventListener("click", () => {
    qrModal?.classList.remove("active");
    stopQrTimer();
    manualConnectRequested = false;
    socket.emit("cancel_qr_flow");
    const next = currentStatus === "logged_out" ? "logged_out" : "closed";
    updateUI(next);
  });

  async function autoConnectIfHasSavedSession() {
    try {
      const r = await fetch(`/customer/has-saved-session?ts=${Date.now()}`, { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.success) return;
      if (
        d.exists &&
        (currentStatus === "closed" || currentStatus === "logged_out" || currentStatus === "unauthenticated")
      ) {
        setDisabled(connectBtn, true);
        await fetch("/customer/init-whatsapp-client", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }).catch(() => {});
      }
    } catch {}
  }

  // ====== Socket.IO: WhatsApp ======
  socket.on("connect", () => {
    bootstrapCampaignState()
      .then(() => {
        if (isCampaignActive) {
          startQuietHoursWatcher();
          // при активной кампании восстанавливаем заметки
          restoreNoticesFromStorage();
        } else {
          clearInterval(quietHoursTimer);
          hideAlert();
        }
      })
      .catch(() => {});

    loadSettings();

    socket.emit("request_whatsapp_status");
  });

  socket.on("whatsapp_status", (payload) => {
    const status = payload && payload.state ? payload.state : payload;
    const transient = ["reconnecting", "connecting", "loading"];

    if (status === "qr") {
      // Показываем QR всегда, независимо от manualConnectRequested
      manualConnectRequested = true;
      qrModal?.classList.add("active");
      updateUI("qr");
      return;
    }
    if (transient.includes(status)) {
      if (manualConnectRequested) qrModal?.classList.add("active");
      updateUI("connecting");
      return;
    }
    if (status === "open" || status === "connected") {
      manualConnectRequested = false;
      updateUI("open");
      updateOverallReadyState();
      return;
    }
    if (status === "logged_out") {
      // если юзер сам нажал "Подключиться" — держим модалку открытой
      if (manualConnectRequested) {
        qrModal?.classList.add("active");
        updateUI("connecting");
        return;
      }

      updateUI("logged_out");
      return;
    }
    updateUI("closed");
    updateOverallReadyState();
  });

  // socket.on("wa_status", ({ state }) => {
  //   socket.emit("whatsapp_status", { state });
  // });

  socket.on("wa_status", ({ state }) => {
    updateUI(state);
    updateOverallReadyState();
  });

  socket.on("wa_qr", ({ dataUrl }) => {
    manualConnectRequested = true;
    qrModal?.classList.add("active");
    if (qrContainer) {
      const html = dataUrl ? `<img src="${dataUrl}" alt="QR Code">` : `<span>QR-код готов. Обновите окно.</span>`;
      qrContainer.innerHTML = html;
    }
    if (currentStatus !== "qr") updateUI("qr");
    if (!qrTimerInterval) startQrTimer();
  });

  socket.on("qr_image", (dataUrl) => {
    manualConnectRequested = true;
    qrModal?.classList.add("active");
    if (qrContainer) qrContainer.innerHTML = `<img src="${dataUrl}" alt="QR Code">`;
    if (currentStatus !== "qr") updateUI("qr");
    if (!qrTimerInterval) startQrTimer();
  });
  socket.on("qr_code", (qrString) => {
    manualConnectRequested = true;
    updateUI("qr", qrString);
  });

  socket.on("qr_flow_cancelled", () => {
    manualConnectRequested = false;
    updateUI("closed");
  });

  socket.on("session_deleted_status", (data) => {
    if (data && data.showSwal) {
      swal(
        data.success ? "Удалено!" : "Ошибка",
        data.message || (data.success ? "Сессия удалена" : "Не удалось удалить"),
        data.success ? "success" : "error"
      );
    }
    manualConnectRequested = false;
    updateUI("closed");
    show(connectBtn);
    setDisabled(connectBtn, false);
    hide(deleteBtn);
    updateOverallReadyState();
  });

  // ====== ЗАГРУЗКА ФАЙЛОВ ======
  function sendFile(file) {
    const formData = new FormData();
    formData.append("clientFile", file);

    if (fileNameDisplay) fileNameDisplay.textContent = file.name;
    if (fileHint) fileHint.textContent = `Загрузка: ${file.name} ...`;

    const addressing = document.querySelector('input[name="addressingOption"]:checked')?.value || "first_name";
    formData.append("addressingOption", addressing);

    fetch(URL_UPLOAD, { method: "POST", body: formData })
      .then(async (res) => {
        let data = null;
        try {
          data = await res.json();
        } catch (_) {}
        if (!res.ok || !data) throw new Error((data && data.message) || `Ошибка загрузки (${res.status})`);
        uploadCompleted = true;
        setIconConnected(uploadStatusIcon, true);
        swal("Готово", data.message || "Файл обработан и записан в БД.", "success");
        if (fileHint) fileHint.textContent = "Файл загружен. Можно загрузить следующий.";
        refreshUploadSummary();
        updateOverallReadyState();
        if (fileInput) fileInput.value = "";
      })
      .catch((err) => {
        uploadCompleted = false;
        setIconConnected(uploadStatusIcon, false);
        swal("Ошибка", err.message || "Не удалось загрузить файл", "error");
        if (fileHint) fileHint.textContent = "Ошибка загрузки. Попробуйте снова.";
        if (fileInput) fileInput.value = "";
      });
  }

  fileInput?.addEventListener("click", () => {
    fileInput.value = "";
  });

  fileInput?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) sendFile(file);
  });

  if (fileArea) {
    ["dragenter", "dragover"].forEach((ev) =>
      fileArea.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileArea.classList.add("dragover");
      })
    );
    ["dragleave", "drop"].forEach((ev) =>
      fileArea.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileArea.classList.remove("dragover");
      })
    );
    fileArea.addEventListener("drop", (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) sendFile(file);
    });
  }

  purgeBtn?.addEventListener("click", () => {
    if (!window.Swal) {
      if (!confirm("Вы точно хотите удалить всю базу клиентов? Это действие необратимо.")) return;
      doPurge();
      return;
    }
    Swal.fire({
      title: "Удалить ВСЮ базу клиентов?",
      html: "Это действие <b>необратимо</b>: будут удалены все клиенты и их номера.",
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Да, удалить",
      cancelButtonText: "Отмена",
      confirmButtonColor: "#d33",
    }).then((result) => {
      if (result.isConfirmed) doPurge();
    });
  });

  async function doPurge() {
    try {
      const res = await fetch("/customer/purge-clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.message || `Ошибка удаления (${res.status})`);
      }

      // UI: база пуста — скрываем кнопку удаления, сбрасываем индикаторы
      if (typeof uploadCompleted !== "undefined") uploadCompleted = false;
      setIconConnected && setIconConnected(uploadStatusIcon, false);

      if (fileInput) fileInput.value = "";

      const labelTextEl = document.getElementById("fileUploadLabelText");
      if (labelTextEl) labelTextEl.textContent = "Выберите файл";

      if (fileNameDisplay) fileNameDisplay.textContent = "Файл не выбран";
      if (fileHint) fileHint.textContent = "База пуста. Загрузите Excel (.xlsx или .xls).";

      if (purgeBtn) purgeBtn.style.display = "none";
      if (purgeHint) purgeHint.style.display = "none";

      // Сброс прогресса
      if (typeof setCounts === "function") {
        setCounts({ total: 0, sent: 0, remaining: 0, failed: 0 });
      }

      if (typeof updateOverallReadyState === "function") updateOverallReadyState();

      if (window.Swal) {
        await Swal.fire("Готово", "База клиентов очищена.", "success");
      } else {
        alert("База клиентов очищена.");
      }
    } catch (e) {
      if (window.Swal) {
        await Swal.fire("Не удалось удалить", e.message || "Ошибка удаления", "error");
      } else {
        alert("Не удалось удалить: " + (e.message || "Ошибка удаления"));
      }
    } finally {
      try {
        if (typeof refreshUploadSummary === "function") await refreshUploadSummary();
      } catch (_) {}
    }
  }

  async function refreshUploadSummary() {
    try {
      const res = await fetch("/customer/upload-summary");
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) return;

      if (data.totalPhones > 0) {
        uploadCompleted = true;
        setIconConnected(uploadStatusIcon, true);

        if (fileNameDisplay) {
          fileNameDisplay.textContent = `В базе уже ${data.totalClients} клиентов (${data.totalPhones} телефон(ов)).`;
        }
        const labelTextEl = document.getElementById("fileUploadLabelText");
        if (labelTextEl) labelTextEl.textContent = "Добавить файл";

        if (fileHint) {
          const dt = data.lastUploadAt ? new Date(data.lastUploadAt) : null;
          fileHint.textContent = dt
            ? `Последняя загрузка: ${dt.toLocaleString("ru-RU")}`
            : "Данные уже присутствуют в базе.";
        }
        if (purgeBtn) purgeBtn.style.display = "inline-flex";
        if (purgeHint) purgeHint.style.display = "block";
      } else {
        uploadCompleted = false;
        setIconConnected(uploadStatusIcon, false);
        if (fileNameDisplay) fileNameDisplay.textContent = "Файл не выбран";
        const labelTextEl = document.getElementById("fileUploadLabelText");
        if (labelTextEl) labelTextEl.textContent = "Выберите файл";
        if (purgeBtn) purgeBtn.style.display = "none";
        if (purgeHint) purgeHint.style.display = "none";
      }
      updateOverallReadyState();
    } catch (e) {}
  }

  // ====== ПРОГРЕСС ======
  function setProgress(percent) {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    progressBarFills.forEach((el) => {
      if (el) el.style.width = p + "%";
    });
    if (progressLabel) progressLabel.textContent = p + "%";
  }
  function setCounts({ total, sent, remaining, failed }) {
    totalCount = total ?? totalCount;
    sentCount = sent ?? sentCount;
    failedCount = failed ?? failedCount;
    if (totalFooter) totalFooter.textContent = totalCount;
    if (sentFooter) sentFooter.textContent = sentCount;
    if (pendingFooter)
      pendingFooter.textContent = typeof remaining === "number" ? remaining : Math.max(0, totalCount - sentCount);
    if (failedFooter) failedFooter.textContent = failedCount;
    const percent = totalCount > 0 ? (sentCount / totalCount) * 100 : 0;
    setProgress(percent);
  }

  // ====== Блокировка/разблокировка UI при кампании ======
  function lockMain() {
    document.body.classList.add("campaign-active");
    setDisabled(startBtn, true);
    setDisabled(stopBtn, false);

    setDisabled(fileInput, true);
    if (fileArea) fileArea.classList.add("disabled");
    setDisabled(purgeBtn, true);

    setDisabled(timezoneSelect, true);
    setDisabled(msgTemplate, true);
    setDisabled(emojiBtn, true);
    setDisabled(addressingRadios, true);
    setDisabled(msgCountRadios, true);

    setDisabled(connectBtn, true);
    setDisabled(deleteBtn, true);
  }

  function unlockMain() {
    document.body.classList.remove("campaign-active");
    setDisabled(stopBtn, true);
    setDisabled(startBtn, !allParamsReady());

    setDisabled(fileInput, false);
    if (fileArea) fileArea.classList.remove("disabled");
    setDisabled(purgeBtn, false);

    setDisabled(timezoneSelect, false);
    setDisabled(msgTemplate, false);
    setDisabled(emojiBtn, false);
    setDisabled(addressingRadios, false);
    setDisabled(msgCountRadios, false);

    setDisabled(connectBtn, false);
    setDisabled(deleteBtn, false);

    updateOverallReadyState();
    hideNotice();
    persistSchedulerPause(false);
  }

  // ====== СТАРТ/СТОП РАССЫЛКИ ======
  startBtn?.addEventListener("click", async () => {
    stopNotifyShown = false;

    const { ok, errors, payload } = validateBeforeStart();

    if (!ok) {
      const listHtml =
        `<ul style="text-align:left;margin:0;padding-left:1.2em;">` +
        errors.map((e) => `<li>${e}</li>`).join("") +
        `</ul>`;
      if (window.Swal) {
        return Swal.fire({ title: "Проверьте параметры", html: listHtml, icon: "warning" });
      } else {
        alert("Проверьте параметры:\n- " + errors.join("\n- "));
        return;
      }
    }

    isCampaignActive = true;
    lockMain();
    if (overallStatusText) {
      overallStatusText.textContent = "В процессе. Сообщения отправляются каждые 30–160 сек.";
    }
    setDisabled(startBtn, true);
    setDisabled(stopBtn, false);
    overallStatusText && overallStatusText.classList.remove("status-text-ready");
    overallStatusText && overallStatusText.classList.add("status-text-running");

    setCounts({ total: 0, sent: 0, remaining: 0, failed: 0 });
    startQuietHoursWatcher();

    try {
      const res = await fetch(URL_START, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: payload.msg,
          timezone: payload.tz,
          daily_limit: Number(payload.msgCount),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || `Ошибка запуска (${res.status})`);
      // campaignId придёт через сокет "campaign_started"
    } catch (err) {
      isCampaignActive = false;
      unlockMain();
      setDisabled(startBtn, false);
      setDisabled(stopBtn, true);
      overallStatusText && overallStatusText.classList.remove("status-text-running");
      overallStatusText && overallStatusText.classList.add("status-text-ready");
      if (overallStatusText) overallStatusText.textContent = "Готов";
      swal("Не удалось начать", err.message || "Ошибка запуска рассылки", "error");
      clearInterval(quietHoursTimer);
      hideAlert();
    }
  });

  stopBtn?.addEventListener("click", async () => {
    setDisabled(stopBtn, true);
    try {
      const res = await fetch(URL_STOP, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || `Ошибка остановки (${res.status})`);

      isCampaignActive = false;
      unlockMain();
      setDisabled(startBtn, false);
      setDisabled(stopBtn, true);
      overallStatusText && overallStatusText.classList.remove("status-text-running");
      overallStatusText && overallStatusText.classList.add("status-text-ready");
      if (overallStatusText) overallStatusText.textContent = "Остановлено";
      swal("Остановлено", "Рассылка остановлена", "info");
      stopNotifyShown = true;

      stopRiskPause();
      hideAlert();
      clearInterval(quietHoursTimer);
    } catch (err) {
      setDisabled(stopBtn, false);
      swal("Не удалось остановить", err.message || "Ошибка остановки", "error");
    }
  });

  // ====== ВАЛИДАЦИЯ ПЕРЕД СТАРТОМ ======
  function validateBeforeStart() {
    const errors = [];

    if (!(currentStatus === "open" || currentStatus === "connected")) {
      errors.push("Подключите WhatsApp.");
    }
    if (!uploadCompleted) {
      errors.push("Загрузите файл клиентов (Excel).");
    }
    const tz = timezoneSelect ? timezoneSelect.value : "";
    if (!tz) {
      errors.push("Выберите часовой пояс.");
    }
    const addressing = getSelectedRadioValue(addressingRadios);
    if (!addressing) {
      errors.push("Выберите способ обращения к клиенту.");
    }
    const msgCount = getSelectedRadioValue(msgCountRadios);
    if (!msgCount) {
      errors.push("Выберите количество сообщений в день.");
    }
    const msg = (msgTemplate?.value || "").trim();
    if (!msg) {
      errors.push("Введите текст сообщения.");
    } else if (!/\(\(\s*клиент\s*\)\)/i.test(msg)) {
      errors.push("Сообщение должно содержать плейсхолдер ((клиент)).");
    }

    return { ok: errors.length === 0, errors, payload: { tz, addressing, msgCount, msg } };
  }

  // ====== События кампании (сокеты) ======
  socket.on("campaign_started", ({ campaignId: id, timezone, total }) => {
    campaignId = id || campaignId;
    isCampaignActive = true;
    stopNotifyShown = false;
    if (typeof total === "number") {
      totalCount = total;
      setCounts({ total: totalCount, sent: 0, remaining: totalCount, failed: 0 });
    }
    // статус
    if (overallStatusText) {
      overallStatusText.textContent = "В процессе. Сообщения отправляются каждые 30–160 сек.";
      overallStatusText.classList.add("status-text-running");
    }

    setDisabled(startBtn, true);
    setDisabled(stopBtn, false);
    lockMain();

    // NEW: следим за «тихими часами»
    startQuietHoursWatcher();

    // подтягиваем локально сохранённые notice (паузы от планировщика / риск-паузы)
    restoreNoticesFromStorage();
  });

  socket.on("campaign_stopped", ({ campaignId: id }) => {
    if (!campaignId || (id && id !== campaignId)) return;
    isCampaignActive = false; // NEW
    campaignId = null; // NEW
    unlockMain(); // NEW
    setDisabled(startBtn, !allParamsReady());
    setDisabled(stopBtn, true);
    overallStatusText && overallStatusText.classList.remove("status-text-running");
    overallStatusText && overallStatusText.classList.add("status-text-ready");
    if (overallStatusText) overallStatusText.textContent = "Остановлено";
    if (!stopNotifyShown) {
      if (window.Swal) Swal.fire("Завершено", "Рассылка завершена", "info");
      else alert("Рассылка завершена");
      stopNotifyShown = true;
    }
    stopRiskPause();
    persistSchedulerPause(false);
    hideNotice();
    hideAlert();
    clearInterval(quietHoursTimer);
  });

  socket.on("campaign_progress", ({ campaignId: id, taskId, phoneNumber, msgSendCount, status }) => {
    if (id && campaignId && id !== campaignId) return;
    if (status === "sent") {
      sentCount += 1;
      setCounts({ total: totalCount || sentCount + failedCount, sent: sentCount });
    }
  });

  socket.on("campaign_error", ({ campaignId: id, taskId, phoneNumber, error }) => {
    if (id && campaignId && id !== campaignId) return;
    failedCount += 1;
    setCounts({ total: totalCount || sentCount + failedCount, failed: failedCount });
  });

  // Новое: пауза от микросервиса — только { pausing: true|false }
  socket.on("campaign_pausing", ({ pausing, campaignId: id }) => {
    if (!campaignId || (id && id !== campaignId)) return;
    // помечаем паузу локально (переживет перезагрузку)
    persistSchedulerPause(!!pausing);
    schedulerPauseActive = !!pausing;

    if (pausing === true) {
      // Кампания продолжает существовать, просто временная пауза.
      // НИЧЕГО не трогаем в плане isCampaignActive/lockMain().
      showNotice(
        "Рассылка приостановлена планировщиком (например, тихие часы). " +
          "Она автоматически продолжится, когда ограничения будут сняты.",
        "warn"
      );
      // На всякий случай не прячем другие предупреждения
      // и не трогаем riskPause.
    } else {
      // Снятие паузы — просто убираем баннер и даём UI самому догнаться
      hideNotice();
      updateQuietHoursBanner();
    }
  });

  socket.on("update_progress", ({ total, sent, remaining }) => {
    setCounts({ total, sent, remaining, failed: failedCount });
  });

  // Когда мы обрезали получателей на старте из-за лимита
  socket.on("campaign_trimmed_by_limit", ({ allowed, trimmed, limit, used }) => {
    if (!window.Swal) return;
    Swal.fire({
      icon: "warning",
      title: "Ограничение тарифа",
      html:
        `Запрошено отправить слишком много сообщений для текущего тарифа.<br>` +
        `Будет отправлено: <b>${allowed}</b>. Обрезано: <b>${trimmed}</b>.<br>` +
        (typeof limit === "number" ? `Лимит: ${used || 0}/${limit}.` : ""),
    });
  });

  // Когда лимит был исчерпан во время рассылки
  socket.on("campaign_limit_exhausted", ({ limit, used }) => {
    if (window.Swal) {
      Swal.fire({
        icon: "info",
        title: "Лимит исчерпан",
        html:
          `Достигнут лимит тарифа: <b>${used || 0}/${limit || "—"}</b>.<br>` +
          `Отправка остановлена. Выберите более высокий тарифный план, чтобы продолжить.`,
      });
    }
    stopNotifyShown = true;
  });

  // ====== восстановление notice из localStorage ======
  function restoreNoticesFromStorage() {
    // Восстановить паузу от планировщика
    schedulerPauseActive = readSchedulerPause();

    if (schedulerPauseActive && isCampaignActive) {
      showNotice(
        "Рассылка приостановлена планировщиком (например, тихие часы). " +
          "Она автоматически продолжится, когда ограничения будут сняты.",
        "warn"
      );
    }

    // Восстановить риск-паузу
    const until = readRiskPauseUntil();
    if (until > Date.now()) {
      // включаем локальный таймер, но показываем только если кампания активна
      riskPauseActive = true;
      clearInterval(riskPauseTimer);
      riskPauseTimer = setInterval(updateRiskPauseBanner, 1000);
      // если рассылка уже активна, сразу отрисуем
      if (isCampaignActive) updateRiskPauseBanner();
    }
  }

  // ====== стартовое состояние ======
  updateUI("closed");
  setIconConnected(tzStatusIcon, !!timezoneSelect?.value);
  const validMsg = !!msgTemplate?.value?.trim() && /\(\(\s*клиент\s*\)\)/i.test(msgTemplate.value || "");
  setIconConnected(messageCardStatusIcon, validMsg);
  updateOverallReadyState();
  markAddressingAndDelay();
  autoConnectIfHasSavedSession();
  refreshUploadSummary();
  restoreNoticesFromStorage();
});
