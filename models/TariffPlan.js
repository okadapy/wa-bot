// models/TariffPlan.js

const { DataTypes } = require("sequelize");

module.exports = (sequelize) => {
  if (!sequelize || typeof sequelize.define !== "function") {
    console.error("ERROR: models/TariffPlan.js: Неверный экземпляр Sequelize передан.");
    throw new Error("Invalid Sequelize instance provided to TariffPlan model.");
  }

  const TariffPlan = sequelize.define(
    "TariffPlan",
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
      },
      max_clients: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 15000,
      },
      message_limit_daily: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.0,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      tableName: "tariff_plans",
      timestamps: true,
      createdAt: "created_at",
      updatedAt: "updated_at",
    }
  );

  console.log("models/TariffPlan.js: Модель TariffPlan успешно определена.");
  return TariffPlan;
};
