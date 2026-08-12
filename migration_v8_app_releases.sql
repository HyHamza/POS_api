-- Migration v8: App release/update registry (global, not tenant-scoped)
CREATE TABLE IF NOT EXISTS app_releases (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  version               VARCHAR(50)  NOT NULL,
  platform              VARCHAR(20)  NOT NULL DEFAULT 'win',
  exe_url               TEXT         NOT NULL,
  changelog             TEXT         NULL,
  file_size             BIGINT       NULL,             -- bytes, optional
  sha256                VARCHAR(64)  NULL,             -- lowercase hex, optional but recommended
  mandatory             TINYINT(1)   NOT NULL DEFAULT 0, -- RESERVED for future; client ignores it (updates are optional)
  min_supported_version VARCHAR(50)  NULL,             -- reserved for future use
  is_active             TINYINT(1)   NOT NULL DEFAULT 1,
  release_notes_url     VARCHAR(500) NULL,
  created_at            TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_version_platform (version, platform),
  INDEX idx_active_platform (platform, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
