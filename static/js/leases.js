export const LeaseManager = {
    checkLocalLeaseExpiration() {
        if (this.activeLease && this.activeLease.leased_until) {
            const expiry = new Date(this.activeLease.leased_until).getTime();
            if (expiry <= this.nowTimestamp) {
                this.activeLease = null;
                this.reloadBatches(true);
            }
        }

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

    getRemainingTimeString(isoDateStr) {
        if (!isoDateStr) return '';
        const expiry = new Date(isoDateStr).getTime();
        const diff = Math.max(0, Math.floor((expiry - this.nowTimestamp) / 1000));
        
        if (diff <= 0) return '';
        
        const minutes = Math.floor(diff / 60);
        const seconds = diff % 60;
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
};