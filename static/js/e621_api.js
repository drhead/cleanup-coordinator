// @ts-check

import { getE621User } from './auth.js';

/**
 * Ensures a list of ClusterPost objects have their e621 metadata (fileUrl, description, sources) populated.
 * Posts that already have `fileUrl` set are skipped to avoid redundant API queries.
 * Modifies post objects in-place.
 * 
 * @param {Array<ClusterPost>} clusterPosts
 * @returns {Promise<void>}
 */
export function ensureClusterPostsInfo(clusterPosts) {
    if (!clusterPosts || clusterPosts.length === 0) return Promise.resolve();

    // 1. Filter out posts that already have fileUrl populated
    const missingPosts = clusterPosts.filter(post => !post.fileUrl && post.post_id);
    if (missingPosts.length === 0) return Promise.resolve();

    // 2. Map missing posts by ID for O(1) in-place mutation upon response
    /** @type {Map<number, ClusterPost>} */
    const missingMap = new Map();
    const idsToFetch = [];

    for (const post of missingPosts) {
        const numId = Number(post.post_id);
        if (!isNaN(numId)) {
            missingMap.set(numId, post);
            idsToFetch.push(numId);
        }
    }

    if (idsToFetch.length === 0) return Promise.resolve();

    const idsQuery = idsToFetch.join(',');
    const appAuthor = import.meta.env.VITE_E621_APP_AUTHOR || 'anonymous';
    const user = getE621User();

    /** @type {Record<string, string>} */
    const headers = {
        'User-Agent': `E621CleanupCoordinator/1.0 (by ${appAuthor})`
    };

    if (user) {
        const authString = btoa(`${user.username}:${user.apiKey}`);
        headers['Authorization'] = `Basic ${authString}`;
    }

    // 3. Fetch missing details from e621
    return fetch(`https://e621.net/posts.json?tags=id:${idsQuery} status:any`, { headers })
        .then(res => {
            if (!res.ok) {
                throw new Error(`e621 API returned HTTP ${res.status}`);
            }
            return res.json();
        })
        .then(data => {
            for (const apiPost of (data.posts || [])) {
                const targetPost = missingMap.get(apiPost.id);
                if (targetPost) {
                    // Assign properties directly in-place
                    targetPost.fileUrl = apiPost.file?.url || '';
                    targetPost.description = apiPost.description || '';
                    targetPost.sources = Array.isArray(apiPost.sources) ? apiPost.sources : [];
                }
            }
        });
}