// @ts-check

import { fetchPostFileUrls } from './e621_api.js';
import { showToast } from './toasts.js';

/** @type {any} */
let globalActiveComparison = null;

/**
 * Alpine component data factory for pairwise image comparison.
 * @param {Cluster} cluster
 */
export function ComparisonManager(cluster) {
    return {
        isActive: false,
        isLoading: false,
        activePairIndex: 0,
        /** @type {Array<{ a: ClusterPost, b: ClusterPost, relationship: string|null }>} */
        pairs: [],
        
        /** Expose the Map on the component instance for the template hand-off */
        /** @type {Map<number, string>} */
        fetchedPostsMap: new Map(),

        // Modes: 'side-by-side', 'swipe', 'diff', 'blink'
        mode: 'side-by-side',

        // Loupe Zoom State
        zoomLevel: 2,
        isHovering: false,
        relX: 0.5,
        relY: 0.5,
        loupeSize: 180,

        // Single View States
        swipePos: 50,
        blinkShowB: false,
        /** @type {any} */
        blinkInterval: null,
        blinkSpeed: 350,

        get currentPair() {
            return this.pairs[this.activePairIndex] || null;
        },

        /**
         * @param {string} newMode
         */
        setMode(newMode) {
            this.mode = newMode;
            if (newMode === 'blink') {
                this.startBlink();
            } else {
                this.stopBlink();
            }
        },

        startBlink() {
            this.stopBlink();
            this.blinkShowB = false;
            this.blinkInterval = setInterval(() => {
                this.blinkShowB = !this.blinkShowB;
            }, this.blinkSpeed);
        },

        stopBlink() {
            if (this.blinkInterval) {
                clearInterval(this.blinkInterval);
                this.blinkInterval = null;
            }
        },

        closeComparison() {
            this.stopBlink();
            this.isActive = false;
            this.isLoading = false;
            this.pairs = [];

            if (globalActiveComparison === this) {
                globalActiveComparison = null;
            }
        },

        /**
         * @param {MouseEvent} e
         * @param {HTMLElement|null} containerEl
         */
        handleSwipeMove(e, containerEl) {
            if (!containerEl) return;
            const rect = containerEl.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            this.swipePos = Math.max(0, Math.min(100, x));
        },

        /**
         * @param {MouseEvent} e
         * @param {HTMLElement|null} imgEl
         */
        handleMouseMove(e, imgEl) {
            if (!imgEl) return;
            const rect = imgEl.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top) / rect.height;

            this.relX = Math.max(0, Math.min(1, x));
            this.relY = Math.max(0, Math.min(1, y));
            this.isHovering = true;
        },

        handleMouseLeave() {
            this.isHovering = false;
        },

        /**
         * @param {ClusterPost} post
         */
        getLoupeStyle(post) {
            if (!post || !post.fileUrl) return {};

            const nativeW = post.image_width || 1000;
            const nativeH = post.image_height || 1000; 
            const dpr = window.devicePixelRatio || 1;

            const bgW = nativeW * this.zoomLevel * dpr;
            const bgH = nativeH * this.zoomLevel * dpr;

            const bgLeft = (this.loupeSize / 2) - (this.relX * bgW);
            const bgTop = (this.loupeSize / 2) - (this.relY * bgH);

            return {
                width: `${this.loupeSize}px`,
                height: `${this.loupeSize}px`,
                backgroundImage: `url(${post.fileUrl})`,
                backgroundSize: `${bgW}px ${bgH}px`,
                backgroundPosition: `${bgLeft}px ${bgTop}px`,
                imageRendering: this.zoomLevel > 1 ? 'pixelated' : 'auto'
            };
        },

        /**
         * Starts comparison for this cluster.
         * @param {AppState} [appState]
         */
        async startComparison(appState) {
            if (!cluster || !cluster.posts || cluster.posts.length < 2) {
                if (appState) showToast(appState, 'Cluster must have at least 2 posts to compare.', 'error');
                return;
            }

            if (globalActiveComparison && globalActiveComparison !== this) {
                globalActiveComparison.closeComparison();
            }
            globalActiveComparison = this;

            this.isLoading = true;

            try {
                const postIds = cluster.posts.map(p => p.post_id);
                this.fetchedPostsMap = await fetchPostFileUrls(postIds, appState?.e621User || null);

                // Populate posts with fileUrl from API map
                for (const post of cluster.posts) {
                    if (this.fetchedPostsMap.has(post.post_id)) {
                        post.fileUrl = this.fetchedPostsMap.get(post.post_id);
                    }
                }

                const availableClusterPosts = cluster.posts.filter(p => !!p.fileUrl);

                if (availableClusterPosts.length <= 1) {
                    throw new Error('Could not retrieve file URLs for comparison.');
                }

                // Construct pairwise edges
                this.pairs = [];
                for (let i = 0; i < availableClusterPosts.length - 1; i++) {
                    this.pairs.push({
                        a: availableClusterPosts[i],
                        b: availableClusterPosts[i + 1],
                        relationship: null
                    });
                }

                this.activePairIndex = 0;
                this.isActive = true;

            } catch (err) {
                console.error('[ComparisonManager] Initiation error:', err);
                const message = err instanceof Error ? err.message : 'Unknown error';
                if (appState) showToast(appState, `Comparison error: ${message}`, 'error');
                this.closeComparison();
            } finally {
                this.isLoading = false;
            }
        },

        /**
         * Helper method to hand off work to tag reconciliation cleanly.
         * @param {any} rootData
         */
        proceedToReconciliation(rootData) {
            cluster.pairs = this.pairs;
            cluster._fetchedPosts = this.fetchedPostsMap;
            this.closeComparison();
            if (rootData) {
                rootData.activeView = 'reconcile';
            }
        },

        /**
         * @param {string} type
         */
        setRelationship(type) {
            if (!this.currentPair) return;
            this.currentPair.relationship = type;

            if (this.activePairIndex < this.pairs.length - 1) {
                this.activePairIndex++;
            }
        }
    };
}