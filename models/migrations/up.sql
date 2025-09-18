-- ============================================
--  send_bot_dent_db — schema init (strict-compatible)
--  MySQL 5.7+, utf8mb4_unicode_ci
-- ============================================

CREATE DATABASE IF NOT EXISTS `send_bot_dent_db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE `send_bot_dent_db`;

-- 1) tariff_plans
CREATE TABLE IF NOT EXISTS `tariff_plans` (
    `id` INT(11) NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    `description` TEXT COLLATE utf8mb4_unicode_ci,
    `message_limit_daily` INT(11) DEFAULT NULL,
    `max_clients` INT(11) DEFAULT NULL,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 2) customers
CREATE TABLE IF NOT EXISTS `customers` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
    `login_phone` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    `hashed_password` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
    `tariff_plan_id` int(11) NOT NULL,
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `login_phone` (`login_phone`),
    KEY `fk_tariff_plan` (`tariff_plan_id`),
    CONSTRAINT `fk_tariff_plan` FOREIGN KEY (`tariff_plan_id`) REFERENCES `tariff_plans` (`id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 3) customer_clients
CREATE TABLE IF NOT EXISTS `customer_clients` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `customer_id` int(11) NOT NULL,
    `full_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_cc_customer` (`customer_id`),
    CONSTRAINT `fk_cc_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 4) customer_client_phones
CREATE TABLE IF NOT EXISTS `customer_client_phones` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `customer_id` int(11) NOT NULL,
    `customer_client_id` int(11) NOT NULL,
    `phone_number` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    `is_main` tinyint(1) DEFAULT '0',
    `description` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_client_phone` (
        `customer_client_id`,
        `phone_number`
    ),
    KEY `idx_ccp_customer` (`customer_id`),
    CONSTRAINT `customer_client_phones_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
    CONSTRAINT `customer_client_phones_ibfk_2` FOREIGN KEY (`customer_client_id`) REFERENCES `customer_clients` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 5) customer_settings
CREATE TABLE IF NOT EXISTS `customer_settings` (
    `customer_id` int(11) NOT NULL,
    `timezone` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `message_draft` text COLLATE utf8mb4_unicode_ci,
    `addressing_option` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `daily_limit_pref` int(11) DEFAULT NULL,
    `max_clients_pref` int(11) DEFAULT NULL,
    `updated_at` datetime DEFAULT NULL,
    PRIMARY KEY (`customer_id`),
    CONSTRAINT `fk_customer_settings_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 6) sessions (точно как у тебя в бою)
CREATE TABLE IF NOT EXISTS `sessions` (
    `sid` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
    `expires` datetime DEFAULT NULL,
    `data` text COLLATE utf8mb4_unicode_ci,
    `created_at` datetime NOT NULL,
    `updated_at` datetime NOT NULL,
    PRIMARY KEY (`sid`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ===============================
-- NEW A) campaign_timezones
-- ===============================
CREATE TABLE IF NOT EXISTS `campaign_timezones` (
    `campaign_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `timezone` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
    `customer_id` int(11) NOT NULL,
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`campaign_id`),
    KEY `idx_ct_customer` (`customer_id`),
    CONSTRAINT `fk_ct_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ===============================
-- NEW B) campaign_reports
-- ===============================
CREATE TABLE IF NOT EXISTS `campaign_reports` (
    `id` bigint NOT NULL AUTO_INCREMENT,
    `campaign_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `customer_id` int(11) NOT NULL,
    `started_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `finished_at` datetime DEFAULT NULL,
    `status` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'running',
    `total_sent` int(11) NOT NULL DEFAULT 0,
    `total_failed` int(11) NOT NULL DEFAULT 0,
    `total_clients` int(11) NOT NULL DEFAULT 0,
    `last_update` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_cr_campaign` (`campaign_id`),
    KEY `idx_cr_customer` (`customer_id`),
    CONSTRAINT `fk_cr_campaign` FOREIGN KEY (`campaign_id`) REFERENCES `campaign_timezones` (`campaign_id`),
    CONSTRAINT `fk_cr_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ===============================
-- phone_blacklist
-- ===============================
CREATE TABLE IF NOT EXISTS phone_blacklist (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    phone VARCHAR(64) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_phone_blacklist_phone (phone)
);

-- ================================
-- Usage counter per customer (limits)
-- ================================

CREATE TABLE IF NOT EXISTS `customer_usage` (
    `customer_id` INT(11) NOT NULL,
    `used_count` INT(11) NOT NULL DEFAULT 0,
    `period_start` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`customer_id`),
    CONSTRAINT `fk_customer_usage_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;