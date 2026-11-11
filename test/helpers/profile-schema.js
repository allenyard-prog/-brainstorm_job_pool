// Construct genuine pre-v7 fixtures rather than merely lowering user_version.
export const removeRecommendationSchema = 'DROP TABLE ai_recommendation_jobs; DROP TABLE ai_recommendations; ALTER TABLE jobs DROP COLUMN preferred_title_revision; ALTER TABLE connections DROP COLUMN specialization_prompt; ALTER TABLE connections DROP COLUMN specialization_model_json;';
export const removeProfileSchema = removeRecommendationSchema + 'DROP INDEX jobs_preferred_title; ALTER TABLE jobs DROP COLUMN preferred_title_id; DROP TABLE profile_titles; ALTER TABLE connections DROP COLUMN person_name;';
