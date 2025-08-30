const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode"); // генерация PNG QR
const { Boom } = require("@hapi/boom");

const SESSION_FOLDER = path.join(__dirname, "..", "auth_info_baileys");

let client = {
  sock: null,
  status: "closed", // 'closed' | 'connecting' | 'open' | 'qr'
  io: null,
  qrCode: null, // сырая строка QR
  qrDataUrl: null, // PNG в data URL
};

let disconnectFn = null;
let reconnectTimer = null;
let intentionalClose = false; // важно: чтобы не реконнектиться после deleteSession

function emitStatus(state) {
  client.status = state;
  if (client.io) {
    try {
      client.io.emit("wa_status", { state });
    } catch (_) {}
    try {
      client.io.emit("whatsapp_status", state);
    } catch (_) {} // back-compat для твоего фронта
  }
}

function emitQr(dataUrl, rawQr) {
  if (client.io) {
    try {
      client.io.emit("wa_qr", { dataUrl });
    } catch (_) {}
    try {
      client.io.emit("qr_image", dataUrl);
    } catch (_) {}
    try {
      if (rawQr) client.io.emit("qr_code", rawQr);
    } catch (_) {}
  }
}

function hasSavedSession() {
  try {
    const credsPath = path.join(SESSION_FOLDER, "creds.json");
    if (fs.existsSync(credsPath)) return true;
    if (fs.existsSync(SESSION_FOLDER)) {
      const files = fs.readdirSync(SESSION_FOLDER).filter((n) => !n.startsWith("."));
      return files.length > 0;
    }
    return false;
  } catch {
    return false;
  }
}

function getWhatsAppClient() {
  return { status: client.status, qrCode: client.qrCode, qrDataUrl: client.qrDataUrl };
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

async function connectToWhatsApp() {
  // если есть предыдущая попытка — аккуратно закрываем
  if (disconnectFn) {
    try {
      disconnectFn("forced_disconnect");
    } catch (_) {}
    disconnectFn = null;
  }

  intentionalClose = false; // это новая попытка, не "намеренное закрытие"
  client.qrCode = null;
  client.qrDataUrl = null;
  emitStatus("connecting");

  if (!fs.existsSync(SESSION_FOLDER)) {
    fs.mkdirSync(SESSION_FOLDER, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

  client.sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["WA Web", "Chrome", ""],
  });

  client.sock.ev.on("creds.update", saveCreds);

  // функция корректного разрыва
  disconnectFn = (reason = "forced_disconnect") => {
    try {
      clearReconnectTimer();
      try {
        client.sock?.ev?.removeAllListeners();
      } catch (_) {}
      intentionalClose = true;
      if (client.sock && client.sock.end) {
        client.sock.end(reason);
      }
    } finally {
      client.sock = null;
      client.qrCode = null;
      client.qrDataUrl = null;
      emitStatus("closed");
      if (client.io) {
        try {
          client.io.emit("qr_flow_cancelled");
        } catch (_) {}
      }
      disconnectFn = null;
    }
  };

  // Подписка на обновления соединения
  client.sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // 1) Пришёл новый QR — всегда эмитим и НЕ закрываем модалку
    if (qr) {
      client.qrCode = qr;
      client.qrDataUrl = null;
      emitStatus("qr");
      try {
        const dataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: "M", margin: 1, width: 256 });
        client.qrDataUrl = dataUrl;
        emitQr(dataUrl, qr);
        console.log("[baileys] QR получен и сгенерирован на сервере (PNG).");
      } catch (err) {
        console.warn("[baileys] Не удалось сгенерировать QR data URL, шлём строку:", err?.message || err);
        emitQr(null, qr);
      }
    }

    // 2) Соединение открыто
    if (connection === "open") {
      clearReconnectTimer();
      client.qrCode = null;
      client.qrDataUrl = null;
      disconnectFn = null;
      emitStatus("open");
      console.log("[baileys] Соединение открыто");
      return;
    }

    // 3) Соединение закрыто
    if (connection === "close") {
      clearReconnectTimer();

      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const isLoggedOut = code === DisconnectReason.loggedOut || code === 401;

      // Если закрыли намеренно — НЕ реконнектимся
      if (intentionalClose) {
        intentionalClose = false;
        // уже эмитнули 'closed' в disconnectFn
        return;
      }

      // Разлогинили: даём фронту статус и стартуем новую регистрацию (новый QR придёт)
      if (isLoggedOut) {
        emitStatus("logged_out");
        console.warn("[baileys] Выход из аккаунта (loggedOut). Будет новая регистрация.");
        reconnectTimer = setTimeout(() => {
          connectToWhatsApp().catch((err) => {
            console.error("[baileys] Ошибка повторного подключения:", err?.message || err);
          });
        }, 1000);
        return;
      }

      // Промежуточные ошибки — это НЕ повод закрывать модалку
      console.warn("[baileys] Соединение закрыто (временная ошибка). Переподключаемся. Код:", code);
      emitStatus("reconnecting");
      reconnectTimer = setTimeout(() => {
        connectToWhatsApp().catch((err) => {
          console.error("[baileys] Повторная попытка подключения:", err?.message || err);
        });
      }, 3000);
      return;
    }

    // 4) Стадия «connecting»
    if (connection === "connecting") {
      emitStatus("connecting");
    }
  });

  // Сообщения
  if (process.env.WA_LOG_INCOMING === "1") {
    client.sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        const msg = messages?.[0];
        if (msg && msg.message) {
          const sender = msg.key.remoteJid;
          const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            "";
          console.log(`WA MSG from ${sender}: ${text}`);
        }
      } catch (e) {
        console.warn("[baileys] messages.upsert handler error:", e?.message || e);
      }
    });
  }
}

async function initializeWhatsApp(ioInstance) {
  client.io = ioInstance; // только сохраняем io — без автоконнекта
}

async function deleteSession(showSwal = true) {
  try {
    if (disconnectFn) {
      disconnectFn("forced_disconnect"); // intentionalClose=true, слушатели сняты, реконнект не включим
      disconnectFn = null;
    } else if (client.sock) {
      try {
        client.sock.ev.removeAllListeners();
      } catch (_) {}
      try {
        client.sock.end("forced_disconnect");
      } catch (_) {}
    }

    clearReconnectTimer();
    intentionalClose = true;

    if (fs.existsSync(SESSION_FOLDER)) {
      fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
    }

    client.sock = null;
    client.qrCode = null;
    client.qrDataUrl = null;
    emitStatus("closed");

    if (client.io) {
      try {
        client.io.emit("session_deleted_status", { success: true, message: "Сессия удалена", showSwal });
      } catch (_) {}
      try {
        client.io.emit("qr_flow_cancelled");
      } catch (_) {}
    }
  } catch (err) {
    console.error("[whatsappService.deleteSession] error:", err);
    if (client.io) {
      try {
        client.io.emit("session_deleted_status", { success: false, message: err.message, showSwal });
      } catch (_) {}
    }
  }
}

async function sendWhatsAppMessage(number, text) {
  if (!client.sock || client.status !== "open") {
    return { success: false, message: "WhatsApp не подключён" };
  }
  const jid = number.includes("@") ? number : `${number}@s.whatsapp.net`;
  try {
    const r = await client.sock.sendMessage(jid, { text });
    return { success: true, message: "Сообщение отправлено", messageId: r?.key?.id };
  } catch (err) {
    return { success: false, message: "Ошибка отправки: " + (err?.message || "unknown") };
  }
}

module.exports = {
  initializeWhatsApp,
  hasSavedSession,
  connectToWhatsApp,
  deleteSession,
  getWhatsAppClient,
  sendWhatsAppMessage,
};
