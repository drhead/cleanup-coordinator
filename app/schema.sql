-- =========================================================================
-- TABLES
-- =========================================================================

CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    instructions_html TEXT,
    resolve_on_parenting BOOLEAN DEFAULT FALSE,
    resolve_on_pools BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS batches (
    batch_id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    batch_number INTEGER NOT NULL,
    status TEXT DEFAULT 'AVAILABLE',
    FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

CREATE TABLE IF NOT EXISTS clusters (
    cluster_id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    cluster_index INTEGER NOT NULL,
    custom_note TEXT,
    note TEXT,
    is_resolved BOOLEAN DEFAULT FALSE,
    manual_resolution BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (batch_id) REFERENCES batches(batch_id)
);

CREATE TABLE IF NOT EXISTS cluster_posts (
    cluster_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    parent_id INTEGER,
    pool_ids TEXT DEFAULT '[]',
    rating TEXT,
    tags_json TEXT DEFAULT '{}',
    is_flagged BOOLEAN DEFAULT FALSE,
    is_deleted BOOLEAN DEFAULT FALSE,
    image_width INTEGER CHECK (image_width IS NULL OR image_width >= 0),
    image_height INTEGER CHECK (image_height IS NULL OR image_height >= 0),
    image_format TEXT,
    image_quality INTEGER CHECK (image_quality IS NULL OR (image_quality >= 0 AND image_quality <= 101)),
    PRIMARY KEY (cluster_id, post_id),
    FOREIGN KEY (cluster_id) REFERENCES clusters(cluster_id)
);

CREATE TABLE IF NOT EXISTS leases (
    ip_address TEXT NOT NULL,
    project_id TEXT NOT NULL,
    batch_id INTEGER NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    PRIMARY KEY (ip_address, project_id),
    FOREIGN KEY (batch_id) REFERENCES batches(batch_id)
);

CREATE TABLE IF NOT EXISTS post_flags (
    flag_id INTEGER PRIMARY KEY,
    post_id INTEGER NOT NULL,
    is_resolved BOOLEAN NOT NULL,
    is_deletion BOOLEAN NOT NULL
);

-- =========================================================================
-- INDEXES
-- =========================================================================

CREATE INDEX IF NOT EXISTS idx_post_flags_lookup 
ON post_flags(post_id, is_resolved, is_deletion);

CREATE INDEX IF NOT EXISTS idx_cluster_posts_post_id 
ON cluster_posts(post_id);

-- =========================================================================
-- COMPUTED METRICS VIEW
-- Evaluates discrepancy flags and resolution criteria per cluster
-- =========================================================================

DROP VIEW IF EXISTS v_cluster_evaluations;
CREATE VIEW v_cluster_evaluations AS
WITH active_posts AS (
    SELECT 
        cp.cluster_id,
        cp.post_id,
        cp.parent_id,
        cp.rating,
        cp.tags_json,
        cp.pool_ids
    FROM cluster_posts cp
    WHERE cp.is_flagged = 0 AND cp.is_deleted = 0
),
cluster_metrics AS (
    SELECT 
        c.cluster_id,
        
        COUNT(ap.post_id) AS active_posts_count,

        (COUNT(DISTINCT ap.rating) > 1) AS has_rating_mismatch,
        (
            COUNT(DISTINCT (
                SELECT GROUP_CONCAT(artist_tag.value, ',')
                FROM (
                    SELECT value 
                    FROM json_each(json_extract(ap.tags_json, '$.ARTIST'))
                    ORDER BY value ASC
                ) AS artist_tag
            )) > 1
        ) AS has_artist_mismatch,

        -- Flagging/Deletion Resolution: Resolved if <= 1 active post remains
        CAST(COUNT(ap.post_id) <= 1 AS BOOLEAN) AS is_flag_resolved,

        -- Pool Resolution: All active posts share at least one common pool ID
        CAST(
            COUNT(ap.post_id) >= 2 AND EXISTS (
                SELECT 1
                FROM active_posts ap_inner,
                     json_each(ap_inner.pool_ids) pool_elem
                WHERE ap_inner.cluster_id = c.cluster_id
                GROUP BY pool_elem.value
                HAVING COUNT(DISTINCT ap_inner.post_id) = (
                    SELECT COUNT(*) 
                    FROM active_posts ap_cnt 
                    WHERE ap_cnt.cluster_id = c.cluster_id
                )
            ) AS BOOLEAN
        ) AS is_pool_resolved,

        -- Parentage Resolution: Shared external parent or single cluster-parent tree
        CAST(
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
            ) AS BOOLEAN
        ) AS is_parenting_resolved

    FROM clusters c
    LEFT JOIN active_posts ap ON c.cluster_id = ap.cluster_id
    GROUP BY c.cluster_id
)
SELECT 
    c.cluster_id,
    
    CASE 
        WHEN c.custom_note IS NOT NULL AND m.has_rating_mismatch AND m.has_artist_mismatch 
            THEN c.custom_note || ' | Rating Mismatch | Artist Tags Different'
        WHEN c.custom_note IS NOT NULL AND m.has_rating_mismatch 
            THEN c.custom_note || ' | Rating Mismatch'
        WHEN c.custom_note IS NOT NULL AND m.has_artist_mismatch 
            THEN c.custom_note || ' | Artist Tags Different'
        WHEN c.custom_note IS NOT NULL 
            THEN c.custom_note
        WHEN m.has_rating_mismatch AND m.has_artist_mismatch 
            THEN 'Rating Mismatch | Artist Tags Different'
        WHEN m.has_rating_mismatch 
            THEN 'Rating Mismatch'
        WHEN m.has_artist_mismatch 
            THEN 'Artist Tags Different'
        ELSE NULL
    END AS computed_note,

    CAST(
        c.manual_resolution = 1 
        OR m.is_flag_resolved = 1
        OR (p.resolve_on_pools = 1 AND m.is_pool_resolved = 1)
        OR (p.resolve_on_parenting = 1 AND m.is_parenting_resolved = 1)
    AS BOOLEAN) AS computed_is_resolved

FROM clusters c
JOIN batches b ON c.batch_id = b.batch_id
JOIN projects p ON b.project_id = p.project_id
LEFT JOIN cluster_metrics m ON c.cluster_id = m.cluster_id;

-- =========================================================================
-- TRIGGERS
-- =========================================================================

-- 1. Sync is_flagged & is_deleted on cluster_posts from post_flags
DROP TRIGGER IF EXISTS trg_sync_post_flags_insert;
CREATE TRIGGER trg_sync_post_flags_insert
AFTER INSERT ON post_flags
WHEN EXISTS (SELECT 1 FROM cluster_posts WHERE post_id = NEW.post_id)
BEGIN
    UPDATE cluster_posts
    SET 
        is_flagged = EXISTS (
            SELECT 1 FROM post_flags pf 
            WHERE pf.post_id = NEW.post_id AND pf.is_resolved = 0 AND pf.is_deletion = 0
        ),
        is_deleted = EXISTS (
            SELECT 1 FROM post_flags pf 
            WHERE pf.post_id = NEW.post_id AND pf.is_resolved = 0 AND pf.is_deletion = 1
        )
    WHERE post_id = NEW.post_id;
END;

DROP TRIGGER IF EXISTS trg_sync_post_flags_update;
CREATE TRIGGER trg_sync_post_flags_update
AFTER UPDATE ON post_flags
WHEN EXISTS (SELECT 1 FROM cluster_posts WHERE post_id = NEW.post_id)
BEGIN
    UPDATE cluster_posts
    SET 
        is_flagged = EXISTS (
            SELECT 1 FROM post_flags pf 
            WHERE pf.post_id = NEW.post_id AND pf.is_resolved = 0 AND pf.is_deletion = 0
        ),
        is_deleted = EXISTS (
            SELECT 1 FROM post_flags pf 
            WHERE pf.post_id = NEW.post_id AND pf.is_resolved = 0 AND pf.is_deletion = 1
        )
    WHERE post_id = NEW.post_id;
END;

DROP TRIGGER IF EXISTS trg_sync_post_flags_on_cluster_post_insert;
CREATE TRIGGER trg_sync_post_flags_on_cluster_post_insert
AFTER INSERT ON cluster_posts
BEGIN
    UPDATE cluster_posts
    SET 
        is_flagged = EXISTS (
            SELECT 1 FROM post_flags pf 
            WHERE pf.post_id = NEW.post_id AND pf.is_resolved = 0 AND pf.is_deletion = 0
        ),
        is_deleted = EXISTS (
            SELECT 1 FROM post_flags pf 
            WHERE pf.post_id = NEW.post_id AND pf.is_resolved = 0 AND pf.is_deletion = 1
        )
    WHERE cluster_id = NEW.cluster_id AND post_id = NEW.post_id;
END;

-- 2. Recalculate cluster evaluation whenever cluster_posts metadata changes
DROP TRIGGER IF EXISTS trg_reevaluate_cluster_on_post_change;
CREATE TRIGGER trg_reevaluate_cluster_on_post_change
AFTER UPDATE OF parent_id, pool_ids, rating, tags_json, is_flagged, is_deleted ON cluster_posts
BEGIN
    UPDATE clusters
    SET 
        note = (SELECT computed_note FROM v_cluster_evaluations WHERE cluster_id = NEW.cluster_id),
        is_resolved = (SELECT computed_is_resolved FROM v_cluster_evaluations WHERE cluster_id = NEW.cluster_id)
    WHERE cluster_id = NEW.cluster_id;
END;

DROP TRIGGER IF EXISTS trg_reevaluate_cluster_on_post_insert;
CREATE TRIGGER trg_reevaluate_cluster_on_post_insert
AFTER INSERT ON cluster_posts
BEGIN
    UPDATE clusters
    SET 
        note = (SELECT computed_note FROM v_cluster_evaluations WHERE cluster_id = NEW.cluster_id),
        is_resolved = (SELECT computed_is_resolved FROM v_cluster_evaluations WHERE cluster_id = NEW.cluster_id)
    WHERE cluster_id = NEW.cluster_id;
END;

-- 3. Recalculate cluster evaluation on manual resolution or custom note toggles
DROP TRIGGER IF EXISTS trg_reevaluate_cluster_on_cluster_change;
CREATE TRIGGER trg_reevaluate_cluster_on_cluster_change
AFTER UPDATE OF manual_resolution, custom_note ON clusters
BEGIN
    UPDATE clusters
    SET 
        note = (SELECT computed_note FROM v_cluster_evaluations WHERE cluster_id = NEW.cluster_id),
        is_resolved = (SELECT computed_is_resolved FROM v_cluster_evaluations WHERE cluster_id = NEW.cluster_id)
    WHERE cluster_id = NEW.cluster_id;
END;