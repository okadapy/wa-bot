CREATE TABLE IF NOT EXISTS customer_settings (
  customer_id BIGINT PRIMARY KEY,
  timezone VARCHAR(16) NULL,
  message_draft TEXT NULL,
  addressing_option VARCHAR(32) NULL,
  daily_limit_pref INT NULL,
  max_clients_pref INT NULL,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;