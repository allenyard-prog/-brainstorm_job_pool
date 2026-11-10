// Construct genuine pre-v7 fixtures rather than merely lowering user_version.
export const removeProfileSchema = 'DROP INDEX jobs_preferred_title; ALTER TABLE jobs DROP COLUMN preferred_title_id; DROP TABLE profile_titles; ALTER TABLE connections DROP COLUMN person_name;';
