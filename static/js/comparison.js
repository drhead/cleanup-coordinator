// @ts-check

import { ensureClusterPostsInfo } from './e621_api.js';
import { showToast } from './toasts.js';
import { openImageModal } from './image_modal.js';

/**
 * @typedef {Object} RootData
 * @property {string} activeView
 */

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
        /** @type {ClusterPair[]} */
        pairs: [],
        
        /** @type {Map<number, string>} */
        fetchedPostsMap: new Map(),

        /** @type {'side-by-side' | 'swipe' | 'diff' | 'blink'} */
        mode: 'side-by-side',

        // Loupe Controls & State
        enableLoupe: true,
        zoomLevel: 2,
        isHovering: false,
        relX: 0.5,
        relY: 0.5,
        loupeSize: 180,
        containerWidth: 0,
        containerHeight: 0,

        // Single View States
        swipePos: 50,
        blinkShowB: false,
        /** @type {ReturnType<typeof setInterval> | null} */
        blinkInterval: null,
        blinkSpeed: 350,

        /**
         * @returns {ClusterPair | null}
         */
        get currentPair() {
            return this.pairs[this.activePairIndex] || null;
        },

        /**
         * @param {'side-by-side' | 'swipe' | 'diff' | 'blink'} newMode
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
         * @param {HTMLElement | null} containerEl
         */
        handleSwipeMove(e, containerEl) {
            if (!containerEl) return;
            const rect = containerEl.getBoundingClientRect();
            this.containerWidth = rect.width;
            this.containerHeight = rect.height;
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            this.swipePos = Math.max(0, Math.min(100, x));
        },

        /**
         * @param {MouseEvent} e
         * @param {HTMLElement | null} imgEl
         */
        handleMouseMove(e, imgEl) {
            if (!imgEl) return;
            const rect = imgEl.getBoundingClientRect();
            this.containerWidth = rect.width;
            this.containerHeight = rect.height;

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
         * Standard Single Post Loupe Style
         * @param {ClusterPost | null} post
         * @returns {Record<string, string>}
         */
        getLoupeStyle(post) {
            if (!this.enableLoupe || !post || !post.fileUrl) return { display: 'none' };

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
         * FIXED Diff Loupe Style: Black background prevents color inversion!
         * @param {ClusterPost | null} postA
         * @param {ClusterPost | null} postB
         * @returns {Record<string, string>}
         */
        getDiffLoupeStyle(postA, postB) {
            if (!this.enableLoupe || !postA?.fileUrl || !postB?.fileUrl) return { display: 'none' };

            const nativeW = Math.max(postA.image_width || 1000, postB.image_width || 1000);
            const nativeH = Math.max(postA.image_height || 1000, postB.image_height || 1000);
            const dpr = window.devicePixelRatio || 1;

            const bgW = nativeW * this.zoomLevel * dpr;
            const bgH = nativeH * this.zoomLevel * dpr;

            const bgLeft = (this.loupeSize / 2) - (this.relX * bgW);
            const bgTop = (this.loupeSize / 2) - (this.relY * bgH);

            return {
                width: `${this.loupeSize}px`,
                height: `${this.loupeSize}px`,
                backgroundImage: `url(${postB.fileUrl}), url(${postA.fileUrl})`,
                backgroundBlendMode: 'difference',
                backgroundColor: '#000000',
                backgroundSize: `${bgW}px ${bgH}px, ${bgW}px ${bgH}px`,
                backgroundPosition: `${bgLeft}px ${bgTop}px, ${bgLeft}px ${bgTop}px`,
                imageRendering: this.zoomLevel > 1 ? 'pixelated' : 'auto'
            };
        },

        /**
         * Calculates dynamic clip path for Image B layer inside the Swipe Loupe
         * @returns {Record<string, string>}
         */
        getSwipeLoupeClipStyle() {
            if (!this.containerWidth) return {};
            const swipeX = (this.swipePos / 100) * this.containerWidth;
            const cursorX = this.relX * this.containerWidth;
            const diffX = swipeX - cursorX;
            const loupeLineX = (this.loupeSize / 2) + (diffX * this.zoomLevel);

            const rightClip = Math.max(0, Math.min(this.loupeSize, this.loupeSize - loupeLineX));
            return {
                clipPath: `inset(0 ${rightClip}px 0 0)`
            };
        },

        /**
         * Opens current mode in expanded modal
         * @param {ClusterPost | null} [singlePost=null]
         */
        openModal(singlePost = null) {
            if (singlePost) {
                openImageModal({
                    src: /** @type {string} */ (singlePost.fileUrl),
                    mode: 'single',
                    title: `Post #${singlePost.post_id}`,
                    dimensions: `${singlePost.image_width || '?'}×${singlePost.image_height || '?'}`
                });
                return;
            }

            if (!this.currentPair?.a?.fileUrl || !this.currentPair?.b?.fileUrl) return;

            openImageModal({
                src: this.currentPair.a.fileUrl,
                srcB: this.currentPair.b.fileUrl,
                mode: /** @type {'swipe' | 'diff' | 'blink'} */ (this.mode),
                title: `#${this.currentPair.a.post_id}`,
                titleB: `#${this.currentPair.b.post_id}`,
                dimensions: `${this.currentPair.a.image_width || '?'}×${this.currentPair.a.image_height || '?'}`,
                blinkSpeed: this.blinkSpeed
            });
        },

        async startComparison() {
            if (!cluster || !cluster.posts || cluster.posts.length < 2) {
                showToast('Cluster must have at least 2 posts to compare.', 'error');
                return;
            }

            if (globalActiveComparison && globalActiveComparison !== this) {
                globalActiveComparison.closeComparison();
            }
            globalActiveComparison = this;

            this.isLoading = true;

            try {
                await ensureClusterPostsInfo(cluster.posts);
                const availableClusterPosts = cluster.posts.filter(p => !!p.fileUrl);

                if (availableClusterPosts.length <= 1) {
                    throw new Error('Could not retrieve file URLs for comparison.');
                }

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
                showToast(`Comparison error: ${message}`, 'error');
                this.closeComparison();
            } finally {
                this.isLoading = false;
            }
        },

        /**
         * @param {RootData | null} [rootData]
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