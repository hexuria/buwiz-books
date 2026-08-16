-- Migration: Drop business_profiles table
-- All business profile data now lives in auth_organizations.metadata JSON

DROP TABLE IF EXISTS "business_profiles";
