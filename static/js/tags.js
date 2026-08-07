// @ts-check

import { decode } from '@msgpack/msgpack';
import { showToast } from './toasts.js';

/** @type {Record<number, TagCategory>} */
const CATEGORY_MAP = {
    0: 'GENERAL',
    1: 'ARTIST',
    2: 'CONTRIBUTOR',
    3: 'COPYRIGHT',
    4: 'CHARACTER',
    5: 'SPECIES',
    6: 'INVALID',
    7: 'META',
    8: 'LORE'
};

/**
 * @typedef {Object} TagInfo
 * @property {string[]} [implies]
 * @property {string[]} [implied_by]
 * @property {TagCategory} category
 * @property {number} tag_count
 * @property {string} [alias_to]
 */

/**
 * @typedef {Record<string, TagInfo>} TagInfoMap
 */

/**
 * @typedef {Object} RawTagBundleEntry
 * @property {number} category
 * @property {number} count
 * @property {string[]} [implies]
 * @property {string[]} [implied_by]
 * @property {string|null} [alias_to]
 */

/**
 * Yields execution back to the browser event loop so DOM updates & animations can render.
 * @returns {Promise<void>}
 */
const yieldToMain = () => new Promise(resolve => setTimeout(resolve, 0));

export class TagManager {
    constructor() {
        /** @type {TagInfoMap} */
        this.tagInfoMap = {};
        /** @type {string[]} Binary-search indexed array of sorted tag names & aliases */
        this.searchKeys = [];
        this.isLoaded = false;

        // --- Loading Screen Hooks ---
        this.isLoading = false;
        this.loadingProgress = 0; // 0 to 100%
        this.loadingStatus = 'Idle'; // Text feedback for UI
        this.error = null;
    }

    /**
     * Helper to update progress state and report to caller.
     * @param {string} status 
     * @param {number} percent 
     * @param {((status: string, percent: number) => void)} [onProgress]
     */
    _reportProgress(status, percent, onProgress) {
        this.loadingStatus = status;
        this.loadingProgress = percent;
        if (onProgress) {
            onProgress(status, percent);
        }
    }

    /**
     * Initializes and loads the consolidated MessagePack data file into tagInfoMap
     * and builds the prefix search index.
     * @param {((status: string, percent: number) => void)} [onProgress] Optional progress callback
     */
    async init(onProgress) {
        if (this.isLoading || this.isLoaded) return;

        this.isLoading = true;
        this.error = null;
        this._reportProgress('Fetching tag bundle...', 10, onProgress);
        await yieldToMain();

        try {
            const response = await fetch('/static/data/tags_bundle.msgpack', {
                headers: { 'Accept': 'application/msgpack' }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            this._reportProgress('Unpacking tag bundle...', 50, onProgress);
            await yieldToMain();

            const buffer = await response.arrayBuffer();
            const rawBundle = /** @type {Record<string, RawTagBundleEntry>} */ (decode(buffer)) || {};

            this._reportProgress('Processing tag graph...', 75, onProgress);
            await yieldToMain();

            /** @type {TagInfoMap} */
            const parsedMap = {};

            for (const [tag, entry] of Object.entries(rawBundle)) {
                /** @type {TagInfo} */
                const info = {
                    category: CATEGORY_MAP[entry.category] || 'GENERAL',
                    tag_count: entry.count ?? 0
                };

                if (entry.implies && entry.implies.length > 0) {
                    info.implies = entry.implies;
                }
                if (entry.implied_by && entry.implied_by.length > 0) {
                    info.implied_by = entry.implied_by;
                }
                if (entry.alias_to) {
                    info.alias_to = entry.alias_to;
                }

                parsedMap[tag] = info;
            }

            this.tagInfoMap = parsedMap;

            this._reportProgress('Building search index...', 90, onProgress);
            await yieldToMain();

            // Build sorted key array for fast binary-search prefix matching
            this.searchKeys = Object.keys(parsedMap).sort();

            this._reportProgress('Tag data ready', 100, onProgress);
            await yieldToMain();
            this.isLoaded = true;
        } catch (err) {
            console.error('[TagManager] Failed to load tag data:', err);
            // @ts-expect-error
            this.error = err.message || 'Failed to load tag data';
            showToast('Failed to load tag metadata.', 'error');
            throw err; // Re-throw so app.js catch block catches it
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Resolves an alias string to its canonical target tag name.
     * @param {string} tag
     * @returns {string}
     */
    resolveAlias(tag) {
        let current = tag;
        let depth = 0;
        while (depth < 5) {
            const info = this.tagInfoMap[current];
            if (info && info.alias_to) {
                current = info.alias_to;
                depth++;
            } else {
                break;
            }
        }
        return current;
    }

    /**
     * Searches tags matching a prefix query and returns top K results ordered by count descending.
     * @param {string} query - Search prefix term.
     * @param {number} [limit=10] - Number of top results to return (K).
     * @returns {TagSearchResult[]}
     */
    searchTags(query, limit = 10) {
        if (!query || typeof query !== 'string') return [];

        const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, '_');
        if (!normalizedQuery || this.searchKeys.length === 0) return [];

        const keys = this.searchKeys;

        // Binary search to find the first key >= normalizedQuery
        let low = 0;
        let high = keys.length - 1;
        let startIdx = keys.length;

        while (low <= high) {
            const mid = (low + high) >> 1;
            if (keys[mid] >= normalizedQuery) {
                startIdx = mid;
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }

        /** @type {Map<string, TagSearchResult>} */
        const candidateMap = new Map();

        // Scan contiguous range of keys matching the prefix
        for (let i = startIdx; i < keys.length; i++) {
            const key = keys[i];
            if (!key.startsWith(normalizedQuery)) {
                break;
            }

            const targetTag = this.resolveAlias(key);
            const targetInfo = this.tagInfoMap[targetTag];
            const isAliased = key !== targetTag;

            const category = targetInfo ? targetInfo.category : 'GENERAL';
            const count = targetInfo ? targetInfo.tag_count : 0;

            /** @type {TagSearchResult} */
            const candidate = {
                name: targetTag,
                category,
                count
            };

            if (isAliased) {
                candidate.aliasedFrom = key;
            }

            // Deduplicate: If target was already matched via alias, prefer a direct match
            if (candidateMap.has(targetTag)) {
                const existing = candidateMap.get(targetTag);
                if (existing && existing.aliasedFrom && !isAliased) {
                    candidateMap.set(targetTag, candidate);
                }
            } else {
                candidateMap.set(targetTag, candidate);
            }
        }

        // Sort deduplicated candidates by count descending
        const results = Array.from(candidateMap.values());
        results.sort((a, b) => b.count - a.count);

        return results.slice(0, limit);
    }

    /**
     * Converts a flat array of tags into a categorized object.
     * @param {string[]} flatTags
     * @returns {Partial<Record<TagCategory, string[]>>}
     */
    categorizeTags(flatTags) {
        /** @type {Partial<Record<TagCategory, string[]>>} */
        const categorized = {};

        for (const tag of flatTags) {
            const catName = this.tagInfoMap[tag]?.category || 'GENERAL';
            (categorized[catName] ??= []).push(tag);
        }

        return categorized;
    }

    /**
     * @param {string[]} flatTags
     * @param {ClusterPost|null} [post=null]
     */
    getSortedTags(flatTags, post = null) {
        const categorizedTags = this.categorizeTags(flatTags);

        // 1. Lightweight signature
        const currentSignature = /** @type {TagCategory[]} */ (Object.keys(categorizedTags))
            .sort()
            .map(cat => `${cat}:${(categorizedTags[cat] || []).join(',')}`)
            .join('|');

        // 2. Cache hit check
        if (post && post._tagsSignature === currentSignature && post._sortedTags) {
            return post._sortedTags;
        }

        // 3. Re-compute sorting
        /** @type {TagCategory[]} */
        const categoryOrder = ['ARTIST', 'CONTRIBUTOR', 'COPYRIGHT', 'CHARACTER', 'SPECIES', 'GENERAL', 'META', 'LORE', 'INVALID'];

        const keys = /** @type {TagCategory[]} */ (Object.keys(categorizedTags)).sort((a, b) => {
            let idxA = categoryOrder.indexOf(a);
            let idxB = categoryOrder.indexOf(b);
            if (idxA === -1) idxA = 99;
            if (idxB === -1) idxB = 99;
            return idxA - idxB;
        });

        /** @type {Array<{ name: string, category: TagCategory }>} */
        const result = [];
        for (const key of keys) {
            const tags = categorizedTags[key] || [];
            const sortedCategoryTags = this.sortCategoryTags(tags);

            for (const tag of sortedCategoryTags) {
                result.push({
                    name: tag,
                    category: key
                });
            }
        }

        // 4. Cache result
        if (post) {
            post._sortedTags = result;
            post._tagsSignature = currentSignature;
        }

        return result;
    }

    /**
     * Sorts tags within a category using DAG topological depth levels.
     * @param {string[]} tags
     * @returns {string[]}
     */
    sortCategoryTags(tags) {
        if (!tags || tags.length <= 1) return tags ? tags.slice() : [];
        if (!this.isLoaded) {
            return tags.slice().sort((a, b) => a.localeCompare(b));
        }

        const tagSet = new Set(tags);

        /** @type {Record<string, string[]>} */
        const adj = {};
        /** @type {Record<string, string[]>} */
        const revAdj = {};
        /** @type {Record<string, string[]>} */
        const undirAdj = {};
        /** @type {Record<string, number>} */
        const inDegree = {};

        for (const t of tags) {
            adj[t] = [];
            revAdj[t] = [];
            undirAdj[t] = [];
            inDegree[t] = 0;
        }

        for (const u of tags) {
            const directImplied = this.tagInfoMap[u]?.implies || [];
            for (const v of directImplied) {
                if (tagSet.has(v)) {
                    adj[u].push(v);
                    revAdj[v].push(u);
                    undirAdj[u].push(v);
                    undirAdj[v].push(u);
                    inDegree[v] = (inDegree[v] || 0) + 1;
                }
            }
        }

        const visitedComp = new Set();
        /** @type {string[][]} */
        const components = [];

        for (const t of tags) {
            if (visitedComp.has(t)) continue;
            /** @type {string[]} */
            const comp = [];
            const queue = [t];
            visitedComp.add(t);

            while (queue.length > 0) {
                const curr = queue.shift();
                if (!curr) continue;
                comp.push(curr);
                for (const neighbor of undirAdj[curr] || []) {
                    if (!visitedComp.has(neighbor)) {
                        visitedComp.add(neighbor);
                        queue.push(neighbor);
                    }
                }
            }
            components.push(comp);
        }

        const processedComponents = components.map(comp => {
            /** @type {Record<string, number>} */
            const forwardDepth = {};
            /** @type {Record<string, number>} */
            const compInDegree = {};
            for (const t of comp) {
                forwardDepth[t] = 0;
                compInDegree[t] = inDegree[t] || 0;
            }

            const sources = comp.filter(t => compInDegree[t] === 0);
            const q = [...sources];

            while (q.length > 0) {
                const u = q.shift();
                if (!u) continue;
                for (const v of adj[u] || []) {
                    forwardDepth[v] = Math.max(forwardDepth[v] || 0, (forwardDepth[u] || 0) + 1);
                    compInDegree[v]--;
                    if (compInDegree[v] === 0) {
                        q.push(v);
                    }
                }
            }

            /** @type {Record<string, number>} */
            const level = {};
            for (const t of comp) {
                if ((inDegree[t] || 0) > 0) {
                    level[t] = forwardDepth[t] || 0;
                } else {
                    const children = adj[t] || [];
                    if (children.length > 0) {
                        const maxChildLevel = Math.max(...children.map(c => forwardDepth[c] || 0));
                        level[t] = Math.max(0, maxChildLevel - 1);
                    } else {
                        level[t] = 0;
                    }
                }
            }

            const maxLevel = Math.max(...comp.map(t => level[t] || 0));
            /** @type {string[][]} */
            const levelBuckets = Array.from({ length: maxLevel + 1 }, () => []);
            for (const t of comp) {
                const lvl = level[t] || 0;
                levelBuckets[lvl].push(t);
            }

            const level0Leaves = (levelBuckets[0] || []).filter(t => (inDegree[t] || 0) === 0).sort((a, b) => a.localeCompare(b));
            const level0NonLeaves = (levelBuckets[0] || []).filter(t => (inDegree[t] || 0) > 0).sort((a, b) => a.localeCompare(b));

            /** @type {string[]} */
            let orderedComp = [...level0Leaves, ...level0NonLeaves];
            /** @type {Map<string, number>} */
            const posMap = new Map();
            orderedComp.forEach((t, idx) => posMap.set(t, idx));

            for (let k = 1; k <= maxLevel; k++) {
                const bucket = levelBuckets[k] || [];
                const regularTags = bucket.filter(t => (inDegree[t] || 0) > 0);
                const shiftedLeaves = bucket.filter(t => (inDegree[t] || 0) === 0);

                regularTags.sort((a, b) => {
                    const parentsA = revAdj[a] || [];
                    const parentsB = revAdj[b] || [];

                    const minPosA = parentsA.reduce((min, p) => posMap.has(p) ? Math.min(min, posMap.get(p) ?? Infinity) : min, Infinity);
                    const minPosB = parentsB.reduce((min, p) => posMap.has(p) ? Math.min(min, posMap.get(p) ?? Infinity) : min, Infinity);

                    if (minPosA !== minPosB) {
                        return minPosA - minPosB;
                    }
                    return a.localeCompare(b);
                });

                shiftedLeaves.sort((a, b) => a.localeCompare(b));

                const combinedLevel = [...regularTags, ...shiftedLeaves];
                for (const t of combinedLevel) {
                    posMap.set(t, orderedComp.length);
                    orderedComp.push(t);
                }
            }

            const compLeaves = sources.length > 0 ? sources : comp;
            const primaryLeaf = compLeaves.slice().sort((a, b) => a.localeCompare(b))[0] || '';

            return {
                primaryLeaf,
                tags: orderedComp
            };
        });

        processedComponents.sort((a, b) => a.primaryLeaf.localeCompare(b.primaryLeaf));

        return processedComponents.flatMap(c => c.tags);
    }

    /**
     * @param {string} tagName
     * @param {string[]} flatTags
     */
    isImpliedTag(tagName, flatTags) {
        if (!tagName) return false;
        const implData = this.tagInfoMap[tagName];
        if (!implData || !implData.implied_by || implData.implied_by.length === 0) return false;

        const allPostTags = new Set(flatTags);
        return implData.implied_by.some((implicator) => allPostTags.has(implicator));
    }

    /**
     * @param {number} postId
     * @param {string} tagName
     * @param {string[]} flatTags
     */
    getImplicationChain(postId, tagName, flatTags) {
        if (!tagName) return null;

        const allPostTags = new Set(flatTags);

        const directImplied = (this.tagInfoMap[tagName]?.implies || []).filter(t => allPostTags.has(t));
        const directImplicators = (this.tagInfoMap[tagName]?.implied_by || []).filter(t => allPostTags.has(t));

        /** @type {string[]} */
        const indirectImplied = [];
        const visitedImplied = new Set([tagName, ...directImplied]);
        const queueImplied = [...directImplied];

        while (queueImplied.length > 0) {
            const current = queueImplied.shift();
            if (!current) continue;
            const children = this.tagInfoMap[current]?.implies || [];
            for (const child of children) {
                if (allPostTags.has(child) && !visitedImplied.has(child)) {
                    visitedImplied.add(child);
                    indirectImplied.push(child);
                    queueImplied.push(child);
                }
            }
        }

        /** @type {string[]} */
        const indirectImplicators = [];
        const visitedImplicators = new Set([tagName, ...directImplicators]);
        const queueImplicators = [...directImplicators];

        while (queueImplicators.length > 0) {
            const current = queueImplicators.shift();
            if (!current) continue;
            const parents = this.tagInfoMap[current]?.implied_by || [];
            for (const parent of parents) {
                if (allPostTags.has(parent) && !visitedImplicators.has(parent)) {
                    visitedImplicators.add(parent);
                    indirectImplicators.push(parent);
                    queueImplicators.push(parent);
                }
            }
        }

        return {
            postId,
            tagName,
            directImplicators: new Set(directImplicators),
            indirectImplicators: new Set(indirectImplicators),
            directImplied: new Set(directImplied),
            indirectImplied: new Set(indirectImplied)
        };
    }

    /**
     * @param {TagCategory} category
     */
    getTagStyle(category) {
        const cat = (category || '').toUpperCase();
        switch (cat) {
            case 'ARTIST':
                return 'color: #f2ac08; font-weight: bold;';
            case 'COPYRIGHT':
                return 'color: #d0d; font-weight: bold;';
            case 'CHARACTER':
                return 'color: #0a0; font-weight: bold;';
            case 'CONTRIBUTOR':
                return 'color: silver; font-weight: bold;';
            case 'SPECIES':
                return 'color: #ed5d1f; font-weight: bold;';
            case 'GENERAL':
                return 'color: #b4c7d9; font-weight: normal;';
            case 'META':
                return 'color: #e0e0e0; font-weight: normal;';
            case 'LORE':
                return 'color: #282; font-weight: bold;';
            default:
                return 'color: #ff3d3d; font-weight: bold;';
        }
    }

    /**
     * @param {PostRating} rating
     */
    getRatingBadgeClass(rating) {
        const r = (rating || '').toLowerCase();
        if (r === 's') return 'bg-green-950/80 text-green-400 border border-green-800/60';
        if (r === 'q') return 'bg-amber-950/80 text-amber-400 border border-amber-800/60';
        if (r === 'e') return 'bg-red-950/80 text-red-400 border border-red-800/60';
        return 'bg-gray-800 text-gray-300 border border-gray-700';
    }

    /**
     * @param {PostRating} rating
     */
    getRatingLabel(rating) {
        const r = (rating || '').toLowerCase();
        if (r === 's') return 'S';
        if (r === 'q') return 'Q';
        if (r === 'e') return 'E';
        return (rating || '').toUpperCase();
    }

    /**
     * @param {ClusterPost} targetPost
     * @param {ClusterPost[]} clusterPosts
     */
    calculateMergedTags(targetPost, clusterPosts) {
        if (!clusterPosts || !targetPost) return new Set();

        /** @type {Set<string>} */
        const mergedTags = new Set();
        const targetCat = this.categorizeTags(targetPost.tags);
        const targetArtistTags = targetCat.ARTIST || [];
        targetArtistTags.forEach(tag => mergedTags.add(tag));

        for (const post of clusterPosts) {
            const postCat = this.categorizeTags(post.tags);

            Object.entries(postCat)
                .filter(([category]) => category !== 'ARTIST')
                .flatMap(([, tags]) => tags)
                .forEach(tag => mergedTags.add(tag));
        }

        return mergedTags;
    }

    /**
     * @param {ClusterPost} targetPost
     * @param {ClusterPost[]} clusterPosts
     */
    async copyMergedTags(targetPost, clusterPosts) {
        try {
            const mergedTags = this.calculateMergedTags(targetPost, clusterPosts);
            const tagString = Array.from(mergedTags).sort().join(' ');
            await navigator.clipboard.writeText(tagString);

            showToast(`Copied merged tags (${mergedTags.size} tags)`, 'success', 2500);
        } catch (err) {
            console.error('[CopyMergedTags] Failed to copy tags:', err);
            showToast('Failed to copy merged tags to clipboard.', 'error');
        }
    }

    /**
     * @param {ClusterPost} currentPost
     * @param {ClusterPost[]} clusterPosts
     */
    getMergedTagCount(currentPost, clusterPosts) {
        return this.calculateMergedTags(currentPost, clusterPosts).size;
    }

    /**
     * @param {ClusterPost} currentPost
     * @param {ClusterPost[]} clusterPosts
     */
    getMergedTagDelta(currentPost, clusterPosts) {
        if (!currentPost) return 0;

        const currentCount = currentPost.tags.length;
        const mergedCount = this.getMergedTagCount(currentPost, clusterPosts);

        return mergedCount - currentCount;
    }

    /**
     * @param {ClusterPost} targetPost
     * @param {ClusterPost[]} clusterPosts
     */
    getMergedHoverData(targetPost, clusterPosts) {
        if (!targetPost) {
            return { targetPostId: undefined, tags: new Set() };
        }

        const targetTags = new Set(targetPost.tags);
        const mergedList = Array.from(this.calculateMergedTags(targetPost, clusterPosts));
        const newTags = mergedList.filter(tag => !targetTags.has(tag));

        return {
            targetPostId: targetPost.post_id,
            tags: new Set(newTags)
        };
    }
}

// Export a singleton instance by default
export const tagManager = new TagManager();

// Self-register on Alpine init
document.addEventListener('alpine:init', () => {
    Alpine.store('tags', tagManager);
});