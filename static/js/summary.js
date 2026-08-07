document.addEventListener('alpine:init', () => {
    if (!window.Alpine) return;

    /**
     * @typedef {import('./resolution.js').ResolutionGraph} ResolutionGraph
     * @typedef {import('./resolution.js').ResolutionPost} ResolutionPost
     */

    window.Alpine.data('summaryManager', (resMgr) => ({
        /** @type {ResolutionManagerComponent} */
        resMgr: resMgr,

        /** @type {Map<number, number>} Canonical kept/parent post ID per graph index */
        canonicalSelections: new Map(),

        init() {
            // Auto-select first post in each graph as default 'Keep' or 'Parent'
            this.resMgr.graphs.forEach((graph, index) => {
                if (graph.posts.size > 0) {
                    const firstId = Array.from(graph.posts)[0];
                    this.canonicalSelections.set(index, firstId);
                }
            });
        },

        /**
         * @param {number} graphIndex
         * @param {number} postId
         */
        setCanonical(graphIndex, postId) {
            this.canonicalSelections.set(graphIndex, postId);
        },

        /**
         * @param {number} graphIndex
         * @param {number} postId
         * @returns {boolean}
         */
        isCanonical(graphIndex, postId) {
            return this.canonicalSelections.get(graphIndex) === postId;
        },

        /**
         * Computes added tags against original post
         * @param {ResolutionPost} post
         * @returns {string[]}
         */
        getAddedTags(post) {
            if (!post) return [];
            return post.tags.filter(t => !post.original.tags?.includes(t));
        },

        /**
         * Computes removed tags against original post
         * @param {ResolutionPost} post
         * @returns {string[]}
         */
        getRemovedTags(post) {
            if (!post || !Array.isArray(post.original.tags)) return [];
            return post.original.tags.filter(t => !post.tags.includes(t));
        },

        /**
         * Checks if description was edited
         * @param {ResolutionPost} post
         * @returns {boolean}
         */
        isDescriptionEdited(post) {
            if (!post) return false;
            return (post.description || '') !== (post.original.description || '');
        },

        /**
         * Applies changes for a post
         * @param {number} postId
         */
        async applyChanges(postId) {
            const post = this.resMgr.getPost(postId);
            if (!post) return;
            // Wire up API calls here
            console.log('Applying resolution updates for post:', postId, post);
        },

        /**
         * Flags a duplicate post
         * @param {number} postId
         */
        async submitFlag(postId) {
            const post = this.resMgr.getPost(postId);
            if (!post) return;
            post.flag = true;
            console.log('Flagging post:', postId, post.flag_note);
        }
    }));
});