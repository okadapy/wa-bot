// routes/customerRoutes.js
const express = require("express");
const router = express.Router();

module.exports = (app) => {
  console.log("routes/customerRoutes.js: Инициализация роутов.");

  let customerController;
  try {
    customerController = require("../controllers/customerController")(app);
    if (
      !customerController ||
      typeof customerController.getDashboard !== "function" ||
      typeof customerController.uploadClients !== "function" ||
      typeof customerController.startSending !== "function" ||
      typeof customerController.stopSending !== "function" ||
      typeof customerController.initWhatsAppClient !== "function" ||
      typeof customerController.deleteWhatsAppSession !== "function"
    ) {
      console.error("ERROR: routes/customerRoutes.js: customerController не вернул ожидаемый объект с функциями.");
      throw new Error("Customer controller did not return valid handlers.");
    }
    console.log("routes/customerRoutes.js: customerController успешно загружен и содержит функции.");
  } catch (e) {
    console.error("ERROR: routes/customerRoutes.js: Ошибка при загрузке customerController:", e.message);
    throw e;
  }

  // Глобальная проверка авторизации для всех customer-роутов
  router.use((req, res, next) => {
    if (req.session && req.session.isCustomerAuthorized) return next();

    const wantsJson = req.xhr || (req.headers.accept || "").includes("application/json");
    if (wantsJson || req.method !== "GET") {
      return res.status(401).json({ success: false, message: "Сессия истекла. Пожалуйста, войдите заново." });
    }
    return res.redirect("/login");
  });

  // Маршруты
  router.get("/dashboard", customerController.getDashboard);
  router.post("/upload", customerController.uploadClients);
  router.get("/upload-summary", customerController.getUploadSummary);
  router.post("/purge-clients", customerController.purgeClients);

  router.get("/campaign/state", customerController.getCampaignState);
  router.get("/settings", customerController.getSettings);
  router.post("/settings", express.json(), customerController.saveSettings);
  router.post("/start-sending", customerController.startSending);
  router.post("/stop-sending", customerController.stopSending);
  router.post("/init-whatsapp-client", customerController.initWhatsAppClient);
  router.get("/has-saved-session", customerController.hasSavedSession);
  router.post("/delete-whatsapp-session", customerController.deleteWhatsAppSession);

  router.get("/blacklist", customerController.getBlacklist);
  router.post("/blacklist/add", express.json(), customerController.addToBlacklist);
  router.delete("/blacklist/:id", customerController.deleteFromBlacklist);

  console.log("routes/customerRoutes.js: Роуты для клиента успешно настроены.");
  return router;
};
