// routes/authRoutes.js
const express = require("express");
const router = express.Router();

module.exports = (db) => {
  console.log("routes/authRoutes.js: Инициализация роутов. Тип db:", typeof db);

  if (!db || typeof db.sequelize !== "object" || !db.Customer) {
    console.error("ERROR: routes/authRoutes.js: Неверный объект 'db' передан.");
    throw new Error("Invalid 'db' object provided to authRoutes.");
  }

  let authController;
  try {
    authController = require("../controllers/authController")(db);

    if (
      !authController ||
      typeof authController.getLoginPage !== "function" ||
      typeof authController.login !== "function" ||
      typeof authController.logout !== "function"
    ) {
      console.error("ERROR: routes/authRoutes.js: authController не вернул ожидаемый объект с функциями.");
      throw new Error("Auth controller did not return valid handlers.");
    }
    console.log("routes/authRoutes.js: authController успешно загружен и содержит функции.");
  } catch (e) {
    console.error("ERROR: routes/authRoutes.js: Ошибка при загрузке authController:", e.message);
    throw e;
  }

  router.get("/", (req, res) => {
      res.redirect("/login")
  })

  router.get("/login", authController.getLoginPage);
  router.post("/login", authController.login);
  router.get("/logout", authController.logout);

  console.log("routes/authRoutes.js: Роуты авторизации успешно настроены.");
  return router;
};
