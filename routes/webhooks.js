// routes/webhook.js
const express = require("express");
const router = express.Router();
const verifySchedulerSignature = require("../middleware/verifySchedulerSignature");
const { schedulerSendWebhook } = require("../controllers/webhookController");

// локальный парсер JSON после сырого тела
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

// ВАЖНО: только для /wh/send даём express.raw, чтобы не ломать формы/логин
router.post(
  "/send",
  express.raw({ type: "application/json" }),
  verifySchedulerSignature,
  parseJSONBody,
  schedulerSendWebhook
);

module.exports = router;
