
CREATE TABLE IF NOT EXISTS shops (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_domain VARCHAR(255) NOT NULL,
  access_token_encrypted TEXT NULL,
  scopes TEXT NULL,
  installed_at DATETIME NULL,
  uninstalled_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shops_domain (shop_domain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS composite_products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id BIGINT UNSIGNED NOT NULL,
  shopify_product_id VARCHAR(64) NOT NULL,
  title VARCHAR(255) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  configuration_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shop_product (shop_id, shopify_product_id),
  CONSTRAINT fk_composite_products_shop FOREIGN KEY (shop_id)
    REFERENCES shops(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS component_groups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  composite_product_id BIGINT UNSIGNED NOT NULL,
  group_key VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  selection_type ENUM('single','multiple') NOT NULL DEFAULT 'single',
  is_required TINYINT(1) NOT NULL DEFAULT 1,
  min_selections INT UNSIGNED NOT NULL DEFAULT 1,
  max_selections INT UNSIGNED NULL,
  sort_order INT NOT NULL DEFAULT 0,
  settings_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_groups_product_sort (composite_product_id, sort_order),
  CONSTRAINT fk_component_groups_product FOREIGN KEY (composite_product_id)
    REFERENCES composite_products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS component_options (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  component_group_id BIGINT UNSIGNED NOT NULL,
  shopify_product_id VARCHAR(64) NOT NULL,
  shopify_variant_id VARCHAR(64) NOT NULL,
  option_label VARCHAR(255) NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  price_adjustment DECIMAL(12,2) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_options_group_sort (component_group_id, sort_order),
  CONSTRAINT fk_component_options_group FOREIGN KEY (component_group_id)
    REFERENCES component_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
