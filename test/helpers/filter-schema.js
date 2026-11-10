import { filterColumns } from "../../src/storage/job-filter-values.js";
export const removeFilterSchema =
  "ALTER TABLE companies DROP COLUMN is_blacklisted;" +
  [...filterColumns, "first_seen_at"]
    .map((column) => `DROP INDEX jobs_filter_${column};`)
    .join("") +
  filterColumns
    .map((column) => `ALTER TABLE jobs DROP COLUMN ${column};`)
    .join("");
// Inert historical schema fixture: no AI feature or worker is loaded.
export const revertedChatSchema = `CREATE TABLE chat_conversations(id TEXT,user_id TEXT,title TEXT,created_at TEXT,updated_at TEXT);
CREATE TABLE chat_turns(id TEXT,conversation_id TEXT,user_id TEXT,client_request_id TEXT,question TEXT,status TEXT,phase TEXT,queued_at TEXT,started_at TEXT,ended_at TEXT,result_json TEXT,error_code TEXT,error TEXT);
CREATE TABLE chat_messages(id INTEGER,conversation_id TEXT,user_id TEXT,turn_id TEXT,role TEXT,content TEXT,created_at TEXT);`;
