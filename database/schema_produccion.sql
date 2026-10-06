-- Estructura de la base de datos de PRODUCCIÓN (solo estructura, sin datos).
-- Generado el 2026-10-06 12:40 desde la base 'railway' (MySQL 9.7.2).
-- Para recrear la base: ejecutar este archivo completo. Usa CREATE TABLE IF NOT EXISTS.
-- Las marcadas «a mano» no las crea ningún modelo del proyecto: esta es la única copia de su estructura.

SET FOREIGN_KEY_CHECKS = 0;

-- actividad_usuarios  (44 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `actividad_usuarios` (
  `id` int NOT NULL AUTO_INCREMENT,
  `fecha` date NOT NULL,
  `user_name` varchar(100) NOT NULL,
  `tipo` varchar(30) NOT NULL,
  `order_id` int DEFAULT NULL,
  `monto` decimal(10,2) DEFAULT '0.00',
  `metodo` varchar(30) DEFAULT NULL,
  `detalle` varchar(300) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_fecha` (`fecha`),
  KEY `idx_usuario` (`user_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- categories  (5 filas · la crea un modelo de Sequelize)
CREATE TABLE IF NOT EXISTS `categories` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(50) NOT NULL,
  `display_name` varchar(100) DEFAULT NULL,
  `description` text,
  `color` varchar(7) DEFAULT '#6366f1',
  `icon` varchar(50) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT '1',
  `sort_order` int DEFAULT '0',
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- cocina_counter  (1 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `cocina_counter` (
  `id` int NOT NULL DEFAULT '1',
  `last_number` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- cocina_order_numbers  (16 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `cocina_order_numbers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_id` int NOT NULL,
  `cocina_number` int NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `table_name` varchar(100) DEFAULT NULL,
  `items_snapshot` json DEFAULT NULL,
  `completed_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `order_id` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- cocina_orders  (0 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `cocina_orders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_number` int NOT NULL,
  `table_name` varchar(100) DEFAULT NULL,
  `items` json NOT NULL,
  `status` varchar(50) DEFAULT 'completada',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- daily_summaries  (0 filas · la crea un modelo de Sequelize)
CREATE TABLE IF NOT EXISTS `daily_summaries` (
  `id` int NOT NULL AUTO_INCREMENT,
  `date` date NOT NULL,
  `total_revenue` decimal(10,2) DEFAULT '0.00',
  `total_transactions` int DEFAULT '0',
  `avg_ticket` decimal(10,2) DEFAULT '0.00',
  `cash_total` decimal(10,2) DEFAULT '0.00',
  `card_total` decimal(10,2) DEFAULT '0.00',
  `transfer_total` decimal(10,2) DEFAULT '0.00',
  `notes` text,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `date` (`date`),
  UNIQUE KEY `date_2` (`date`),
  UNIQUE KEY `date_3` (`date`),
  UNIQUE KEY `date_4` (`date`),
  UNIQUE KEY `date_5` (`date`),
  UNIQUE KEY `date_6` (`date`),
  UNIQUE KEY `date_7` (`date`),
  UNIQUE KEY `date_8` (`date`),
  UNIQUE KEY `date_9` (`date`),
  UNIQUE KEY `date_10` (`date`),
  UNIQUE KEY `date_11` (`date`),
  UNIQUE KEY `date_12` (`date`),
  UNIQUE KEY `date_13` (`date`),
  UNIQUE KEY `date_14` (`date`),
  UNIQUE KEY `date_15` (`date`),
  UNIQUE KEY `date_16` (`date`),
  UNIQUE KEY `date_17` (`date`),
  UNIQUE KEY `date_18` (`date`),
  UNIQUE KEY `date_19` (`date`),
  UNIQUE KEY `date_20` (`date`),
  UNIQUE KEY `date_21` (`date`),
  UNIQUE KEY `date_22` (`date`),
  UNIQUE KEY `date_23` (`date`),
  UNIQUE KEY `date_24` (`date`),
  UNIQUE KEY `date_25` (`date`),
  UNIQUE KEY `date_26` (`date`),
  UNIQUE KEY `date_27` (`date`),
  UNIQUE KEY `date_28` (`date`),
  UNIQUE KEY `date_29` (`date`),
  UNIQUE KEY `date_30` (`date`),
  UNIQUE KEY `date_31` (`date`),
  UNIQUE KEY `date_32` (`date`),
  UNIQUE KEY `date_33` (`date`),
  UNIQUE KEY `date_34` (`date`),
  UNIQUE KEY `date_35` (`date`),
  UNIQUE KEY `date_36` (`date`),
  UNIQUE KEY `date_37` (`date`),
  UNIQUE KEY `date_38` (`date`),
  UNIQUE KEY `date_39` (`date`),
  UNIQUE KEY `date_40` (`date`),
  UNIQUE KEY `date_41` (`date`),
  UNIQUE KEY `date_42` (`date`),
  UNIQUE KEY `date_43` (`date`),
  UNIQUE KEY `date_44` (`date`),
  UNIQUE KEY `date_45` (`date`),
  UNIQUE KEY `date_46` (`date`),
  UNIQUE KEY `date_47` (`date`),
  UNIQUE KEY `date_48` (`date`),
  UNIQUE KEY `date_49` (`date`),
  UNIQUE KEY `date_50` (`date`),
  UNIQUE KEY `date_51` (`date`),
  UNIQUE KEY `date_52` (`date`),
  UNIQUE KEY `date_53` (`date`),
  UNIQUE KEY `date_54` (`date`),
  UNIQUE KEY `date_55` (`date`),
  UNIQUE KEY `date_56` (`date`),
  UNIQUE KEY `date_57` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- device_tokens  (12 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `device_tokens` (
  `id` int NOT NULL AUTO_INCREMENT,
  `token` varchar(200) NOT NULL,
  `environment` varchar(20) NOT NULL DEFAULT 'production',
  `user_name` varchar(100) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `token` (`token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- inventory_items  (111 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `inventory_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(150) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `quantity` decimal(10,2) NOT NULL DEFAULT '0.00',
  `unit` varchar(30) NOT NULL DEFAULT 'unidades',
  `min_stock` decimal(10,2) DEFAULT '0.00',
  `cost_per_unit` decimal(10,2) DEFAULT '0.00',
  `category` varchar(80) DEFAULT 'general',
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- inventory_movements  (1894 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `inventory_movements` (
  `id` int NOT NULL AUTO_INCREMENT,
  `item_id` int NOT NULL,
  `type` enum('entrada','salida','ajuste') NOT NULL,
  `quantity` decimal(10,2) NOT NULL,
  `reason` varchar(200) DEFAULT NULL,
  `user_name` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `item_id` (`item_id`),
  CONSTRAINT `inventory_movements_ibfk_1` FOREIGN KEY (`item_id`) REFERENCES `inventory_items` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- low_stock_alerts  (24 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `low_stock_alerts` (
  `item_id` int NOT NULL,
  `notified_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- order_items  (420 filas · la crea un modelo de Sequelize)
CREATE TABLE IF NOT EXISTS `order_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_id` int NOT NULL,
  `product_id` int DEFAULT NULL,
  `product_name` varchar(150) NOT NULL,
  `unit_price` decimal(10,2) NOT NULL,
  `quantity` int NOT NULL DEFAULT '1',
  `subtotal` decimal(10,2) NOT NULL,
  `notes` varchar(300) DEFAULT NULL,
  `status` enum('pending','preparing','ready','served','cancelled') DEFAULT 'pending',
  `discount_amount` decimal(10,2) DEFAULT '0.00',
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `order_id` (`order_id`),
  KEY `product_id` (`product_id`),
  CONSTRAINT `order_items_ibfk_1` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `order_items_ibfk_2` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- orders  (164 filas · la crea un modelo de Sequelize)
CREATE TABLE IF NOT EXISTS `orders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_number` varchar(20) NOT NULL,
  `table_id` int DEFAULT NULL,
  `customer_name` varchar(100) DEFAULT NULL,
  `customer_count` int DEFAULT '1',
  `type` enum('dine_in','takeout','delivery') DEFAULT 'dine_in',
  `status` enum('open','in_progress','ready','delivered','paid','cancelled') DEFAULT 'open',
  `notes` text,
  `subtotal` decimal(10,2) DEFAULT '0.00',
  `tax_amount` decimal(10,2) DEFAULT '0.00',
  `discount_amount` decimal(10,2) DEFAULT '0.00',
  `total` decimal(10,2) DEFAULT '0.00',
  `opened_at` datetime DEFAULT NULL,
  `closed_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `order_number` (`order_number`),
  KEY `table_id` (`table_id`),
  CONSTRAINT `orders_ibfk_1` FOREIGN KEY (`table_id`) REFERENCES `tables` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- payments  (165 filas · la crea un modelo de Sequelize)
CREATE TABLE IF NOT EXISTS `payments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_id` int NOT NULL,
  `payment_number` varchar(20) NOT NULL,
  `method` enum('cash','card','transfer','mixed') NOT NULL DEFAULT 'cash',
  `amount_paid` decimal(10,2) NOT NULL,
  `change_given` decimal(10,2) DEFAULT '0.00',
  `tip_amount` decimal(10,2) DEFAULT '0.00',
  `cash_amount` decimal(10,2) DEFAULT '0.00',
  `card_amount` decimal(10,2) DEFAULT '0.00',
  `transfer_amount` decimal(10,2) DEFAULT '0.00',
  `status` enum('pending','completed','refunded','cancelled') DEFAULT 'completed',
  `reference` varchar(100) DEFAULT NULL,
  `notes` text,
  `paid_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `payment_number` (`payment_number`),
  KEY `order_id` (`order_id`),
  CONSTRAINT `payments_ibfk_1` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- pos_cierres  (1 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `pos_cierres` (
  `id` int NOT NULL AUTO_INCREMENT,
  `cierre_date` date NOT NULL,
  `fondo_inicial` decimal(10,2) DEFAULT '0.00',
  `cobros_efectivo` decimal(10,2) DEFAULT '0.00',
  `reembolsos_efectivo` decimal(10,2) DEFAULT '0.00',
  `gastos_dia` decimal(10,2) DEFAULT '0.00',
  `efectivo_teorico` decimal(10,2) DEFAULT '0.00',
  `efectivo_real` decimal(10,2) DEFAULT '0.00',
  `descuadre` decimal(10,2) DEFAULT '0.00',
  `ventas_brutas` decimal(10,2) DEFAULT '0.00',
  `ventas_netas` decimal(10,2) DEFAULT '0.00',
  `efectivo` decimal(10,2) DEFAULT '0.00',
  `tarjeta` decimal(10,2) DEFAULT '0.00',
  `transferencia` decimal(10,2) DEFAULT '0.00',
  `ganancia_neta` decimal(10,2) DEFAULT '0.00',
  `user_name` varchar(100) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `cierre_date` (`cierre_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- pos_expenses  (4 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `pos_expenses` (
  `id` int NOT NULL AUTO_INCREMENT,
  `expense_date` date NOT NULL,
  `description` varchar(255) NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `user_name` varchar(100) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- pos_transactions  (161 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `pos_transactions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `transaction_date` date NOT NULL,
  `table_number` int NOT NULL,
  `person` int DEFAULT '0',
  `method` enum('efectivo','tarjeta','transferencia') NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `items` json NOT NULL,
  `user_name` varchar(100) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_date` (`transaction_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- product_recipes  (35 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `product_recipes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `product_name` varchar(150) NOT NULL,
  `inventory_item_id` int NOT NULL,
  `quantity_used` decimal(10,4) NOT NULL DEFAULT '1.0000',
  `unit` varchar(30) DEFAULT 'unidades',
  `notes` varchar(200) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `inventory_item_id` (`inventory_item_id`),
  KEY `idx_recipe_product` (`product_name`),
  CONSTRAINT `product_recipes_ibfk_1` FOREIGN KEY (`inventory_item_id`) REFERENCES `inventory_items` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- products  (31 filas · la crea un modelo de Sequelize)
CREATE TABLE IF NOT EXISTS `products` (
  `id` int NOT NULL AUTO_INCREMENT,
  `id_key` varchar(50) DEFAULT NULL,
  `name` varchar(150) NOT NULL,
  `description` text,
  `price` decimal(10,2) NOT NULL,
  `cost` decimal(10,2) DEFAULT '0.00',
  `image_url` varchar(500) DEFAULT NULL,
  `sku` varchar(50) DEFAULT NULL,
  `category_id` int NOT NULL,
  `is_available` tinyint(1) DEFAULT '1',
  `is_active` tinyint(1) DEFAULT '1',
  `preparation_time` int DEFAULT '0',
  `sort_order` int DEFAULT '0',
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `stock` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `id_key` (`id_key`),
  UNIQUE KEY `sku` (`sku`),
  KEY `category_id` (`category_id`),
  CONSTRAINT `products_ibfk_1` FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- receta_descontada  (402 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `receta_descontada` (
  `order_item_id` int NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`order_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- recovery_codes  (8 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `recovery_codes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `code_hash` varchar(255) NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `recovery_codes_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- tables  (10 filas · la crea un modelo de Sequelize)
CREATE TABLE IF NOT EXISTS `tables` (
  `id` int NOT NULL AUTO_INCREMENT,
  `number` varchar(10) NOT NULL,
  `name` varchar(50) DEFAULT NULL,
  `capacity` int DEFAULT '4',
  `status` enum('available','occupied','reserved','cleaning') DEFAULT 'available',
  `section` varchar(50) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `number` (`number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- tickets  (14 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `tickets` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(150) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'open',
  `total` decimal(10,2) NOT NULL DEFAULT '0.00',
  `people_count` int NOT NULL DEFAULT '1',
  `user_name` varchar(150) DEFAULT '',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `closed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- totp_attempts  (7 filas · creada a mano / por el código)
CREATE TABLE IF NOT EXISTS `totp_attempts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `attempted_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `success` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- users  (11 filas · la crea un modelo de Sequelize)
CREATE TABLE IF NOT EXISTS `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `role` enum('supervisor','empleado') NOT NULL DEFAULT 'empleado',
  `pin_hash` varchar(255) NOT NULL,
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `two_factor_secret` varchar(255) DEFAULT NULL,
  `two_factor_enabled` tinyint(1) DEFAULT '0',
  `two_factor_confirmed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

SET FOREIGN_KEY_CHECKS = 1;
