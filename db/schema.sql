CREATE DATABASE IF NOT EXISTS monteur_webapp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE monteur_webapp;

CREATE TABLE IF NOT EXISTS dispo_import_batches (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    source_system VARCHAR(100) NOT NULL,
    correlation_id VARCHAR(100) NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    payload_json LONGTEXT NOT NULL,
    processing_status ENUM('pending', 'processed', 'failed') NOT NULL DEFAULT 'pending',
    processed_jobs INT UNSIGNED NOT NULL DEFAULT 0,
    processed_absences INT UNSIGNED NOT NULL DEFAULT 0,
    processed_assignments INT UNSIGNED NOT NULL DEFAULT 0,
    error_message TEXT NULL,
    received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_dispo_import_batches_source_corr (source_system, correlation_id),
    INDEX idx_dispo_import_batches_received_at (received_at),
    INDEX idx_dispo_import_batches_correlation_id (correlation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dispo_jobs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    external_job_id VARCHAR(100) NOT NULL,
    customer_name VARCHAR(255) NOT NULL,
    address_street VARCHAR(255) NULL,
    address_postal_code VARCHAR(20) NULL,
    address_city VARCHAR(120) NULL,
    scheduled_date DATE NULL,
    scheduled_time_from TIME NULL,
    scheduled_time_to TIME NULL,
    priority ENUM('low', 'normal', 'high') NOT NULL DEFAULT 'normal',
    status ENUM('planned', 'in_progress', 'done', 'cancelled') NOT NULL DEFAULT 'planned',
    technician_code VARCHAR(100) NULL,
    raw_job_json LONGTEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_dispo_jobs_external_job_id (external_job_id),
    INDEX idx_dispo_jobs_scheduled_date (scheduled_date),
    INDEX idx_dispo_jobs_status (status),
    INDEX idx_dispo_jobs_technician_code (technician_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dispo_absences (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    external_absence_id VARCHAR(100) NOT NULL,
    technician_code VARCHAR(100) NOT NULL,
    date_from DATE NOT NULL,
    date_to DATE NOT NULL,
    type ENUM('vacation', 'sick', 'other') NOT NULL DEFAULT 'other',
    note TEXT NULL,
    raw_absence_json LONGTEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_dispo_absences_external_absence_id (external_absence_id),
    INDEX idx_dispo_absences_technician_code (technician_code),
    INDEX idx_dispo_absences_date_from (date_from),
    INDEX idx_dispo_absences_date_to (date_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dispo_job_assignments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    external_assignment_id VARCHAR(100) NOT NULL,
    external_job_id VARCHAR(100) NOT NULL,
    technician_code VARCHAR(100) NOT NULL,
    role VARCHAR(100) NULL,
    raw_assignment_json LONGTEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_dispo_job_assignments_external_assignment_id (external_assignment_id),
    UNIQUE KEY uq_dispo_job_assignments_job_tech (external_job_id, technician_code),
    INDEX idx_dispo_job_assignments_external_job_id (external_job_id),
    INDEX idx_dispo_job_assignments_technician_code (technician_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
