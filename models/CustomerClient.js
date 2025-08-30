// models/CustomerClient.js

const { DataTypes } = require("sequelize");

module.exports = (sequelize) => {
  if (!sequelize || typeof sequelize.define !== "function") {
    console.error("ERROR: models/CustomerClient.js: Invalid Sequelize instance passed for model definition.");
    throw new Error("Invalid Sequelize instance provided to CustomerClient model.");
  }

  const CustomerClient = sequelize.define(
    "CustomerClient",
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      customer_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      full_name: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
    },
    {
      tableName: "customer_clients",
      timestamps: true,
      createdAt: "created_at",
      updatedAt: "updated_at",
    }
  );

  return CustomerClient;
};
