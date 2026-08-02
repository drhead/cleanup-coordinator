import { decode } from '@msgpack/msgpack';
import { E621BlacklistEvaluator, applyBlacklistToCluster } from './blacklist.js';
import { TagManager } from './tags.js';

export const BatchManager = {
    selectProject(projectId) {
        this.activeProject = this.projects.find(p => p.project_id === projectId);
        this.reloadBatches();
    },

    async reloadBatches(silent = false, refreshedClusterId = null, forceCollapseReset = false) {
        if (!this.activeProject) return;

        try {
            const [batchesRes, leasesRes] = await Promise.all([
                fetch(`/api/v1/projects/${this.activeProject.project_id}/batches`, {
                    headers: { 'Accept': 'application/msgpack' }
                }),
                fetch('/api/v1/leases')
            ]);

            if (!batchesRes.ok) return;

            const batchesBuffer = await batchesRes.arrayBuffer();
            const batchesData = decode(batchesBuffer);

            const activeLeases = leasesRes.ok ? (await leasesRes.json()).leases || [] : [];
            const incomingBatches = batchesData.batches || [];

            const evaluator = new E621BlacklistEvaluator(this.blacklistText || '');

            const processCluster = (c, forceReset = false) => {
                applyBlacklistToCluster(c, evaluator);
                if (forceReset || c.collapsed === undefined) {
                    c.collapsed = c.is_resolved || c.is_blacklisted;
                }
            };

            if (this.batches.length === 0) {
                incomingBatches.forEach(b => {
                    if (b.clusters) {
                        b.clusters.forEach(c => {
                            processCluster(c);
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
                                processCluster(c);
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

                                // Reconcile posts in-place to retain object identity & TagManager cache
                                if (refreshedClusterId === existingCluster.cluster_id) {
                                    existingCluster.posts = newCluster.posts;
                                } else if (newCluster.posts && Array.isArray(newCluster.posts)) {
                                    const existingPostsMap = new Map((existingCluster.posts || []).map(p => [p.post_id, p]));
                                    
                                    existingCluster.posts = newCluster.posts.map(newPost => {
                                        const existingPost = existingPostsMap.get(newPost.post_id);
                                        if (existingPost) {
                                            // Updates properties while preserving existingPost._tagsSignature & existingPost._sortedTags
                                            Object.assign(existingPost, newPost);
                                            return existingPost;
                                        }
                                        return newPost;
                                    });
                                }

                                processCluster(existingCluster, forceCollapseReset);

                                if (refreshedClusterId && existingCluster.cluster_id === refreshedClusterId) {
                                    existingCluster.isRefreshing = false;
                                }
                            } else {
                                processCluster(newCluster);
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
            fetch(`/api/v1/projects/${lease.project_id}/batches`, {
                headers: { 'Accept': 'application/msgpack' }
            })
                .then(res => res.arrayBuffer())
                .then(buf => decode(buf))
                .then(data => {
                    this.batches = data.batches || [];
                    const found = this.batches.find(b => b.batch_id === lease.batch_id);
                    if (found) this.viewBatchDetail(found);
                });
        }
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
    }
};