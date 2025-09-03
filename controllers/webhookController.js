// controllers/webhookController.js

const whatsappService = require("../services/whatsappService");
const { postResultToScheduler } = require("../services/schedulerClient");
const { getCustomerIdByCampaignDB } = require("../services/campaignStore");
const { bumpProgress } = require("../services/campaignStateStore");
const { enterOnce } = require("../services/dedupStore");

/**
 * Вебхук от планировщика: задание на отправку сообщения ИЛИ сигнал паузы.
 *
 * Поддерживаются camelCase и snake_case, а также поле "sent" вместо msg_send_count.
 *
 * Пример входа:
 * {
 *   "campaignId"|"campaign_id": "cmp_123",
 *   "taskId"|"task_id":         (не обязателен в MVP),
 *   "phoneNumber"|"phone_number": "+79001234567",
 *   "msgText"|"msg_text": "Привет!",
 *   "msgSendCount"|"msg_send_count"|"sent": 37,
 *   "pausing": true|false
 * }
 */
exports.schedulerSendWebhook = async (req, res) => {
  try {
    const body = req.body || {};
    const io = req.app.get("io");

    // ===== Нормализация входящих полей =====
    const campaignId = body.campaignId ?? body.campaign_id ?? body.campaignID ?? null;

    // Микросервис в MVP не использует taskId. Для совместимости фронта
    // будем передавать taskId = phoneNumber (ниже), но это локальная штука.
    const phoneNumberRaw = body.phoneNumber ?? body.phone_number ?? null;

    const msgTextRaw = body.msgText ?? body.msg_text ?? "";
    const msgText = typeof msgTextRaw === "string" ? msgTextRaw : String(msgTextRaw || "");

    // Новое поле "sent" от микросервиса: используем как msgSendCount.
    const msgSendCountVal = body.msgSendCount ?? body.msg_send_count ?? body.sent;
    const msgSendCount = Number.isFinite(Number(msgSendCountVal)) ? Number(msgSendCountVal) : null;

    // pausing может прийти как boolean или строка "true"/"false"
    const pausingFlag =
      typeof body.pausing === "boolean"
        ? body.pausing
        : typeof body.pausing === "string"
        ? body.pausing.toLowerCase() === "true"
        : undefined;

    if (!campaignId) {
      return res.status(422).json({ success: false, message: "campaignId обязателен" });
    }

    // ======= Сигнал паузы =======
    if (pausingFlag === true) {
      try {
        io && io.emit("campaign_pausing", { pausing: true, campaignId });
      } catch (_) {}
      // В паузе сообщение не отправляем
      return res.status(202).json({ success: true, pausing: true });
    }
    if (pausingFlag === false) {
      try {
        io && io.emit("campaign_pausing", { pausing: false, campaignId });
      } catch (_) {}
      // после снятия паузы ниже может идти обычное задание
    }

    // ======= Обычное задание на отправку =======
    if (!phoneNumberRaw || !msgText) {
      return res.status(422).json({ success: false, message: "phoneNumber и msgText обязательны" });
    }

    // Нормализуем телефон (ключ всегда в цифрах)
    const normalizedPhone = String(phoneNumberRaw).replace(/\D+/g, "");
    const phoneNumber = normalizedPhone || String(phoneNumberRaw);

    // === Дедуп по (campaignId, phoneNumber) с TTL ===
    const ttlSec = Number(process.env.DEDUP_TTL_SEC);
    const ttlMs = Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec * 1000) : 300_000; // дефолт 300с (5 минут)

    const key = `${campaignId}|${phoneNumber}`;

    // Если такой ключ уже в работе/недавно был — игнорим дубликат
    if (!enterOnce(key, ttlMs)) {
      // Можно мягко подсветить фронту, что пришёл дубликат, но это не обязательно:
      try {
        io &&
          io.emit("campaign_progress", {
            campaignId,
            taskId: phoneNumber, // совместимость с фронтом
            phoneNumber,
            msgSendCount,
            status: "duplicate_ignored",
          });
      } catch (_) {}
      return res.status(202).json({ success: true, duplicate: true });
    }

    // Сигнал "в процессе" для прогресса (compat: taskId = phoneNumber)
    try {
      io &&
        io.emit("campaign_progress", {
          campaignId,
          taskId: phoneNumber,
          phoneNumber,
          msgSendCount,
          status: "sending",
        });
    } catch (_) {}

    // Отправляем в WhatsApp
    const result = await whatsappService.sendWhatsAppMessage(phoneNumber, msgText);

    if (result && result.success) {
      // Репортим в планировщик: OK (без taskId в MVP)
      // При желании можно передать taskId: phoneNumber — микросервис его проигнорирует.
      try {
        await postResultToScheduler({
          campaignId,
          phoneNumber,
          status: "sent",
          messageId: result.messageId || null,
        });
      } catch (e) {
        console.warn("[webhook] postResultToScheduler(sent) failed:", e?.message || e);
      }

      // Обновляем фронт
      try {
        io &&
          io.emit("campaign_progress", {
            campaignId,
            taskId: phoneNumber,
            phoneNumber,
            msgSendCount,
            status: "sent",
          });
      } catch (_) {}

      // Локальный счётчик (для снапшота)
      try {
        const customerId = await getCustomerIdByCampaignDB(campaignId);
        if (customerId) bumpProgress({ customerId, ok: true });
      } catch (_) {}

      return res.status(202).json({ success: true });
    }

    // Ошибка отправки
    const errMsg = (result && result.message) || "send_failed";

    try {
      await postResultToScheduler({
        campaignId,
        phoneNumber,
        status: "failed",
        error: errMsg,
      });
    } catch (e) {
      console.warn("[webhook] postResultToScheduler(failed) failed:", e?.message || e);
    }

    try {
      io &&
        io.emit("campaign_error", {
          campaignId,
          taskId: phoneNumber,
          phoneNumber,
          error: errMsg,
        });
    } catch (_) {}

    try {
      const customerId = await getCustomerIdByCampaignDB(campaignId);
      if (customerId) bumpProgress({ customerId, ok: false });
    } catch (_) {}

    return res.status(409).json({ success: false, message: errMsg });
  } catch (e) {
    console.error("[/wh/send] unexpected error:", e);
    return res.status(500).json({ success: false, message: "internal_error" });
  }
};

exports.health = (req, res) => {
  return res.json({ ok: true, ts: Date.now() });
};
