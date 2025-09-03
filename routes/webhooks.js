// routes/webhook.js
const express = require("express");
const router = express.Router();
// const verifySchedulerSignature = require("../middleware/verifySchedulerSignature"); // временно не используем
const { schedulerSendWebhook } = require("../controllers/webhookController");

// Локальный парсер JSON после сырого тела
function parseJSONBody(req, res, next) {
  if (Buffer.isBuffer(req.body)) {
    try {
      req.body = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "invalid_json" });
    }
  }
  next();
}

// Хелсчек, чтобы видеть, что это ТОТ инстанс
router.get("/health", (req, res) => res.json({ ok: true, v: "webhooks-active" }));

// ВАЖНО: только для /wh/send даём express.raw, чтобы сохранить исходное тело для подписи (на будущее)
router.post(
  "/send",
  express.raw({ type: "application/json" }),
  // verifySchedulerSignature, // <-- включишь позже
  parseJSONBody,
  schedulerSendWebhook
);

module.exports = router;
