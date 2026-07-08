-- Run as the postgres superuser with psql.
-- Change the password before using this on a real network.
CREATE USER processguard WITH PASSWORD 'processguard_dev_password';
CREATE DATABASE processguard OWNER processguard;
GRANT ALL PRIVILEGES ON DATABASE processguard TO processguard;
