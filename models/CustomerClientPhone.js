// models/CustomerClientPhone.js

const { DataTypes } = require("sequelize");

module.exports = (sequelize) => {
  if (!sequelize || typeof sequelize.define !== "function") {
    console.error("ERROR: models/CustomerClientPhone.js: Invalid Sequelize instance passed for model definition.");
    throw new Error("Invalid Sequelize instance provided to CustomerClientPhone model.");
  }

  const CustomerClientPhone = sequelize.define(
    "CustomerClientPhone",
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      customer_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        // Ссылки (references) для связей ForeignKey теперь определяются ТОЛЬКО в models/index.js
      },
      customer_client_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        // Ссылки (references) для связей ForeignKey теперь определяются ТОЛЬКО в models/index.js
        unique: "customer_client_id_phone_number_unique", // Оставляем, так как это часть уникального индекса
      },
      phone_number: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: "customer_client_id_phone_number_unique",
      },
      is_main: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      description: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
    },
    {
      tableName: "customer_client_phones",
      timestamps: true,
      createdAt: "created_at",
      updatedAt: "updated_at",
      indexes: [
        {
          unique: true,
          fields: ["customer_client_id", "phone_number"],
        },
      ],
    }
  );

  return CustomerClientPhone;
};
