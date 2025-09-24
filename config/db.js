const { Sequelize } = require("sequelize");

const sequelize = new Sequelize(
  process.env.DB_DATABASE || "send_bot_dent_db",
  process.env.DB_USER || "root",
  process.env.DB_PASSWORD || "root",
  {
    host: process.env.DB_HOST || "db",
    port: process.env.DB_PORT || 3306, //3316
    dialect: "mysql",
    logging: false,
    retry: {
      match: [
        /ETIMEDOUT/,
        /EHOSTUNREACH/,
        /ECONNRESET/,
        /ECONNREFUSED/,
        /ETIMEDOUT/,
        /ESOCKETTIMEDOUT/,
        /EHOSTUNREACH/,
        /EPIPE/,
        /EAI_AGAIN/,
        /SequelizeConnectionError/,
        /SequelizeConnectionRefusedError/,
        /SequelizeHostNotFoundError/,
        /SequelizeHostNotReachableError/,
        /SequelizeInvalidConnectionError/,
        /SequelizeConnectionTimedOutError/,
      ],
      max: 5, // Maximum retry attempts
    },
    define: {
      timestamps: true,
      underscored: true, // Использовать snake_case для имен столбцов
    },
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
  }
);

async function connectToDatabase() {
  try {
    await sequelize.authenticate();
    console.log("Подключение к базе данных успешно установлено (Sequelize).");
    return sequelize;
  } catch (err) {
    console.error("Ошибка подключения к базе данных (Sequelize):", err, typeof err);
    process.exit(1);
  }
}

module.exports = connectToDatabase();
