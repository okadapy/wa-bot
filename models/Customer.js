const { DataTypes } = require("sequelize");

module.exports = (sequelize) => {
  // Диагностика: Проверяем, что экземпляр Sequelize передан
  if (!sequelize || typeof sequelize.define !== "function") {
    console.error("ERROR: models/Customer.js: Неверный экземпляр Sequelize передан.");
    throw new Error("Invalid Sequelize instance provided to Customer model.");
  }

  const Customer = sequelize.define(
    "Customer",
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      login_phone: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true,
      },
      hashed_password: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      tariff_plan_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: "tariff_plans",
          key: "id",
        },
      },
    },
    {
      tableName: "customers",
      timestamps: true,
      createdAt: "created_at",
      updatedAt: "updated_at",
    }
  );

  console.log("models/Customer.js: Модель Customer успешно определена.");
  return Customer;
};
