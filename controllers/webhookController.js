// controllers/webhookController.js

const whatsappService = require("../services/whatsappService");
const { reportSendResult } = require("../services/schedulerClient");
const { getCampaignTimezoneDB } = require("../services/campaignStore");

/**
 * Вебхук от планировщика: задание на отправку сообщения.
 *
 * Ожидаемый JSON:
 * {
 *   "campaignId": "cmp_123",     // обязателен
 *   "taskId": "tsk_0001",        // обязателен для идемпотентности у планировщика
 *   "phoneNumber": "+79001234567",
 *   "msgText": "Привет, Иван!",
 *   "msgSendCount": 37
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

    // базовая валидация
    if (!campaignId || !taskId) {
      return res.status(422).json({ success: false, message: "campaignId и taskId обязательны" });
    }
    if (!phoneNumber || !msgText) {
      return res.status(422).json({ success: false, message: "phoneNumber и msgText обязательны" });
    }

    const io = req.app.get("io");

    // Сокет: берём задание в работу
    if (io) {
      io.emit("campaign_progress", {
        campaignId,
        taskId,
        phoneNumber,
        msgSendCount,
        status: "sending",
      });
    }

    // Если хочешь локально дублировать «тихие часы» — раскомментируй и допиши isQuietNow
    // try {
    //   const tz = await getCampaignTimezoneDB(campaignId);
    //   if (tz && isQuietNow(tz)) {
    //     // бизнес-отказ — пускай планировщик решит, когда повторить
    //     return res.status(409).json({ success: false, message: "quiet_hours" });
    //   }
    // } catch (_) {}

    // Отправляем в WhatsApp прямо сейчас
    const result = await whatsappService.sendWhatsAppMessage(phoneNumber, msgText);

    if (result && result.success) {
      // Отчёт планировщику: УСПЕХ
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

      // Сокет: успешная отправка
      if (io) {
        io.emit("campaign_progress", {
          campaignId,
          taskId,
          phoneNumber,
          msgSendCount,
          status: "sent",
        });
      }

      // Приняли и обработали — можно 202/200. 202 — «принято», чтобы не блокировать планировщик.
      return res.status(202).json({ success: true });
    }

    // Ошибка отправки WA
    const errMsg = (result && result.message) || "send_failed";

    // Отчёт планировщику: ОШИБКА
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

    // Сокет: ошибка
    if (io) {
      io.emit("campaign_error", {
        campaignId,
        taskId,
        phoneNumber,
        error: errMsg,
      });
    }

    // Бизнес-ошибка — 409 (даём планировщику понять, что можно ретраить по его правилам)
    return res.status(409).json({ success: false, message: errMsg });
  } catch (e) {
    console.error("[/wh/send] unexpected error:", e);
    return res.status(500).json({ success: false, message: "internal_error" });
  }
};

/** Простой health-check контроллера вебхуков (опционально повесь на GET /wh/health) */
exports.health = (req, res) => {
  return res.json({ ok: true, ts: Date.now() });
};

/* =======================
 * (опционально) пример проверки «тихих часов», если решишь оставить дубль-валидацию
 * tz в формате "+3" / "-5"
 * ======================= */
// function isQuietNow(tzOffset) {
//   if (!tzOffset || !/^[+-]\d+$/.test(tzOffset)) return false;
//   const offset = parseInt(tzOffset, 10);
//   const nowUtc = new Date();
//   // локальное время = UTC + offset
//   const local = new Date(nowUtc.getTime() + offset * 60 * 60 * 1000);
//   const h = local.getUTCHours(); // используем getUTCHours, т.к. уже сместили дату
//   // тихие часы 21:00–10:00
//   return (h >= 21 || h < 10);
// }
