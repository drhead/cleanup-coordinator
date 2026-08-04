// @ts-check

/**
 * Fetches high-res file URLs for a list of e621 post IDs.
 * Endpoint response shape: { "posts": [ { "id": number, "file": { "url": string } } ] }
 * 
 * @param {Array<number|string>} postIds
 * @param {{ username: string, apiKey: string } | null} [e621User]
 * @returns {Promise<Map<number, string>>} Map of postId -> direct file URL
 */
export async function fetchPostFileUrls(postIds, e621User = null) {
    if (!postIds || postIds.length === 0) return new Map();

    const idsQuery = postIds.join(',');
    const appAuthor = import.meta.env.VITE_E621_APP_AUTHOR || 'anonymous';
    
    /** @type {Record<string, string>} */
    const headers = {
        'User-Agent': `E621CleanupCoordinator/1.0 (by ${appAuthor})`
    };

    if (e621User?.username && e621User?.apiKey) {
        const authString = btoa(`${e621User.username}:${e621User.apiKey}`);
        headers['Authorization'] = `Basic ${authString}`;
    }

    const res = await fetch(`https://e621.net/posts.json?tags=id:${idsQuery}`, { headers });
    if (!res.ok) {
        throw new Error(`e621 API returned HTTP ${res.status}`);
    }

    const data = await res.json();
    /** @type {Map<number, string>} */
    const urlMap = new Map();

    for (const post of (data.posts || [])) {
        if (post.id && post.file?.url) {
            urlMap.set(post.id, post.file.url);
        }
    }

    return urlMap;
}