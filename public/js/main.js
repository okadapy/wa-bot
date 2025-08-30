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
  const qrModal = document.getElementById("qr-modal");
  const qrContainer = document.getElementById("qr-code-container");
  const qrTimerText = document.getElementById("qr-timer-text");
  const closeModalBtn = qrModal ? qrModal.querySelector(".close-button") : null;

  // ====== DOM: Upload ======
  const fileArea = document.getElementById("file-upload-area");
  const fileInput = document.getElementById("clients-file-input");
  const fileHint = document.getElementById("file-upload-hint");
  const fileNameDisplay = document.getElementById("fileNameDisplay");
  const uploadStatusIcon = document.getElementById("upload-status-icon");

  // ====== DOM: Параметры рассылки ======
  const timezoneSelect = document.getElementById("timezone-select");
  const tzStatusIcon = document.getElementById("timezone-status-icon");
  const msgTemplate = document.getElementById("message-template");
  const messageCardStatusIcon = document.getElementById("message-card-status-icon");
  const addressingRadios = Array.from(document.querySelectorAll('input[name="addressingOption"]'));
  const addressingAndDelayIcon = document.getElementById("addressing-and-delay-status-icon");
  const msgCountRadios = Array.from(document.querySelectorAll('input[name="msgCount"]'));
  const delayRadios = Array.from(document.querySelectorAll('input[name="delay"]'));

  // ====== DOM: Управление рассылкой и прогресс ======
  const startBtn = document.getElementById("start-btn");
  const stopBtn = document.getElementById("stop-btn");
  const overallStatusText = document.getElementById("overall-status-text");

  const progressBarFills = Array.from(document.querySelectorAll(".progress-bar-fill"));
  const progressLabel = document.getElementById("progress-bar-label");
  const totalFooter = document.getElementById("total-count-footer");
  const sentFooter = document.getElementById("sent-count-footer");
  const pendingFooter = document.getElementById("pending-count-footer");
  const failedFooter = document.getElementById("failed-count-footer");

  // ====== DOM: ETA ======
  const etaEl = document.getElementById("next-send-timer");

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
  let campaignId = null; // <— ID из планировщика

  // прогресс
  let totalCount = 0;
  let sentCount = 0;
  let failedCount = 0;

  // ETA
  let etaSeconds = 0;
  let etaInterval = null;

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
    if (el) el.disabled = !!v;
  };

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

  // ====== ETA helpers ======
  const setEtaLabel = (sec) => {
    if (!etaEl) return;
    if (typeof sec !== "number" || sec <= 0) etaEl.textContent = "";
    else etaEl.textContent = `${sec} сек`;
  };

  const clearEtaCountdown = () => {
    if (etaInterval) {
      clearInterval(etaInterval);
      etaInterval = null;
    }
    etaSeconds = 0;
    setEtaLabel(0);
  };

  const startEtaCountdown = (seconds) => {
    clearEtaCountdown();
    if (!Number.isFinite(seconds) || seconds <= 0) {
      setEtaLabel(0);
      return;
    }
    etaSeconds = Math.ceil(seconds);
    setEtaLabel(etaSeconds);
    etaInterval = setInterval(() => {
      etaSeconds -= 1;
      if (etaSeconds > 0) setEtaLabel(etaSeconds);
      else clearEtaCountdown();
    }, 1000);
  };

  function allParamsReady() {
    const waReady = currentStatus === "open" || currentStatus === "connected";
    const tzReady = !!timezoneSelect?.value;
    const msgReady = !!msgTemplate?.value?.trim() && /\(\(\s*клиент\s*\)\)/i.test(msgTemplate.value || "");
    const addressing = getSelectedRadioValue
      ? getSelectedRadioValue(addressingRadios)
      : document.querySelector('input[name="addressingOption"]:checked')?.value;
    const countVal = getSelectedRadioValue
      ? getSelectedRadioValue(msgCountRadios)
      : document.querySelector('input[name="msgCount"]:checked')?.value;
    // задержка теперь не обязательна (тайминг делает планировщик)
    const addrReady = !!addressing;
    const countReady = !!countVal;
    const uploadReady = !!uploadCompleted;
    return waReady && tzReady && msgReady && addrReady && countReady && uploadReady;
  }

  function updateOverallReadyState() {
    if (!overallStatusText) return;
    if (isCampaignActive) return;

    if (allParamsReady()) {
      overallStatusText.textContent = "Готов";
      overallStatusText.classList.add("status-text-ready");
      overallStatusText.classList.remove("status-text-running");
    } else {
      overallStatusText.textContent = "Не готов";
      overallStatusText.classList.remove("status-text-ready", "status-text-running");
    }
  }

  const lockMain = () => document.body.classList.add("campaign-active");
  const unlockMain = () => document.body.classList.remove("campaign-active");

  // ====== WHATSAPP UI ======
  function updateUI(status, qrCodeString = null) {
    currentStatus = status;

    // Статусный текст + цвет
    let statusText;
    let statusClass;

    if (status === "open" || status === "connected") {
      statusText = "Подключено";
      statusClass = "wa-status-connected";
    } else if (status === "qr") {
      statusText = "Ожидание QR-кода";
      statusClass = "wa-status-waiting";
    } else if (
      status === "connecting" ||
      status === "loading" ||
      status === "reconnecting" ||
      status === "logged_out"
    ) {
      statusText = status === "logged_out" ? "Требуется вход" : "Подключение...";
      statusClass = "wa-status-connecting";
    } else {
      statusText = "Не подключен";
      statusClass = "wa-status-disconnected";
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
    } else if (["qr", "connecting", "loading", "reconnecting", "logged_out"].includes(status)) {
      show(connectBtn);
      setDisabled(connectBtn, true);
      show(deleteBtn);
      setDisabled(deleteBtn, status !== "qr"); // можно удалить сессию, если подвис
    } else {
      show(connectBtn);
      setDisabled(connectBtn, false);
      hide(deleteBtn);
      setDisabled(deleteBtn, false);
    }

    // Модалка QR
    if (
      manualConnectRequested &&
      (status === "connecting" || status === "loading" || status === "reconnecting" || status === "logged_out")
    ) {
      qrModal?.classList.add("active");
      if (qrContainer) qrContainer.textContent = "Ожидание QR-кода...";
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
    } else if (!["connecting", "loading", "reconnecting", "logged_out"].includes(status)) {
      qrModal?.classList.remove("active");
      stopQrTimer();
      isFirstQr = true;
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
    updateUI("closed");
  });

  async function autoConnectIfHasSavedSession() {
    try {
      const r = await fetch(`/customer/has-saved-session?ts=${Date.now()}`, { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.success) return;
      if (d.exists && (currentStatus === "closed" || currentStatus === "unauthenticated")) {
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
    socket.emit("request_whatsapp_status");
  });

  // поддержка старого/нового формата whatsapp_status
  socket.on("whatsapp_status", (payload) => {
    const status = payload && payload.state ? payload.state : payload; // {state:'qr'} или 'qr'
    const transient = ["reconnecting", "connecting", "logged_out"];

    if (status === "qr") {
      if (manualConnectRequested) updateUI("qr");
      else updateUI("closed");
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
    updateUI("closed");
    updateOverallReadyState();
  });

  // новый унифицированный статус
  socket.on("wa_status", ({ state }) => {
    socket.emit("whatsapp_status", { state });
  });

  // новый QR (рекомендуемый)
  socket.on("wa_qr", ({ dataUrl }) => {
    if (!manualConnectRequested) return;
    qrModal?.classList.add("active");
    if (qrContainer) {
      const html = dataUrl ? `<img src="${dataUrl}" alt="QR Code">` : `<span>QR-код готов. Обновите окно.</span>`;
      qrContainer.innerHTML = html;
    }
    if (currentStatus !== "qr") updateUI("qr");
    if (!qrTimerInterval) startQrTimer();
  });

  // совместимость со старыми событиями QR
  socket.on("qr_image", (dataUrl) => {
    if (!manualConnectRequested) return;
    qrModal?.classList.add("active");
    if (qrContainer) qrContainer.innerHTML = `<img src="${dataUrl}" alt="QR Code">`;
    if (currentStatus !== "qr") updateUI("qr");
    if (!qrTimerInterval) startQrTimer();
  });
  socket.on("qr_code", (qrString) => {
    if (manualConnectRequested) updateUI("qr", qrString);
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
      })
      .catch((err) => {
        uploadCompleted = false;
        setIconConnected(uploadStatusIcon, false);
        swal("Ошибка", err.message || "Не удалось загрузить файл", "error");
        if (fileHint) fileHint.textContent = "Ошибка загрузки. Попробуйте снова.";
      });
  }

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
        if (labelTextEl) labelTextEl.textContent = "Заменить файл";

        if (fileHint) {
          const dt = data.lastUploadAt ? new Date(data.lastUploadAt) : null;
          fileHint.textContent = dt
            ? `Последняя загрузка: ${dt.toLocaleString("ru-RU")}`
            : "Данные уже присутствуют в базе.";
        }
      } else {
        uploadCompleted = false;
        setIconConnected(uploadStatusIcon, false);
        if (fileNameDisplay) fileNameDisplay.textContent = "Файл не выбран";
        const labelTextEl = document.getElementById("fileUploadLabelText");
        if (labelTextEl) labelTextEl.textContent = "Выберите файл";
      }
      updateOverallReadyState();
    } catch (e) {}
  }

  // ====== ВАЛИДАЦИЯ ПЕРЕД СТАРТОМ ======
  function getSelectedRadioValue(list) {
    const el = list.find((r) => r && r.checked);
    return el ? el.value : null;
  }

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
    // задержку больше не требуем: планировщик рулит таймингом

    const msg = (msgTemplate?.value || "").trim();
    if (!msg) {
      errors.push("Введите текст сообщения.");
    } else if (!/\(\(\s*клиент\s*\)\)/i.test(msg)) {
      errors.push("Сообщение должно содержать плейсхолдер ((клиент)).");
    }

    return { ok: errors.length === 0, errors, payload: { tz, addressing, msgCount, msg } };
  }

  // Подсветка статусов параметров
  timezoneSelect?.addEventListener("change", () => {
    setIconConnected(tzStatusIcon, !!timezoneSelect.value);
    updateOverallReadyState();
  });

  msgTemplate?.addEventListener("input", () => {
    const valid = !!msgTemplate.value.trim() && /\(\(\s*клиент\s*\)\)/i.test(msgTemplate.value);
    setIconConnected(messageCardStatusIcon, valid);
    updateOverallReadyState();
  });

  function markAddressingAndDelay() {
    const okAddr = !!getSelectedRadioValue(addressingRadios);
    const okCount = !!getSelectedRadioValue(msgCountRadios);
    // delay опционален теперь, но оставим индикатор как раньше:
    setIconConnected(addressingAndDelayIcon, okAddr && okCount);
  }
  addressingRadios.forEach((r) =>
    r.addEventListener("change", () => {
      markAddressingAndDelay();
      updateOverallReadyState();
    })
  );
  msgCountRadios.forEach((r) =>
    r.addEventListener("change", () => {
      markAddressingAndDelay();
      updateOverallReadyState();
    })
  );

  markAddressingAndDelay();

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

  // ====== СТАРТ/СТОП РАССЫЛКИ ======
  startBtn?.addEventListener("click", async () => {
    const { ok, errors, payload } = validateBeforeStart();
    if (!ok) {
      const listHtml =
        `<ul style="text-align:left;margin:0;padding-left:1.2em;">` +
        errors.map((e) => `<li>${e}</li>`).join("") +
        `</ul>`;
      return Swal.fire({ title: "Проверьте параметры", html: listHtml, icon: "warning" });
    }

    isCampaignActive = true;
    lockMain();
    clearEtaCountdown();

    setDisabled(startBtn, true);
    setDisabled(stopBtn, false);
    overallStatusText && overallStatusText.classList.remove("status-text-ready");
    overallStatusText && overallStatusText.classList.add("status-text-running");
    if (overallStatusText) overallStatusText.textContent = "В процессе";

    setCounts({ total: 0, sent: 0, remaining: 0, failed: 0 });

    try {
      const res = await fetch(URL_START, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: payload.msg,
          timezone: payload.tz, // <— ВАЖНО
          daily_limit: Number(payload.msgCount), // <— «сообщений в день»
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
    }
  });

  stopBtn?.addEventListener("click", async () => {
    setDisabled(stopBtn, true);
    try {
      const res = await fetch(URL_STOP, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId }), // <— передаём campaignId из планировщика
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || `Ошибка остановки (${res.status})`);

      // Оптимистично обновляем UI
      isCampaignActive = false;
      clearEtaCountdown();
      unlockMain();
      setDisabled(startBtn, false);
      setDisabled(stopBtn, true);
      overallStatusText && overallStatusText.classList.remove("status-text-running");
      overallStatusText && overallStatusText.classList.add("status-text-ready");
      if (overallStatusText) overallStatusText.textContent = "Остановлено";
      swal("Остановлено", "Рассылка остановлена", "info");
      stopNotifyShown = true;
    } catch (err) {
      setDisabled(stopBtn, false);
      swal("Не удалось остановить", err.message || "Ошибка остановки", "error");
    }
  });

  // ====== Socket.IO: события рассылки/кампании ======
  socket.on("campaign_started", ({ campaignId: id, timezone, total }) => {
    campaignId = id || campaignId;
    if (typeof total === "number") {
      totalCount = total;
      setCounts({ total: totalCount, sent: 0, remaining: totalCount, failed: 0 });
    }
  });

  socket.on("campaign_stopped", ({ campaignId: id }) => {
    if (id && id === campaignId) {
      // UI уже обновили в стопе — здесь ничего не обязательно
    }
  });

  // прогресс от вебхука
  socket.on("campaign_progress", ({ campaignId: id, taskId, phoneNumber, msgSendCount, status }) => {
    if (id && campaignId && id !== campaignId) return; // чужая кампания
    if (status === "sent") {
      sentCount += 1;
      setCounts({ total: totalCount || sentCount + failedCount, sent: sentCount });
    } else if (status === "sending") {
      // можно показать "в обработке"
    }
  });

  socket.on("campaign_error", ({ campaignId: id, taskId, phoneNumber, error }) => {
    if (id && campaignId && id !== campaignId) return;
    failedCount += 1;
    setCounts({ total: totalCount || sentCount + failedCount, failed: failedCount });
  });

  // старые события — оставляем для совместимости
  socket.on("update_progress", ({ total, sent, remaining }) => {
    setCounts({ total, sent, remaining, failed: failedCount });
  });

  // ETA
  socket.on("next_send_eta", ({ seconds }) => {
    if (!Number.isFinite(seconds) || seconds <= 0) clearEtaCountdown();
    else startEtaCountdown(seconds);
  });

  socket.on("sending_error", ({ name, error }) => {
    failedCount += 1;
    setCounts({ total: totalCount, sent: sentCount, failed: failedCount });
    console.warn("sending_error:", name, error);
  });

  socket.on("sending_finished", () => {
    isCampaignActive = false;
    unlockMain();
    clearEtaCountdown();
    setDisabled(startBtn, false);
    setDisabled(stopBtn, true);
    overallStatusText && overallStatusText.classList.remove("status-text-running");
    overallStatusText && overallStatusText.classList.add("status-text-ready");
    if (overallStatusText) overallStatusText.textContent = "Завершено";
    swal("Готово", "Рассылка завершена", "success");
  });

  socket.on("sending_stopped", () => {
    isCampaignActive = false;
    unlockMain();
    clearEtaCountdown();
    setDisabled(startBtn, false);
    setDisabled(stopBtn, true);
    overallStatusText && overallStatusText.classList.remove("status-text-running");
    overallStatusText && overallStatusText.classList.add("status-text-ready");
    if (overallStatusText) overallStatusText.textContent = "Остановлено";
    if (!stopNotifyShown) swal("Остановлено", "Рассылка остановлена", "info");
    stopNotifyShown = false;
  });

  // ====== стартовое состояние ======
  updateUI("closed");
  setIconConnected(tzStatusIcon, !!timezoneSelect?.value);
  const validMsg = !!msgTemplate?.value?.trim() && /\(\(\s*клиент\s*\)\)/i.test(msgTemplate.value || "");
  setIconConnected(messageCardStatusIcon, validMsg);
  updateOverallReadyState();
  markAddressingAndDelay();
  autoConnectIfHasSavedSession();
  refreshUploadSummary();
  updateOverallReadyState();
  document.body.classList.remove("campaign-active");
});
