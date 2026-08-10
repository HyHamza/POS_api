-- Migration V5: Add Active Server Lease and Epoch tracking columns to restaurants
ALTER TABLE restaurants ADD COLUMN active_server_id VARCHAR(50) DEFAULT NULL;
ALTER TABLE restaurants ADD COLUMN active_server_epoch INT DEFAULT 0;
