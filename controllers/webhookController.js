// controllers/webhookController.js

const whatsappService = require("../services/whatsappService");
const { ensureRow, getUsage, addUsage } = require("../services/limitUsageStore");
const { stopCampaignOnScheduler } = require("../services/schedulerClient");
const { getCustomerIdByCampaignDB } = require("../services/campaignStore");
const { bumpProgress } = require("../services/campaignStateStore");
const { enterOnce } = require("../services/dedupStore");

const SLEEP_MS_BETWEEN_RETRIES = 8000; // 8 секунд
const MAX_ATTEMPTS = 3; // 1 первичный + 2 ретрая = 3 попытки

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Вебхук от планировщика: задание на отправку сообщения ИЛИ сигнал паузы.
 *
 * Поддерживаем:
 * - camelCase / snake_case поля
 * - "sent" вместо msg_send_count
 * - pausing: true|false
 *
 * Пример входа:
 * {
 *   "campaignId"|"campaign_id": 1,
 *   "taskId"|"task_id": (в MVP не обязателен),
 *   "phoneNumber"|"phone_number": "+79001234567",
 *   "msgText"|"msg_text": "Привет!",
 *   "msgSendCount"|"msg_send_count"|"sent": 37,
 *   "pausing": true|false
 * }
 */
exports.schedulerSendWebhook = async (req, res) => {
  const io = req.app.get("io");
  let campaignId = null;
  let finalizeAfterSend = false;

  try {
    const body = req.body || {};

    // ===== Нормализация входящих полей =====
    campaignId = body.campaignId ?? body.campaign_id ?? body.campaignID ?? null;
    const phoneNumberRaw = body.phoneNumber ?? body.phone_number ?? null;

    const msgTextRaw = body.msgText ?? body.msg_text ?? "";
    const msgText = typeof msgTextRaw === "string" ? msgTextRaw : String(msgTextRaw || "");

    const msgSendCountVal = body.msgSendCount ?? body.msg_send_count ?? body.sent;
    const msgSendCount = Number.isFinite(Number(msgSendCountVal)) ? Number(msgSendCountVal) : null;

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
    const hasTaskPayload = !!(phoneNumberRaw && msgText);

    if (pausingFlag === true || pausingFlag === false) {
      console.log(`[webhook] pausing=${pausingFlag} for campaign ${campaignId}, hasTask=${hasTaskPayload}`);
      try {
        io && io.emit("campaign_pausing", { pausing: !!pausingFlag, campaignId });
      } catch (_) {}

      // Если это чисто "сигнал паузы" без задания — подтверждаем и выходим
      if (!hasTaskPayload) {
        return res.status(202).json({ success: true, pausing: !!pausingFlag, accepted: true });
      }
      // Иначе — падаем ниже и обрабатываем отправку сообщения как обычно
    }

    // ======= Сигнал завершения кампании =======
    finalizeAfterSend = body.done === true && hasTaskPayload === true;
    if (body.done === true && !hasTaskPayload) {
      try {
        io && io.emit("campaign_stopped", { campaignId });
      } catch (_) {}
      return res.status(202).json({ success: true, done: true, accepted: true });
    }

    // ======= Обычное задание на отправку (или совместно с pausing) =======
    if (!hasTaskPayload) {
      // сюда дойдём только если pausing не был передан; для чистоты — 422
      return res.status(422).json({ success: false, message: "phoneNumber и msgText обязательны" });
    }

    // Нормализуем телефон (ключ — только цифры)
    const normalizedPhone = String(phoneNumberRaw).replace(/\D+/g, "");
    const phoneNumber = normalizedPhone || String(phoneNumberRaw);

    // === Дедуп по (campaignId, phoneNumber) с TTL ===
    const ttlSec = Number(process.env.DEDUP_TTL_SEC);
    const ttlMs = Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec * 1000) : 30_000; // 30 сек по умолчанию
    const key = `${campaignId}|${phoneNumber}`;

    if (!enterOnce(key, ttlMs)) {
      // Дубликат — молча подтверждаем, но фронт можно проинформировать
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

    // ======= Отправка в WhatsApp с ретраями =======
    let attempt = 0;
    let lastErr = null;
    let waResult = null;

    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      try {
        waResult = await whatsappService.sendWhatsAppMessage(phoneNumber, msgText);
        if (waResult && waResult.success) break; // успех — выходим из цикла
        lastErr = new Error(waResult?.message || "send_failed");
      } catch (e) {
        lastErr = e;
      }

      // если не последняя попытка — подождать и попробовать ещё
      if (attempt < MAX_ATTEMPTS) {
        await sleep(SLEEP_MS_BETWEEN_RETRIES);
      }
    }

    if (waResult && waResult.success) {
      // Успех: обновим фронт, локальный счётчик, вернём 202
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

      try {
        const customerId = await getCustomerIdByCampaignDB(campaignId);
        if (customerId) {
          // прогресс
          try {
            bumpProgress({ customerId, ok: true });
          } catch (_) {}

          // учёт лимита
          await ensureRow(customerId);

          // модели берем из app.get("db"), а не require("../db")
          const db = req.app.get("db");
          const { Customer, TariffPlan } = db || {};

          let maxClients = null;
          try {
            if (Customer && TariffPlan) {
              const cust = await Customer.findByPk(customerId);
              if (cust?.tariff_plan_id) {
                const tariff = await TariffPlan.findByPk(cust.tariff_plan_id);
                if (tariff) maxClients = Number(tariff.max_clients) || null;
              }
            }
          } catch (_) {}

          if (maxClients != null && maxClients > 0) {
            // успех = отправили в Baileys/WA
            const usedAfter = await addUsage(customerId, 1);

            if (usedAfter >= maxClients) {
              // 1) уведомим фронт
              try {
                io &&
                  io.emit("campaign_limit_exhausted", {
                    campaignId,
                    customerId,
                    limit: maxClients,
                    used: usedAfter,
                  });
              } catch (_) {}

              // 2) попросим планировщик остановить кампанию
              try {
                await stopCampaignOnScheduler(campaignId, { reason: "limit_exhausted" });
              } catch (e) {
                console.warn("[limit] stopCampaignOnScheduler failed:", e?.message || e);
              }

              // 3) локально подсветим остановку
              try {
                io && io.emit("campaign_stopped", { campaignId });
              } catch (_) {}
            }
          }
        }
      } catch (e) {
        console.warn("[limit] usage update failed:", e?.message || e);
      }

      return res.status(202).json({
        success: true,
        status: "sent",
        attempts: attempt,
        messageId: waResult.messageId || null,
        ...(finalizeAfterSend ? { done: true } : {}),
      });
    }

    // Полностью не удалось
    const errMsg = lastErr?.message || "send_failed";
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

    return res.status(409).json({
      success: false,
      status: "failed",
      attempts: attempt,
      error: errMsg,
    });
  } catch (e) {
    console.error("[/wh/send] unexpected error:", e);
    return res.status(500).json({ success: false, message: "internal_error" });
  } finally {
    if (finalizeAfterSend) {
      try {
        io && io.emit("campaign_stopped", { campaignId });
      } catch (_) {}
    }
  }
};

exports.health = (req, res) => {
  return res.json({ ok: true, ts: Date.now() });
};
