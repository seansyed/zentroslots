/**
 * Loaded via `tsx --import` BEFORE any test module evaluates. Sets the
 * environment variables that production modules expect at import time
 * (DB client throws on missing DATABASE_URL; the JWT helpers expect a
 * secret). Tests that hit a real DB are reserved for the production
 * smoke phase — here we just need module imports to succeed.
 */
process.env.DATABASE_URL ??=
  "postgres://test:test@localhost:5432/test_unused";
process.env.JWT_SECRET ??=
  "test-secret-must-be-long-enough-for-hmac-please";
process.env.COMMS_ENCRYPTION_KEY ??=
  "0".repeat(64); // 32-byte hex key for crypto helper at import-time
