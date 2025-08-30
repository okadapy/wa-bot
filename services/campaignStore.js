/**
 * Sequelize-backed storage for campaignId <-> timezone (and customerId)
 */
const sequelizePromise = require("../config/db");
let CampaignModel = null;

async function initModel() {
  const sequelize = await sequelizePromise;
  if (!CampaignModel) {
    CampaignModel = sequelize.define(
      "SchedulerCampaign",
      {
        id: { type: require("sequelize").INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        campaign_id: { type: require("sequelize").STRING(191), allowNull: false, unique: true },
        customer_id: { type: require("sequelize").INTEGER.UNSIGNED, allowNull: true },
        timezone: { type: require("sequelize").STRING(64), allowNull: false, defaultValue: "UTC" }
      },
      {
        tableName: "scheduler_campaigns",
        underscored: true,
        timestamps: true
      }
    );
    await CampaignModel.sync(); // ensure table exists
  }
  return CampaignModel;
}

async function saveCampaignTimezoneDB(campaignId, timezone, customerId) {
  const M = await initModel();
  const row = await M.findOne({ where: { campaign_id: campaignId } });
  if (row) {
    row.timezone = timezone || row.timezone;
    if (customerId) row.customer_id = customerId;
    await row.save();
    return row;
  }
  return M.create({ campaign_id: campaignId, timezone: timezone || "UTC", customer_id: customerId || null });
}

async function getCampaignTimezoneDB(campaignId) {
  const M = await initModel();
  const row = await M.findOne({ where: { campaign_id: campaignId }, attributes: ["timezone"] });
  return row ? row.timezone : "UTC";
}

module.exports = { saveCampaignTimezoneDB, getCampaignTimezoneDB, initModel };
