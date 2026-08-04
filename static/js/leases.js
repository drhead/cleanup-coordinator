// @ts-check

import { reloadBatches } from './batches.js';
import { showToast } from './toasts.js';

/**
 * Checks for expired local leases or batch lease states and refreshes batches if needed.
 * @param {AppState} state
 */
export function checkLocalLeaseExpiration(state) {
    let needsReload = false;

    if (state.activeLease && state.activeLease.leased_until) {
        const expiry = new Date(state.activeLease.leased_until).getTime();
        if (expiry <= (state.nowTimestamp || Date.now())) {
            state.activeLease = null;
            needsReload = true;
        }
    }

    for (const batch of state.batches) {
        if (batch.status === 'CLAIMED' && batch.leased_until) {
            const expiry = new Date(batch.leased_until).getTime();
            if (expiry <= (state.nowTimestamp || Date.now())) {
                batch.status = 'AVAILABLE';
                batch.is_leased_by_you = false;
                batch.leased_until = null;
                needsReload = true;
            }
        }
    }

    if (needsReload) {
        reloadBatches(state, true);
    }
}

/**
 * Checks whether the active batch can be claimed by the user.
 * @param {AppState} state
 * @returns {boolean}
 */
export function canClaimActiveBatch(state) {
    if (!state.activeBatch) return false;
    if (state.activeBatch.status !== 'AVAILABLE') return false;
    if (state.activeLease) return false;
    return true;
}

/**
 * Claims the current active batch for the user.
 * @param {AppState} state
 */
export async function claimCurrentBatch(state) {
    if (!state.activeBatch || !state.activeProject) return;

    try {
        const res = await fetch(`/api/v1/batches/${state.activeBatch.batch_id}/claim`, { method: 'POST' });
        const data = await res.json();

        if (!res.ok) {
            showToast(state, data.detail || 'Failed to claim batch.', 'error');
            return;
        }

        state.activeLease = {
            batch_id: data.batch_id,
            batch_number: state.activeBatch.batch_number,
            project_id: state.activeProject.project_id,
            leased_until: data.leased_until
        };

        await reloadBatches(state);
        showToast(state, `Claimed Batch #${state.activeBatch.batch_number}`, 'success');
    } catch (err) {
        console.error('[Leases] Error claiming batch:', err);
        showToast(state, 'Network error while claiming batch.', 'error');
    }
}

/**
 * Revokes an existing batch lease.
 * @param {AppState} state
 * @param {number|string} batchId
 */
export async function revokeLease(state, batchId) {
    try {
        const res = await fetch(`/api/v1/batches/${batchId}/revoke`, { method: 'POST' });
        const data = await res.json();

        if (!res.ok) {
            showToast(state, data.detail || 'Failed to revoke lease.', 'error');
            return;
        }

        state.activeLease = null;
        await reloadBatches(state);
        showToast(state, 'Lease revoked.', 'info');
    } catch (err) {
        console.error('[Leases] Error revoking lease:', err);
        showToast(state, 'Network error while revoking lease.', 'error');
    }
}

/**
 * Formats an ISO expiration date string into a remaining MM:SS string.
 * @param {number} nowTimestamp
 * @param {string|null|undefined} isoDateStr
 * @returns {string}
 */
export function getRemainingTimeString(nowTimestamp, isoDateStr) {
    if (!isoDateStr) return '';
    const expiry = new Date(isoDateStr).getTime();
    const diff = Math.max(0, Math.floor((expiry - nowTimestamp) / 1000));

    if (diff <= 0) return '';

    const minutes = Math.floor(diff / 60);
    const seconds = diff % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}