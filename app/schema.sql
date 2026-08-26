CREATE EXTENSION IF NOT EXISTS pg_ivm;
ALTER DATABASE coordinator_db SET TimeZone TO 'UTC';

-- =========================================================================
-- TABLES
-- =========================================================================

CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    instructions_html TEXT,
    resolve_on_parenting BOOLEAN NOT NULL DEFAULT FALSE,
    resolve_on_pools BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS batches (
    batch_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    batch_number INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clusters (
    cluster_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id BIGINT NOT NULL REFERENCES batches(batch_id) ON DELETE CASCADE,
    cluster_index INTEGER NOT NULL,
    custom_note TEXT,
    manual_resolution BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS posts (
    post_id BIGINT PRIMARY KEY,
    parent_id BIGINT,
    pool_ids INTEGER[] NOT NULL DEFAULT '{}',
    rating TEXT,
    tags TEXT[] NOT NULL DEFAULT '{}',
    image_width INTEGER CHECK (image_width IS NULL OR image_width >= 0),
    image_height INTEGER CHECK (image_height IS NULL OR image_height >= 0),
    image_format TEXT,
    image_quality INTEGER CHECK (image_quality IS NULL OR (image_quality >= 0 AND image_quality <= 101)),
    last_refreshed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cluster_posts (
    cluster_id BIGINT NOT NULL REFERENCES clusters(cluster_id) ON DELETE CASCADE,
    post_id BIGINT NOT NULL REFERENCES posts(post_id) ON DELETE CASCADE,
    PRIMARY KEY (cluster_id, post_id)
);

CREATE TABLE IF NOT EXISTS leases (
    ip_address TEXT NOT NULL,
    project_id TEXT NOT NULL,
    batch_id BIGINT NOT NULL REFERENCES batches(batch_id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (ip_address, project_id)
);

CREATE TABLE IF NOT EXISTS post_flags (
    flag_id BIGINT PRIMARY KEY,
    post_id BIGINT NOT NULL,
    is_resolved BOOLEAN NOT NULL,
    is_deletion BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS post_edits (
    edit_id BIGINT PRIMARY KEY,
    post_id BIGINT NOT NULL,
    reason TEXT,
    project_name TEXT,
    updated_at TIMESTAMPTZ NOT NULL
);

-- =========================================================================
-- INDEXES
-- =========================================================================

CREATE INDEX IF NOT EXISTS idx_batches_project_id ON batches(project_id);
CREATE INDEX IF NOT EXISTS idx_clusters_batch_id ON clusters(batch_id);
CREATE INDEX IF NOT EXISTS idx_cluster_posts_post_id ON cluster_posts(post_id);
CREATE INDEX IF NOT EXISTS idx_post_flags_lookup ON post_flags(post_id, is_resolved, is_deletion);

-- Indexes for post_edits lookups
CREATE INDEX IF NOT EXISTS idx_post_edits_post_id ON post_edits(post_id);
CREATE INDEX IF NOT EXISTS idx_post_edits_project_name ON post_edits(project_name);
CREATE INDEX IF NOT EXISTS idx_post_edits_updated_at ON post_edits(updated_at DESC);

-- GIN Indexes for high-performance array operations on posts
CREATE INDEX IF NOT EXISTS idx_posts_pools_gin ON posts USING GIN (pool_ids);
CREATE INDEX IF NOT EXISTS idx_posts_tags_gin ON posts USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_posts_last_refreshed_at ON posts (last_refreshed_at ASC NULLS FIRST);

CREATE INDEX IF NOT EXISTS idx_clusters_batch_index ON clusters(batch_id, cluster_index);
CREATE INDEX IF NOT EXISTS idx_post_flags_pk_only ON post_flags(flag_id);

-- =========================================================================
-- INCREMENTAL MATERIALIZED VIEWS & FLAG MAPPING
-- =========================================================================

-- Raw aggregate counts directly maintained on post_flags changes
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'immv_post_flag_counts') THEN
        PERFORM create_immv(
            'immv_post_flag_counts',
            $query$
            SELECT 
                pf.post_id,
                COUNT(CASE WHEN pf.is_resolved = FALSE AND pf.is_deletion = TRUE THEN 1 END) AS active_deletion_count,
                COUNT(CASE WHEN pf.is_resolved = FALSE AND pf.is_deletion = FALSE THEN 1 END) AS active_flag_count
            FROM post_flags pf
            GROUP BY pf.post_id
            $query$
        );
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_immv_post_flag_counts_post_id ON immv_post_flag_counts(post_id);
ALTER TABLE immv_post_flag_counts REPLICA IDENTITY FULL;

-- Standard view presenting clean boolean state per post
CREATE OR REPLACE VIEW cluster_post_flags AS
SELECT 
    fc.post_id,
    COALESCE(fc.active_deletion_count > 0, FALSE) AS is_deleted,
    COALESCE(fc.active_flag_count > 0, FALSE) AS is_flagged
FROM immv_post_flag_counts fc;

-- =========================================================================
-- COMPUTED METRICS VIEW
-- Evaluates batch lease state dynamically
-- =========================================================================

-- Standard view computing batch status dynamically
CREATE OR REPLACE VIEW v_batches AS
SELECT 
    b.batch_id,
    b.project_id,
    b.batch_number,
    CASE 
        WHEN l.batch_id IS NOT NULL AND l.expires_at > CURRENT_TIMESTAMP THEN 'CLAIMED'
        ELSE 'AVAILABLE'
    END AS status
FROM batches b
LEFT JOIN leases l ON b.batch_id = l.batch_id;