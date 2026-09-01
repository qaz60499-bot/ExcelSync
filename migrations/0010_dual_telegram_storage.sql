-- ExcelSync dual Telegram storage metadata foundation.
-- Existing objects remain Telegram Bot objects; new desktop clients may commit
-- Telegram User Group receipts without storing MTProto credentials in D1.

ALTER TABLE files ADD COLUMN current_storage_backend TEXT;
ALTER TABLE files ADD COLUMN current_storage_locator TEXT;

ALTER TABLE file_versions ADD COLUMN storage_backend TEXT;
ALTER TABLE file_versions ADD COLUMN storage_locator TEXT;

ALTER TABLE upload_intents ADD COLUMN storage_backend TEXT;
ALTER TABLE upload_intents ADD COLUMN storage_locator TEXT;
ALTER TABLE upload_intents ADD COLUMN upload_receipt TEXT;
ALTER TABLE upload_intents ADD COLUMN restored_from_version INTEGER;

UPDATE files
   SET current_storage_backend = COALESCE(current_storage_backend, 'telegram_bot'),
       current_storage_locator = COALESCE(
         current_storage_locator,
         CASE
           WHEN current_telegram_file_id IS NOT NULL AND current_telegram_message_id IS NOT NULL
           THEN json_object('fileId', current_telegram_file_id, 'messageId', current_telegram_message_id)
           ELSE NULL
         END
       );

UPDATE file_versions
   SET storage_backend = COALESCE(storage_backend, 'telegram_bot'),
       storage_locator = COALESCE(
         storage_locator,
         json_object('fileId', telegram_file_id, 'messageId', telegram_message_id)
       );

UPDATE upload_intents
   SET storage_backend = COALESCE(storage_backend, 'telegram_bot'),
       storage_locator = COALESCE(
         storage_locator,
         CASE
           WHEN telegram_file_id IS NOT NULL AND telegram_message_id IS NOT NULL
           THEN json_object('fileId', telegram_file_id, 'messageId', telegram_message_id)
           ELSE NULL
         END
       );

CREATE INDEX IF NOT EXISTS idx_file_versions_backend ON file_versions(storage_backend, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upload_intents_backend_status ON upload_intents(storage_backend, status, updated_at DESC);
