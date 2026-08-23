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
    is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
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
-- Evaluates discrepancy flags and resolution criteria per cluster
-- =========================================================================

-- Standard view computing batch status dynamically
CREATE OR REPLACE VIEW v_batches AS
SELECT 
    b.batch_id,
    b.project_id,
    b.batch_number,
    CASE 
        -- Priority 1: All clusters are resolved
        WHEN bool_and(c.is_resolved) = TRUE THEN 'COMPLETE'
        
        -- Priority 2: Active lease exists
        WHEN l.batch_id IS NOT NULL AND l.expires_at > CURRENT_TIMESTAMP THEN 'CLAIMED'
        
        -- Priority 3: Fallback
        ELSE 'AVAILABLE'
    END AS status
FROM batches b
LEFT JOIN clusters c ON b.batch_id = c.batch_id
LEFT JOIN leases l ON b.batch_id = l.batch_id
GROUP BY b.batch_id, b.project_id, b.batch_number, l.batch_id, l.expires_at;

CREATE OR REPLACE VIEW v_cluster_evaluations AS
WITH active_posts AS NOT MATERIALIZED (
    SELECT 
        cp.cluster_id,
        cp.post_id,
        p.parent_id,
        p.pool_ids
    FROM cluster_posts cp
    JOIN posts p ON cp.post_id = p.post_id
    LEFT JOIN immv_post_flag_counts fc ON cp.post_id = fc.post_id
    WHERE COALESCE(fc.active_flag_count > 0, FALSE) = FALSE 
      AND COALESCE(fc.active_deletion_count > 0, FALSE) = FALSE
),
cluster_metrics AS (
    SELECT 
        c.cluster_id,
        COUNT(ap.post_id) AS active_posts_count,

        -- Flagging/Deletion Resolution: Resolved if <= 1 active post remains
        (COUNT(ap.post_id) <= 1) AS is_flag_resolved,

        -- Pool Resolution: Active posts share at least one common pool ID
        (
            COUNT(ap.post_id) >= 2 AND EXISTS (
                SELECT 1
                FROM active_posts ap_inner,
                     unnest(ap_inner.pool_ids) AS pool_elem
                WHERE ap_inner.cluster_id = c.cluster_id
                GROUP BY pool_elem
                HAVING COUNT(DISTINCT ap_inner.post_id) = (
                    SELECT COUNT(*) 
                    FROM active_posts ap_cnt 
                    WHERE ap_cnt.cluster_id = c.cluster_id
                )
            )
        ) AS is_pool_resolved,

        -- Parentage Resolution: Shared parent or cluster-internal tree parent
        (
            COUNT(ap.post_id) >= 2 AND (
                (
                    COUNT(ap.parent_id) = COUNT(ap.post_id)
                    AND COUNT(DISTINCT ap.parent_id) = 1
                )
                OR
                EXISTS (
                    SELECT 1
                    FROM cluster_posts cp_parent
                    WHERE cp_parent.cluster_id = c.cluster_id
                      AND (
                          SELECT COUNT(*)
                          FROM active_posts ap_child
                          WHERE ap_child.cluster_id = c.cluster_id
                            AND ap_child.post_id != cp_parent.post_id
                            AND ap_child.parent_id = cp_parent.post_id
                      ) = (
                          SELECT COUNT(*)
                          FROM active_posts ap_other
                          WHERE ap_other.cluster_id = c.cluster_id
                            AND ap_other.post_id != cp_parent.post_id
                      )
                )
            )
        ) AS is_parenting_resolved

    FROM clusters c
    LEFT JOIN active_posts ap ON c.cluster_id = ap.cluster_id
    GROUP BY c.cluster_id
)
SELECT 
    c.cluster_id,
    (
        c.manual_resolution = TRUE 
        OR m.is_flag_resolved = TRUE
        OR (p.resolve_on_pools = TRUE AND m.is_pool_resolved = TRUE)
        OR (p.resolve_on_parenting = TRUE AND m.is_parenting_resolved = TRUE)
    ) AS computed_is_resolved

FROM clusters c
JOIN batches b ON c.batch_id = b.batch_id
JOIN projects p ON b.project_id = p.project_id
LEFT JOIN cluster_metrics m ON c.cluster_id = m.cluster_id;

-- =========================================================================
-- TRIGGER FUNCTIONS & TRIGGERS
-- =========================================================================

-- 1. Batch recalculate cluster evaluation on posts metadata changes
CREATE OR REPLACE FUNCTION fn_reevaluate_cluster_from_post_batch()
RETURNS TRIGGER AS $$
BEGIN
    -- Fast early exit if no metadata columns were modified (e.g. only last_refreshed_at was updated)
    IF NOT EXISTS (
        SELECT 1
        FROM new_table n
        JOIN old_table o ON n.post_id = o.post_id
        WHERE n.parent_id IS DISTINCT FROM o.parent_id
           OR n.pool_ids IS DISTINCT FROM o.pool_ids
           OR n.tags IS DISTINCT FROM o.tags
           OR n.rating IS DISTINCT FROM o.rating
    ) THEN
        RETURN NULL;
    END IF;

    UPDATE clusters
    SET is_resolved = v.computed_is_resolved
    FROM (
        SELECT DISTINCT cp.cluster_id
        FROM new_table n
        JOIN old_table o ON n.post_id = o.post_id
        JOIN cluster_posts cp ON n.post_id = cp.post_id
        WHERE n.parent_id IS DISTINCT FROM o.parent_id
           OR n.pool_ids IS DISTINCT FROM o.pool_ids
           OR n.tags IS DISTINCT FROM o.tags
           OR n.rating IS DISTINCT FROM o.rating
    ) affected
    JOIN v_cluster_evaluations v ON affected.cluster_id = v.cluster_id
    WHERE clusters.cluster_id = affected.cluster_id
      AND clusters.is_resolved != v.computed_is_resolved;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reevaluate_cluster_on_post_change ON posts;
CREATE TRIGGER trg_reevaluate_cluster_on_post_change
AFTER UPDATE ON posts
REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
FOR EACH STATEMENT
EXECUTE FUNCTION fn_reevaluate_cluster_from_post_batch();

-- 2. Recalculate cluster evaluation on cluster_posts insertions
CREATE OR REPLACE FUNCTION fn_reevaluate_cluster_from_cluster_post_insert()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE clusters
    SET is_resolved = v.computed_is_resolved
    FROM (
        SELECT DISTINCT cluster_id FROM new_table
    ) affected
    JOIN v_cluster_evaluations v ON affected.cluster_id = v.cluster_id
    WHERE clusters.cluster_id = affected.cluster_id
      AND clusters.is_resolved != v.computed_is_resolved;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reevaluate_cluster_on_cluster_post_insert ON cluster_posts;
CREATE TRIGGER trg_reevaluate_cluster_on_cluster_post_insert
AFTER INSERT ON cluster_posts
REFERENCING NEW TABLE AS new_table
FOR EACH STATEMENT
EXECUTE FUNCTION fn_reevaluate_cluster_from_cluster_post_insert();

-- 3. Recalculate cluster evaluation on cluster_posts deletions
CREATE OR REPLACE FUNCTION fn_reevaluate_cluster_from_cluster_post_delete()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE clusters
    SET is_resolved = v.computed_is_resolved
    FROM (
        SELECT DISTINCT cluster_id FROM old_table
    ) affected
    JOIN v_cluster_evaluations v ON affected.cluster_id = v.cluster_id
    WHERE clusters.cluster_id = affected.cluster_id
      AND clusters.is_resolved != v.computed_is_resolved;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reevaluate_cluster_on_cluster_post_delete ON cluster_posts;
CREATE TRIGGER trg_reevaluate_cluster_on_cluster_post_delete
AFTER DELETE ON cluster_posts
REFERENCING OLD TABLE AS old_table
FOR EACH STATEMENT
EXECUTE FUNCTION fn_reevaluate_cluster_from_cluster_post_delete();

-- 4. Recalculate cluster evaluation on manual resolution or custom note toggles
CREATE OR REPLACE FUNCTION fn_reevaluate_cluster_from_cluster()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE clusters
    SET is_resolved = v.computed_is_resolved
    FROM v_cluster_evaluations v
    WHERE clusters.cluster_id = NEW.cluster_id AND v.cluster_id = NEW.cluster_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reevaluate_cluster_on_cluster_change ON clusters;
CREATE TRIGGER trg_reevaluate_cluster_on_cluster_change
AFTER UPDATE OF manual_resolution, custom_note ON clusters
FOR EACH ROW
WHEN (OLD.manual_resolution IS DISTINCT FROM NEW.manual_resolution)
EXECUTE FUNCTION fn_reevaluate_cluster_from_cluster();

-- 5. Scoped recalculate cluster evaluation on post_flags changes
CREATE OR REPLACE FUNCTION fn_reevaluate_cluster_from_post_flag_batch()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE clusters
    SET is_resolved = v.computed_is_resolved
    FROM (
        SELECT DISTINCT cp.cluster_id
        FROM new_table n
        JOIN cluster_posts cp ON n.post_id = cp.post_id
    ) affected
    JOIN v_cluster_evaluations v ON affected.cluster_id = v.cluster_id
    WHERE clusters.cluster_id = affected.cluster_id
      AND clusters.is_resolved != v.computed_is_resolved;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reevaluate_cluster_on_post_flag_change ON post_flags;
DROP TRIGGER IF EXISTS trg_reevaluate_cluster_on_post_flag_insert ON post_flags;
DROP TRIGGER IF EXISTS trg_reevaluate_cluster_on_post_flag_update ON post_flags;

CREATE TRIGGER trg_reevaluate_cluster_on_post_flag_insert
AFTER INSERT ON post_flags
REFERENCING NEW TABLE AS new_table
FOR EACH STATEMENT
EXECUTE FUNCTION fn_reevaluate_cluster_from_post_flag_batch();

CREATE TRIGGER trg_reevaluate_cluster_on_post_flag_update
AFTER UPDATE ON post_flags
REFERENCING NEW TABLE AS new_table
FOR EACH STATEMENT
EXECUTE FUNCTION fn_reevaluate_cluster_from_post_flag_batch();