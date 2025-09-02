// controllers/webhookController.js

const whatsappService = require("../services/whatsappService");
const { reportSendResult } = require("../services/schedulerClient");
const { getCampaignTimezoneDB, getCustomerIdByCampaignDB } = require("../services/campaignStore");
const { bumpProgress } = require("../services/campaignStateStore");

/**
 * Вебхук от планировщика: задание на отправку сообщения ИЛИ сигнал паузы.
 *
 * Ожидаемый JSON:
 * {
 *   "campaignId": "cmp_123",     // обязателен для всех кейсов
 *   "taskId": "tsk_0001",        // обязателен для отправки (идемпотентность у планировщика)
 *   "phoneNumber": "+79001234567",
 *   "msgText": "Привет, Иван!",
 *   "sent": 37,
 *   "pausing": true|false        // необязательный флаг: если true — показываем плашку-паузу (24ч локально на фронте)
 * }
 */
exports.schedulerSendWebhook = async (req, res) => {
  try {
    const body = req.body || {};

    const campaignId = body.campaignId || null;
    const taskId = body.taskId || null;
    const phoneNumber = body.phoneNumber || null;
    const msgText = typeof body.msgText === "string" ? body.msgText : "";
    const msgSendCount = Number.isFinite(Number(body.msgSendCount)) ? Number(body.msgSendCount) : null;
    const pausingFlag = typeof body.pausing === "boolean" ? body.pausing : undefined;

    if (!campaignId) {
      return res.status(422).json({ success: false, message: "campaignId обязателен" });
    }

    const io = req.app.get("io");

    // ======= Обработка паузы от микросервиса =======
    if (pausingFlag === true) {
      // Эмитим событие фронту — показать красную плашку с локальным 24h обратным отсчётом.
      try {
        io && io.emit("campaign_pausing", { pausing: true, campaignId });
      } catch (_) {}
      // В режиме паузы сообщение НЕ отправляем (даже если поля пришли): подтверждаем приём и выходим.
      return res.status(202).json({ success: true, pausing: true });
    }
    if (pausingFlag === false) {
      // Снять плашку на фронте (продолжаем обычную обработку, если пришло ещё и задание на отправку)
      try {
        io && io.emit("campaign_pausing", { pausing: false, campaignId });
      } catch (_) {}
    }

    // ======= Дальше — обычное задание на отправку =======
    if (!taskId) {
      return res.status(422).json({ success: false, message: "taskId обязателен для отправки сообщения" });
    }
    if (!phoneNumber || !msgText) {
      return res.status(422).json({ success: false, message: "phoneNumber и msgText обязательны" });
    }

    // Сигнал "в процессе" для прогресса (не обязательно, но полезно)
    if (io) {
      io.emit("campaign_progress", {
        campaignId,
        taskId,
        phoneNumber,
        msgSendCount,
        status: "sending",
      });
    }

    // Отправляем в WhatsApp
    const result = await whatsappService.sendWhatsAppMessage(phoneNumber, msgText);

    if (result && result.success) {
      // Репортим в планировщик: OK
      try {
        await reportSendResult({
          campaignId,
          taskId,
          phoneNumber,
          status: "sent",
          messageId: result.messageId || null,
        });
      } catch (e) {
        console.warn("[webhook] reportSendResult(sent) failed:", e?.message || e);
      }

      // Обновляем фронт
      if (io) {
        io.emit("campaign_progress", {
          campaignId,
          taskId,
          phoneNumber,
          msgSendCount,
          status: "sent",
        });
      }

      // Локальный счётчик
      try {
        const customerId = await getCustomerIdByCampaignDB(campaignId);
        if (customerId) bumpProgress({ customerId, ok: true });
      } catch {}

      return res.status(202).json({ success: true });
    }

    // Ошибка отправки
    const errMsg = (result && result.message) || "send_failed";

    try {
      await reportSendResult({
        campaignId,
        taskId,
        phoneNumber,
        status: "failed",
        error: errMsg,
      });
    } catch (e) {
      console.warn("[webhook] reportSendResult(failed) failed:", e?.message || e);
    }

    if (io) {
      io.emit("campaign_error", {
        campaignId,
        taskId,
        phoneNumber,
        error: errMsg,
      });
    }

    try {
      const customerId = await getCustomerIdByCampaignDB(campaignId);
      if (customerId) bumpProgress({ customerId, ok: false });
    } catch {}

    return res.status(409).json({ success: false, message: errMsg });
  } catch (e) {
    console.error("[/wh/send] unexpected error:", e);
    return res.status(500).json({ success: false, message: "internal_error" });
  }
};

exports.health = (req, res) => {
  return res.json({ ok: true, ts: Date.now() });
};
