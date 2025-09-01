const { Sequelize } = require("sequelize");

const sequelize = new Sequelize(
  process.env.DB_DATABASE || "send_bot_dent_db", // Название вашей БД
  process.env.DB_USER || "root", // Имя пользователя
  process.env.DB_PASSWORD || "root", // Пароль
  {
    host: process.env.DB_HOST || "db", // Хост
    port: process.env.DB_PORT || 3306, // Порт
    dialect: "mysql", // Указываем диалект - MySQL
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
        /SequelizeConnectionTimedOutError/
      ],
      max: 5 // Maximum retry attempts
    },
    define: {
      timestamps: true, // Автоматическое управление created_at и updated_at
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
    await sequelize.authenticate(); // Проверяем подключение
    console.log("Подключение к базе данных успешно установлено (Sequelize).");
    return sequelize; // Возвращаем экземпляр Sequelize
  } catch (err) {
    console.error("Ошибка подключения к базе данных (Sequelize):", err, typeof err);
    process.exit(1);
  }
}

// Экспортируем функцию, которая возвращает обещание с экземпляром Sequelize
module.exports = connectToDatabase();
