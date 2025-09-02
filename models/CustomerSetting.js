// models/CustomerSetting.js
module.exports = (sequelize) => {
  const { DataTypes } = require("sequelize");
  const CustomerSetting = sequelize.define(
    "CustomerSetting",
    {
      customer_id: { type: DataTypes.INTEGER, primaryKey: true },
      timezone: { type: DataTypes.STRING(16), allowNull: true },
      message_draft: { type: DataTypes.TEXT, allowNull: true },
      addressing_option: { type: DataTypes.STRING(32), allowNull: true },
      daily_limit_pref: { type: DataTypes.INTEGER, allowNull: true },
      max_clients_pref: { type: DataTypes.INTEGER, allowNull: true },
      updated_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: "customer_settings",
      timestamps: false,
      underscored: true,
    }
  );
  return CustomerSetting;
};
