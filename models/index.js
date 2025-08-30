// models/index.js

const { Sequelize } = require("sequelize");

module.exports = (sequelize) => {
  if (!sequelize || typeof sequelize.define !== "function") {
    console.error("ERROR: models/index.js: Неверный экземпляр Sequelize передан для инициализации моделей.");
    throw new Error("Invalid Sequelize instance provided to models/index.js.");
  }
  console.log("models/index.js: Инициализация моделей с переданным экземпляром Sequelize.");

  // Импортируем определения каждой модели, передавая им полученный экземпляр Sequelize
  const Customer = require("./Customer")(sequelize);
  const TariffPlan = require("./TariffPlan")(sequelize);
  const CustomerClient = require("./CustomerClient")(sequelize);
  const CustomerClientPhone = require("./CustomerClientPhone")(sequelize);

  // TariffPlan <-> Customer (один тарифный план может иметь много клиентов)
  TariffPlan.hasMany(Customer, { foreignKey: "tariff_plan_id" });
  Customer.belongsTo(TariffPlan, { foreignKey: "tariff_plan_id" });

  // Customer <-> CustomerClient (один клиент компании может иметь много своих клиентов)
  Customer.hasMany(CustomerClient, { foreignKey: "customer_id" });
  CustomerClient.belongsTo(Customer, { foreignKey: "customer_id" });

  // CustomerClient <-> CustomerClientPhone (один клиент может иметь много номеров телефонов)
  CustomerClient.hasMany(CustomerClientPhone, { foreignKey: "customer_client_id" });
  CustomerClientPhone.belongsTo(CustomerClient, { foreignKey: "customer_client_id" });

  // Customer <-> CustomerClientPhone (прямая связь, если customer_id есть в CustomerClientPhone)
  Customer.hasMany(CustomerClientPhone, { foreignKey: "customer_id" });
  CustomerClientPhone.belongsTo(Customer, { foreignKey: "customer_id" });

  const db = {
    sequelize,
    Sequelize,
    Customer,
    TariffPlan,
    CustomerClient,
    CustomerClientPhone,
  };

  console.log("models/index.js: Все модели и ассоциации успешно определены.");
  return db;
};
