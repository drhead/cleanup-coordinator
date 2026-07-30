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
    batch_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'AVAILABLE'
);

CREATE TABLE IF NOT EXISTS clusters (
    cluster_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id BIGINT NOT NULL REFERENCES batches(batch_id) ON DELETE CASCADE,
    cluster_index INTEGER NOT NULL,
    custom_note TEXT,
    note TEXT,
    is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
    manual_resolution BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS cluster_posts (
    cluster_id BIGINT NOT NULL REFERENCES clusters(cluster_id) ON DELETE CASCADE,
    post_id BIGINT NOT NULL,
    parent_id BIGINT,
    pool_ids INTEGER[] NOT NULL DEFAULT '{}',
    rating TEXT,
    tags_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_flagged BOOLEAN NOT NULL DEFAULT FALSE,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    image_width INTEGER CHECK (image_width IS NULL OR image_width >= 0),
    image_height INTEGER CHECK (image_height IS NULL OR image_height >= 0),
    image_format TEXT,
    image_quality INTEGER CHECK (image_quality IS NULL OR (image_quality >= 0 AND image_quality <= 101)),
    PRIMARY KEY (cluster_id, post_id)
);

CREATE TABLE IF NOT EXISTS tags (
    tag_name TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    post_count BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS post_tags (
    post_id BIGINT NOT NULL,
    tag_name TEXT NOT NULL REFERENCES tags(tag_name) ON DELETE CASCADE,
    PRIMARY KEY (post_id, tag_name)
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

-- =========================================================================
-- INDEXES
-- =========================================================================

CREATE INDEX IF NOT EXISTS idx_batches_project_id ON batches(project_id);
CREATE INDEX IF NOT EXISTS idx_clusters_batch_id ON clusters(batch_id);
CREATE INDEX IF NOT EXISTS idx_cluster_posts_post_id ON cluster_posts(post_id);
CREATE INDEX IF NOT EXISTS idx_post_flags_lookup ON post_flags(post_id, is_resolved, is_deletion);
CREATE INDEX IF NOT EXISTS idx_tags_category ON tags(category);
CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag_name);

-- GIN Indexes for high-performance array and JSON operations
CREATE INDEX IF NOT EXISTS idx_cluster_posts_pools_gin ON cluster_posts USING GIN (pool_ids);
CREATE INDEX IF NOT EXISTS idx_cluster_posts_tags_jsonb_gin ON cluster_posts USING GIN (tags_json);

-- =========================================================================
-- COMPUTED METRICS VIEW
-- Evaluates discrepancy flags and resolution criteria per cluster
-- =========================================================================

CREATE OR REPLACE VIEW v_cluster_evaluations AS
WITH active_posts AS (
    SELECT 
        cp.cluster_id,
        cp.post_id,
        cp.parent_id,
        cp.rating,
        cp.tags_json,
        cp.pool_ids
    FROM cluster_posts cp
    WHERE cp.is_flagged = FALSE AND cp.is_deleted = FALSE
),
cluster_metrics AS (
    SELECT 
        c.cluster_id,
        COUNT(ap.post_id) AS active_posts_count,
        (COUNT(DISTINCT ap.rating) > 1) AS has_rating_mismatch,
        (
            COUNT(DISTINCT (
                SELECT string_agg(artist_tag, ',' ORDER BY artist_tag)
                FROM jsonb_array_elements_text(ap.tags_json->'ARTIST') AS artist_tag
            )) > 1
        ) AS has_artist_mismatch,

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

-- 1. Synchronize flags onto cluster_posts
CREATE OR REPLACE FUNCTION fn_sync_post_flags()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE cluster_posts
    SET 
        is_flagged = EXISTS (
            SELECT 1 FROM post_flags pf 
            WHERE pf.post_id = NEW.post_id AND pf.is_resolved = FALSE AND pf.is_deletion = FALSE
        ),
        is_deleted = EXISTS (
            SELECT 1 FROM post_flags pf 
            WHERE pf.post_id = NEW.post_id AND pf.is_resolved = FALSE AND pf.is_deletion = TRUE
        )
    WHERE post_id = NEW.post_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_post_flags_insert ON post_flags;
CREATE TRIGGER trg_sync_post_flags_insert
AFTER INSERT ON post_flags
FOR EACH ROW
EXECUTE FUNCTION fn_sync_post_flags();

DROP TRIGGER IF EXISTS trg_sync_post_flags_update ON post_flags;
CREATE TRIGGER trg_sync_post_flags_update
AFTER UPDATE ON post_flags
FOR EACH ROW
EXECUTE FUNCTION fn_sync_post_flags();

-- Sync flags when a new cluster_post row is inserted
CREATE OR REPLACE FUNCTION fn_sync_flags_on_cluster_post_insert()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE cluster_posts
    SET 
        is_flagged = EXISTS (
            SELECT 1 FROM post_flags pf 
            WHERE pf.post_id = NEW.post_id AND pf.is_resolved = FALSE AND pf.is_deletion = FALSE
        ),
        is_deleted = EXISTS (
            SELECT 1 FROM post_flags pf 
            WHERE pf.post_id = NEW.post_id AND pf.is_resolved = FALSE AND pf.is_deletion = TRUE
        )
    WHERE cluster_id = NEW.cluster_id AND post_id = NEW.post_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_post_flags_on_cluster_post_insert ON cluster_posts;
CREATE TRIGGER trg_sync_post_flags_on_cluster_post_insert
AFTER INSERT ON cluster_posts
FOR EACH ROW
EXECUTE FUNCTION fn_sync_flags_on_cluster_post_insert();

-- 2. Recalculate cluster evaluation on cluster_posts metadata changes
CREATE OR REPLACE FUNCTION fn_reevaluate_cluster_from_post()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE clusters
    SET 
        note = v.computed_note,
        is_resolved = v.computed_is_resolved
    FROM v_cluster_evaluations v
    WHERE clusters.cluster_id = NEW.cluster_id AND v.cluster_id = NEW.cluster_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reevaluate_cluster_on_post_change ON cluster_posts;
CREATE TRIGGER trg_reevaluate_cluster_on_post_change
AFTER UPDATE OF parent_id, pool_ids, rating, tags_json, is_flagged, is_deleted ON cluster_posts
FOR EACH ROW
EXECUTE FUNCTION fn_reevaluate_cluster_from_post();

DROP TRIGGER IF EXISTS trg_reevaluate_cluster_on_post_insert ON cluster_posts;
CREATE TRIGGER trg_reevaluate_cluster_on_post_insert
AFTER INSERT ON cluster_posts
FOR EACH ROW
EXECUTE FUNCTION fn_reevaluate_cluster_from_post();

-- 3. Recalculate cluster evaluation on manual resolution or custom note toggles
CREATE OR REPLACE FUNCTION fn_reevaluate_cluster_from_cluster()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE clusters
    SET 
        note = v.computed_note,
        is_resolved = v.computed_is_resolved
    FROM v_cluster_evaluations v
    WHERE clusters.cluster_id = NEW.cluster_id AND v.cluster_id = NEW.cluster_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reevaluate_cluster_on_cluster_change ON clusters;
CREATE TRIGGER trg_reevaluate_cluster_on_cluster_change
AFTER UPDATE OF manual_resolution, custom_note ON clusters
FOR EACH ROW
WHEN (
    OLD.manual_resolution IS DISTINCT FROM NEW.manual_resolution OR
    OLD.custom_note IS DISTINCT FROM NEW.custom_note
)
EXECUTE FUNCTION fn_reevaluate_cluster_from_cluster();