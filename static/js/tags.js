export const TagManager = {
    getSortedTags(tagsJson) {
        if (!tagsJson || typeof tagsJson !== 'object') return [];

        const categoryOrder = ['ARTIST', 'CONTRIBUTOR', 'COPYRIGHT', 'CHARACTER', 'SPECIES', 'GENERAL', 'META', 'LORE', 'INVALID'];
        
        const keys = Object.keys(tagsJson).sort((a, b) => {
            let idxA = categoryOrder.indexOf(a.toUpperCase());
            let idxB = categoryOrder.indexOf(b.toUpperCase());
            if (idxA === -1) idxA = 99;
            if (idxB === -1) idxB = 99;
            return idxA - idxB;
        });

        let result = [];
        for (const key of keys) {
            const tags = (tagsJson[key] || []).slice().sort((a, b) => a.localeCompare(b));
            for (const tag of tags) {
                result.push({
                    name: tag,
                    category: key.toUpperCase()
                });
            }
        }
        return result;
    },

    getTagStyle(category) {
        const cat = (category || '').toUpperCase();
        switch (cat) {
            case 'ARTIST':
                return 'color: #f2ac08;';
            case 'COPYRIGHT':
                return 'color: #d0d;';
            case 'CHARACTER':
                return 'color: #0a0;';
            case 'CONTRIBUTOR':
                return 'color: silver';
            case 'SPECIES':
                return 'color: #ed5d1f;';
            case 'GENERAL':
                return 'color: #b4c7d9;';
            case 'META':
                return 'color: #e0e0e0;';
            case 'LORE':
                return 'color: #282';
            default:
                return 'color: #ff3d3d;';
        }
    },

    getRatingLabel(rating) {
        const r = (rating || '').toLowerCase();
        if (r === 's') return 'S';
        if (r === 'q') return 'Q';
        if (r === 'e') return 'E';
        return rating.toUpperCase();
    },

    getRatingBadgeClass(rating) {
        const r = (rating || '').toLowerCase();
        if (r === 's') return 'bg-green-950/80 text-green-400 border border-green-800/60';
        if (r === 'q') return 'bg-amber-950/80 text-amber-400 border border-amber-800/60';
        if (r === 'e') return 'bg-red-950/80 text-red-400 border border-red-800/60';
        return 'bg-gray-800 text-gray-300 border border-gray-700';
    },

    calculateMergedTags(targetPost, clusterPosts) {
        if (!clusterPosts || !targetPost) return new Set();

        const mergedTags = new Set();

        const targetArtistTags = targetPost.tags_categorized?.ARTIST || targetPost.tags_categorized?.artist || [];
        targetArtistTags.forEach(tag => mergedTags.add(tag));

        for (const post of clusterPosts) {
            if (!post.tags_categorized) continue;

            for (const [category, tags] of Object.entries(post.tags_categorized)) {
                if (category.toUpperCase() === 'ARTIST') continue;
                if (!Array.isArray(tags)) continue;

                for (const tag of tags) {
                    if (this.shouldIncludeTag(tag, category, post, targetPost)) {
                        mergedTags.add(tag);
                    }
                }
            }
        }

        return mergedTags;
    },

    async copyMergedTags(targetPost, clusterPosts) {
        try {
            const mergedTags = this.calculateMergedTags(targetPost, clusterPosts);
            const tagString = Array.from(mergedTags).sort().join(' ');
            await navigator.clipboard.writeText(tagString);

            this.showToast(`Copied merged tags (${mergedTags.size} tags)`, 'success', 2500);
        } catch (err) {
            console.error('[CopyMergedTags] Failed to copy tags:', err);
            this.showToast('Failed to copy merged tags to clipboard.', 'error');
        }
    },

    shouldIncludeTag(tag, category, sourcePost, targetPost) {
        return true;
    },

    getMergedTagCount(currentPost, clusterPosts) {
        return this.calculateMergedTags(currentPost, clusterPosts).size;
    },

    getMergedTagDelta(currentPost, clusterPosts) {
        if (!currentPost) return 0;

        const currentCount = Object.values(currentPost.tags_categorized || {}).flat().length;
        const mergedCount = this.getMergedTagCount(currentPost, clusterPosts);

        return mergedCount - currentCount;
    },

    setHoveredMergedTags(clusterId, targetPost, clusterPosts) {
        const targetTags = new Set(
            Object.values(targetPost.tags_categorized || {}).flat()
        );

        const mergedList = Array.from(this.calculateMergedTags(targetPost, clusterPosts) || []);

        this.hoveredMergedData = {
            clusterId: clusterId,
            targetPostId: targetPost.post_id,
            tags: mergedList.filter(tag => !targetTags.has(tag))
        };
    },

    clearHoveredMergedTags() {
        this.hoveredMergedData = { clusterId: null, targetPostId: null, tags: [] };
    }
};