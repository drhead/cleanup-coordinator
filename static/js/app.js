function app() {
    return {
        currentScreen: 'projects',
        projects: [],
        batches: [],
        activeProject: null,
        activeBatch: null,
        activeLease: null,
        nowTimestamp: Date.now(),
        toasts: [],
        showBlacklistModal: false,
        showInstructionsModal: false,
        blacklistText: localStorage.getItem('e621_blacklist') || 
            '# Violence\ngore\nsnuff\nrape\n\n# ABDL\nyoung -rating:s\ndiaper -rating:s\n\n# Fetish\nfeces\nurine\nfart_fetish\nrealistic_feral rating:e\n\n# Controversial\npolitics',

        showToast(message, type = 'error', duration = 4000) {
            const id = Date.now() + Math.random();
            this.toasts.push({ id, message, type });

            if (duration > 0) {
                setTimeout(() => {
                    this.removeToast(id);
                }, duration);
            }
        },

        removeToast(id) {
            this.toasts = this.toasts.filter(t => t.id !== id);
        },

        init() {
            fetch('/api/v1/projects')
                .then(res => res.json())
                .then(data => {
                    this.projects = data.projects || [];
                    if (this.projects.length > 0) {
                        this.selectProject(this.projects[0].project_id);
                    }
                });
            const hasSeenInstructions = localStorage.getItem('hasSeenInstructions');
            if (!hasSeenInstructions) {
                this.showInstructionsModal = true;
                localStorage.setItem('hasSeenInstructions', 'true');
            }
            setInterval(() => {
                this.nowTimestamp = Date.now();
                this.checkLocalLeaseExpiration();
            }, 1000);

            this.startBackgroundPolling();
        },

        async saveBlacklist() {
            localStorage.setItem('e621_blacklist', this.blacklistText);
            this.showBlacklistModal = false;
            this.showToast('Blacklist updated. Refreshing evaluations...', 'info');
            await this.reloadBatches(true, null, true); 
        },

        checkLocalLeaseExpiration() {
            // 1. Check client's own lease
            if (this.activeLease && this.activeLease.leased_until) {
                const expiry = new Date(this.activeLease.leased_until).getTime();
                if (expiry <= this.nowTimestamp) {
                    this.activeLease = null;
                    this.reloadBatches(true);
                }
            }

            // 2. Trust client timers for ALL batches in list
            let needsReload = false;
            for (const batch of this.batches) {
                if (batch.status === 'CLAIMED' && batch.leased_until) {
                    const expiry = new Date(batch.leased_until).getTime();
                    if (expiry <= this.nowTimestamp) {
                        batch.status = 'AVAILABLE';
                        batch.is_leased_by_you = false;
                        batch.leased_until = null;
                        needsReload = true;
                    }
                }
            }

            if (needsReload) {
                this.reloadBatches(true);
            }
        },

        selectProject(projectId) {
            this.activeProject = this.projects.find(p => p.project_id === projectId);
            this.reloadBatches();
        },

        async reloadBatches(silent = false, refreshedClusterId = null, forceCollapseReset = false) {
            if (!this.activeProject) return;

            try {
                const encodedBlacklist = btoa(unescape(encodeURIComponent(this.blacklistText || '')));

                const [batchesRes, leasesRes] = await Promise.all([
                    fetch(`/api/v1/projects/${this.activeProject.project_id}/batches`, {
                        headers: {
                            'X-Blacklist': encodedBlacklist
                        }
                    }),
                    fetch('/api/v1/leases')
                ]);

                if (!batchesRes.ok) return;

                const batchesData = await batchesRes.json();
                const activeLeases = leasesRes.ok ? (await leasesRes.json()).leases || [] : [];
                const incomingBatches = batchesData.batches || [];

                if (this.batches.length === 0) {
                    incomingBatches.forEach(b => {
                        if (b.clusters) {
                            b.clusters.forEach(c => {
                                c.collapsed = c.is_resolved || c.is_blacklisted; 
                                c.isRefreshing = false;
                            });
                        } else {
                            b.clusters = [];
                        }
                    });
                    this.batches = incomingBatches;
                } else {
                    for (const newBatch of incomingBatches) {
                        let existingBatch = this.batches.find(b => b.batch_id === newBatch.batch_id);
                        if (!existingBatch) {
                            if (newBatch.clusters) {
                                newBatch.clusters.forEach(c => {
                                    c.collapsed = c.is_resolved || c.is_blacklisted;
                                    c.isRefreshing = false;
                                });
                            } else {
                                newBatch.clusters = [];
                            }
                            this.batches.push(newBatch);
                            continue;
                        }

                        existingBatch.status = newBatch.status;
                        existingBatch.is_leased_by_you = newBatch.is_leased_by_you;
                        existingBatch.resolved_count = newBatch.resolved_count;
                        existingBatch.total_clusters = newBatch.total_clusters;
                        existingBatch.leased_until = newBatch.leased_until;

                        if (!existingBatch.clusters) {
                            existingBatch.clusters = [];
                        }

                        const isCurrentlyInspecting = this.activeBatch && (this.activeBatch.batch_id === newBatch.batch_id);

                        if (isCurrentlyInspecting && newBatch.clusters) {
                            for (let i = 0; i < newBatch.clusters.length; i++) {
                                const newCluster = newBatch.clusters[i];
                                let existingCluster = existingBatch.clusters.find(c => c.cluster_id === newCluster.cluster_id);

                                if (existingCluster) {
                                    existingCluster.note = newCluster.note;
                                    existingCluster.is_resolved = newCluster.is_resolved;
                                    existingCluster.manual_resolution = newCluster.manual_resolution;
                                    existingCluster.is_blacklisted = newCluster.is_blacklisted;
                                    existingCluster.matched_rule = newCluster.matched_rule;
                                    existingCluster.canonical_rating = newCluster.canonical_rating;

                                    if (forceCollapseReset) {
                                        existingCluster.collapsed = newCluster.is_resolved || newCluster.is_blacklisted;
                                    }

                                    if (refreshedClusterId === existingCluster.cluster_id || 
                                        existingCluster.posts.length !== newCluster.posts.length ||
                                        JSON.stringify(existingCluster.posts) !== JSON.stringify(newCluster.posts)) {
                                        existingCluster.posts = newCluster.posts;
                                    }

                                    if (refreshedClusterId && existingCluster.cluster_id === refreshedClusterId) {
                                        existingCluster.isRefreshing = false;
                                    }
                                } else {
                                    newCluster.collapsed = newCluster.is_resolved || newCluster.is_blacklisted;
                                    newCluster.isRefreshing = false;
                                    existingBatch.clusters.push(newCluster);
                                }
                            }
                        }
                    }
                }

                if (this.activeBatch) {
                    const found = this.batches.find(b => b.batch_id === this.activeBatch.batch_id);
                    if (found) this.activeBatch = found;
                }

                const myLease = activeLeases.find(l => l.project_id === this.activeProject.project_id && l.is_leased_by_you);
                if (myLease) {
                    const expiry = new Date(myLease.leased_until).getTime();
                    this.activeLease = expiry > this.nowTimestamp ? {
                        batch_id: myLease.batch_id,
                        batch_number: myLease.batch_number,
                        project_id: myLease.project_id,
                        leased_until: myLease.leased_until
                    } : null;
                } else {
                    this.activeLease = null;
                }

                if (!silent && this.currentScreen === 'projects') {
                    this.currentScreen = 'batches';
                }
            } catch (err) {
                if (silent) console.debug("[Polling] Sync failed:", err);
                else console.error("[Reload] Error loading batches:", err);
            }
        },

        startBackgroundPolling() {
            if (this.pollInterval) clearInterval(this.pollInterval);
            
            this.pollInterval = setInterval(() => {
                if (!document.hidden && this.activeProject) {
                    this.reloadBatches(true);
                }
            }, 15000);
        },

        viewBatchDetail(batch) {
            this.activeBatch = batch;
            this.currentScreen = 'batch_detail';
        },

        jumpToLeasedBatch(lease) {
            const batch = this.batches.find(b => b.batch_id === lease.batch_id);
            if (batch) {
                this.viewBatchDetail(batch);
            } else {
                fetch(`/api/v1/projects/${lease.project_id}/batches`)
                    .then(res => res.json())
                    .then(data => {
                        this.batches = data.batches || [];
                        const found = this.batches.find(b => b.batch_id === lease.batch_id);
                        if (found) this.viewBatchDetail(found);
                    });
            }
        },

        canClaimActiveBatch() {
            if (!this.activeBatch) return false;
            if (this.activeBatch.status !== 'AVAILABLE') return false;
            if (this.activeLease) return false;
            return true;
        },

        claimCurrentBatch() {
            if (!this.activeBatch) return;

            fetch(`/api/v1/batches/${this.activeBatch.batch_id}/claim`, { method: 'POST' })
                .then(async res => {
                    const data = await res.json();
                    if (!res.ok) {
                        this.showToast(data.detail || 'Failed to claim batch.', 'error');
                        return;
                    }
                    this.activeLease = {
                        batch_id: data.batch_id,
                        batch_number: this.activeBatch.batch_number,
                        project_id: this.activeProject.project_id,
                        leased_until: data.leased_until,
                        leased_by_ip: data.leased_by_ip
                    };
                    this.reloadBatches();
                    this.showToast(`Claimed Batch #${this.activeBatch.batch_number}`, 'success');
                });
        },

        revokeLease(batchId) {
            fetch(`/api/v1/batches/${batchId}/revoke`, { method: 'POST' })
                .then(async res => {
                    const data = await res.json();
                    if (!res.ok) {
                        this.showToast(data.detail || 'Failed to revoke lease.', 'error');
                        return;
                    }
                    this.activeLease = null;
                    this.reloadBatches();
                    this.showToast('Lease revoked.', 'info');
                });
        },

        getBatchStatusLabel(batch) {
            if (!batch) return 'AVAILABLE';
            if (batch.status === 'CLAIMED') {
                return batch.is_leased_by_you ? 'CLAIMED BY YOU' : 'CLAIMED';
            }
            return batch.status;
        },

        getBatchStatusClass(batch) {
            if (!batch) return 'bg-blue-950 text-blue-400 border border-blue-800/50';
            const st = batch.status || 'AVAILABLE';
            switch (st) {
                case 'COMPLETE':
                    return 'bg-green-950 text-green-400 border border-green-800/50';
                case 'CLAIMED':
                    return 'bg-amber-950 text-amber-400 border border-amber-800/50';
                case 'AVAILABLE':
                default:
                    return 'bg-blue-950 text-blue-400 border border-blue-800/50';
            }
        },

        getRemainingTimeString(isoDateStr) {
            if (!isoDateStr) return '';
            const expiry = new Date(isoDateStr).getTime();
            const diff = Math.max(0, Math.floor((expiry - this.nowTimestamp) / 1000));
            
            if (diff <= 0) return '';
            
            const minutes = Math.floor(diff / 60);
            const seconds = diff % 60;
            return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        },

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

        async refreshBatch(batch) {
            if (!batch || batch.isRefreshing) return;
            
            batch.isRefreshing = true;

            try {
                const res = await fetch(`/api/v1/batches/${batch.batch_id}/refresh`, { method: 'POST' });
                const data = await res.json();
                
                if (!res.ok) {
                    this.showToast(data.detail || 'Failed to refresh batch.', 'warning');
                    return;
                }
                
                await this.reloadBatches(true);
                this.showToast(`Refreshed Batch #${batch.batch_number}`, 'success', 2500);
            } catch (err) {
                console.error("[BatchRefresh] Error refreshing batch:", err);
                this.showToast('Network error while refreshing batch.', 'error');
            } finally {
                batch.isRefreshing = false;
            }
        },

        getProgressPercent(resolved, total) {
            if (!total || total <= 0) return 0;
            return Math.min(100, Math.round((resolved / total) * 100));
        },

        getProjectResolvedCount(project) {
            return project.resolved_clusters || 0;
        },

        getProjectTotalCount(project) {
            return project.total_clusters || 0;
        },

        calculateMergedTags(targetPost, clusterPosts) {
            if (!clusterPosts || !targetPost) return new Set();

            const mergedTags = new Set();

            // 1. Artist tags: ONLY kept from target post
            const targetArtistTags = targetPost.tags_json?.ARTIST || targetPost.tags_json?.artist || [];
            targetArtistTags.forEach(tag => mergedTags.add(tag));

            // 2. All other categories: Gathered from all posts in cluster
            for (const post of clusterPosts) {
                if (!post.tags_json) continue;

                for (const [category, tags] of Object.entries(post.tags_json)) {
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

            const currentCount = Object.values(currentPost.tags_json || {}).flat().length;
            const mergedCount = this.getMergedTagCount(currentPost, clusterPosts);

            return mergedCount - currentCount;
        }
    };
}