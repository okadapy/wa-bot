// controllers/authController.js

module.exports = (db) => {
  console.log("authController.js: Загрузка контроллера. Тип db:", typeof db);

  if (!db || !db.sequelize || typeof db.sequelize.define !== "function" || !db.Customer) {
    console.error(
      "ERROR: authController.js: Объект 'db' или 'db.sequelize' не является действительным экземпляром Sequelize, или модель Customer отсутствует."
    );
    throw new Error("Invalid 'db' object or missing Customer model provided to authController.");
  }

  const Customer = db.Customer;

  const getLoginPage = (req, res) => {
    console.log("authController.js: Вызов getLoginPage.");
    if (req.session.isCustomerAuthorized) {
      return res.redirect("/customer/dashboard");
    }
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    res.render("login", { layout: false });
  };

  const login = async (req, res) => {
    console.log("authController.js: Вызов login.");
    const { phone, password } = req.body;

    try {
      const customer = await Customer.findOne({
        where: {
          login_phone: phone,
          // ⭐ СРАВНЕНИЕ ПАРОЛЕЙ БЕЗ БИБЛИОТЕКИ BCrypt ⭐
          hashed_password: password,
        },
      });

      if (customer) {
        // const isPasswordValid = await bcrypt.compare(password, customer.hashed_password); // ⭐ ЭТА СТРОКА УДАЛЕНО ⭐
        const isPasswordValid = password === customer.hashed_password; // ⭐ ВОССТАНОВЛЕНО ПРЯМОЕ СРАВНЕНИЕ ⭐

        if (isPasswordValid) {
          req.session.isCustomerAuthorized = true;
          req.session.customerPhone = customer.login_phone;
          req.session.customerId = customer.id;
          console.log(`Пользователь ${customer.id} успешно вошел в систему.`);

          req.session.save((err) => {
            if (err) {
              console.error("Ошибка сохранения сессии:", err);
              return res.status(500).send("Не удалось сохранить сессию");
            }
            res.redirect("/customer/dashboard");
          });
        } else {
          res.render("login", { error: "Неверный номер телефона или пароль", layout: false });
        }
      } else {
        res.render("login", { error: "Неверный номер телефона или пароль", layout: false });
      }
    } catch (error) {
      console.error("Ошибка при аутентификации клиента:", error);
      res.status(500).render("login", { error: "Произошла ошибка сервера.", layout: false });
    }
  };
  const logout = (req, res) => {
    console.log("authController.js: Вызов logout.");
    try {
      req.session.destroy((err) => {
        if (err) {
          console.error("Ошибка при завершении сессии:", err);
        }
        res.clearCookie("connect.sid");
        return res.redirect("/login");
      });
    } catch (e) {
      console.error("authController.js: logout threw:", e);
      res.clearCookie("connect.sid");
      return res.redirect("/login");
    }
  };

  console.log(
    "authController.js: Возвращаемые обработчики - getLoginPage:",
    typeof getLoginPage,
    "login:",
    typeof login,
    "logout:",
    typeof logout
  );

  return {
    getLoginPage,
    login,
    logout,
  };
};
