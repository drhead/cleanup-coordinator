\timing on
\set ON_ERROR_STOP on

-- Hard limit: Any query or trigger taking > 5s is killed immediately
SET statement_timeout = 5000;

-- =========================================================================
-- SCENARIO 1: Bulk flag ingestion (320 flags) (based on flag_worker.py:fetch_all_new_flags)
-- =========================================================================
\echo '=========================================='
\echo 'SCENARIO 1: Bulk flag ingestion (320 flags)'
\echo '=========================================='

BEGIN;

CREATE TEMP TABLE _test_flags AS
WITH existing AS (
    SELECT flag_id, post_id, is_resolved, is_deletion
    FROM post_flags
    ORDER BY flag_id DESC
    LIMIT 300
),
synthetic AS (
    SELECT 
        COALESCE((SELECT MAX(flag_id) FROM post_flags), 0) + gs AS flag_id,
        (10000000 + gs)::bigint AS post_id,
        false AS is_resolved,
        (gs % 2 = 0) AS is_deletion
    FROM generate_series(1, 20) gs
)
SELECT * FROM existing
UNION ALL
SELECT * FROM synthetic;

\echo '--- EXPLAIN ANALYZE: Bulk UNNEST upsert (320 flags) ---'
EXPLAIN (ANALYZE, BUFFERS, TIMING)
INSERT INTO post_flags (flag_id, post_id, is_resolved, is_deletion)
SELECT * FROM UNNEST(
    (SELECT array_agg(flag_id) FROM _test_flags)::bigint[],
    (SELECT array_agg(post_id) FROM _test_flags)::bigint[],
    (SELECT array_agg(is_resolved) FROM _test_flags)::bool[],
    (SELECT array_agg(is_deletion) FROM _test_flags)::bool[]
)
ON CONFLICT (flag_id) DO UPDATE SET
    post_id = EXCLUDED.post_id,
    is_resolved = EXCLUDED.is_resolved,
    is_deletion = EXCLUDED.is_deletion;

DROP TABLE _test_flags;
COMMIT;

-- =========================================================================
-- SCENARIO 2: Per-post flag refresh (based on flag_worker.py:refresh_post_flags)
-- =========================================================================
\echo ''
\echo '=========================================='
\echo 'SCENARIO 2: Per-post flag refresh'
\echo '=========================================='

BEGIN;

CREATE TEMP TABLE _test_post AS
SELECT pf.flag_id, pf.post_id, pf.is_resolved, pf.is_deletion
FROM post_flags pf
JOIN cluster_posts cp ON pf.post_id = cp.post_id
LIMIT 5;

\echo '--- EXPLAIN ANALYZE: Per-post flag upsert ---'
EXPLAIN (ANALYZE, BUFFERS, TIMING)
INSERT INTO post_flags (flag_id, post_id, is_resolved, is_deletion)
SELECT * FROM UNNEST(
    (SELECT array_agg(flag_id) FROM _test_post)::bigint[],
    (SELECT array_agg(post_id) FROM _test_post)::bigint[],
    (SELECT array_agg(is_resolved) FROM _test_post)::bool[],
    (SELECT array_agg(is_deletion) FROM _test_post)::bool[]
)
ON CONFLICT (flag_id) DO UPDATE SET
    post_id = EXCLUDED.post_id,
    is_resolved = EXCLUDED.is_resolved,
    is_deletion = EXCLUDED.is_deletion;

DROP TABLE _test_post;
COMMIT;

-- =========================================================================
-- SCENARIO 3: get_project_batches (based on routes/projects.py:get_project_batches)
-- =========================================================================
\echo ''
\echo '=========================================='
\echo 'SCENARIO 3: get_project_batches'
\echo '=========================================='

\echo '--- EXPLAIN ANALYZE: v_batches query ---'
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT batch_id, project_id, batch_number, status
FROM v_batches 
WHERE project_id = (SELECT project_id FROM projects LIMIT 1)
ORDER BY batch_number ASC;

\echo ''
\echo '--- EXPLAIN ANALYZE: Flat cluster+post data query ---'
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT c.batch_id, c.cluster_id, c.cluster_index, c.custom_note AS note, c.is_resolved, 
       c.manual_resolution, cp.post_id, p.parent_id, p.pool_ids, 
       p.rating, p.tags,
       p.image_width, p.image_height, p.image_format, p.image_quality,
       COALESCE(fc.active_deletion_count > 0, FALSE) AS is_deleted, 
       COALESCE(fc.active_flag_count > 0, FALSE) AS is_flagged,
       EXISTS(SELECT 1 FROM post_edits pe WHERE pe.post_id = cp.post_id) AS is_edited
FROM clusters c
JOIN batches b ON c.batch_id = b.batch_id
LEFT JOIN cluster_posts cp ON c.cluster_id = cp.cluster_id
LEFT JOIN posts p ON cp.post_id = p.post_id
LEFT JOIN immv_post_flag_counts fc ON cp.post_id = fc.post_id
WHERE b.project_id = (SELECT project_id FROM projects LIMIT 1)
ORDER BY c.batch_id ASC, c.cluster_index ASC, cp.post_id ASC;

-- =========================================================================
-- SCENARIO 4: refresh_posts_metadata (320 posts) (based on post_worker.py:refresh_posts_metadata)
-- =========================================================================
\echo ''
\echo '=========================================='
\echo 'SCENARIO 4: refresh_posts_metadata (320 posts)'
\echo '=========================================='

\echo '--- EXPLAIN ANALYZE: Stalest posts selection query ---'
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT post_id
FROM posts
ORDER BY last_refreshed_at ASC NULLS FIRST
LIMIT 320;

\echo ''
\echo '--- EXPLAIN ANALYZE: Flag state verification query ---'
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT post_id, is_flagged, is_deleted
FROM cluster_post_flags
WHERE post_id = ANY(
    (SELECT array_agg(post_id) FROM (SELECT post_id FROM posts ORDER BY last_refreshed_at ASC NULLS FIRST LIMIT 320) t)::bigint[]
);

\echo ''
\echo '--- EXPLAIN ANALYZE: Bulk UPDATE posts (Metadata) ---'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, TIMING)
UPDATE posts p
SET parent_id = u.parent_id,
    pool_ids = u.pool_ids::int[],
    tags = u.tags::text[],
    rating = u.rating
FROM UNNEST(
    (SELECT array_agg(parent_id) FROM (SELECT parent_id FROM posts LIMIT 320) t)::bigint[],
    (SELECT array_agg(pool_ids::text) FROM (SELECT pool_ids FROM posts LIMIT 320) t)::text[],
    (SELECT array_agg(tags::text) FROM (SELECT tags FROM posts LIMIT 320) t)::text[],
    (SELECT array_agg(rating) FROM (SELECT rating FROM posts LIMIT 320) t)::text[],
    (SELECT array_agg(post_id) FROM (SELECT post_id FROM posts LIMIT 320) t)::bigint[]
) AS u(parent_id, pool_ids, tags, rating, post_id)
WHERE p.post_id = u.post_id
AND (
    p.parent_id IS DISTINCT FROM u.parent_id OR
    p.pool_ids IS DISTINCT FROM u.pool_ids::int[] OR
    p.tags IS DISTINCT FROM u.tags::text[] OR
    p.rating IS DISTINCT FROM u.rating
);

\echo ''
\echo '--- EXPLAIN ANALYZE: Bulk UPDATE posts (last_refreshed_at only) ---'
EXPLAIN (ANALYZE, BUFFERS, TIMING)
UPDATE posts
SET last_refreshed_at = CURRENT_TIMESTAMP
WHERE post_id = ANY(
    (SELECT array_agg(post_id) FROM (SELECT post_id FROM posts LIMIT 320) t)::bigint[]
);
COMMIT;

-- =========================================================================
-- SCENARIO 5: Bulk post_edits ingestion (320 edits) & lookups
-- =========================================================================
\echo ''
\echo '=========================================='
\echo 'SCENARIO 5: Bulk post_edits ingestion (320 edits)'
\echo '=========================================='

BEGIN;

CREATE TEMP TABLE _test_edits AS
WITH synthetic AS (
    SELECT 
        COALESCE((SELECT MAX(edit_id) FROM post_edits), 0) + gs AS edit_id,
        (10000000 + (gs % 100))::bigint AS post_id,
        'Edited from P.A.C.K. Editor, part of "test_project" project.' AS reason,
        'test_project' AS project_name,
        CURRENT_TIMESTAMP AS updated_at
    FROM generate_series(1, 320) gs
)
SELECT * FROM synthetic;

\echo '--- EXPLAIN ANALYZE: Bulk UNNEST upsert (320 post_edits) ---'
EXPLAIN (ANALYZE, BUFFERS, TIMING)
INSERT INTO post_edits (edit_id, post_id, reason, project_name, updated_at)
SELECT * FROM UNNEST(
    (SELECT array_agg(edit_id) FROM _test_edits)::bigint[],
    (SELECT array_agg(post_id) FROM _test_edits)::bigint[],
    (SELECT array_agg(reason) FROM _test_edits)::text[],
    (SELECT array_agg(project_name) FROM _test_edits)::text[],
    (SELECT array_agg(updated_at) FROM _test_edits)::timestamptz[]
)
ON CONFLICT (edit_id) DO UPDATE SET
    post_id = EXCLUDED.post_id,
    reason = EXCLUDED.reason,
    project_name = EXCLUDED.project_name,
    updated_at = EXCLUDED.updated_at;

\echo ''
\echo '--- EXPLAIN ANALYZE: Post edits lookup by post_id ---'
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT edit_id, post_id, reason, project_name, updated_at
FROM post_edits
WHERE post_id = 10000001
ORDER BY updated_at DESC;

DROP TABLE _test_edits;
COMMIT;