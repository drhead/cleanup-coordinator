// @ts-check

import Alpine from 'alpinejs';
import { showToast } from './toasts.js';
import { getE621User } from './auth.js';

const DEFAULT_BLACKLIST = `# Violence
gore
snuff
rape

# ABDL
young -rating:s
diaper -rating:s

# Fetish
feces
urine
fart_fetish
realistic_feral rating:e

# Controversial
politics`;

/** @type {Record<string, string>} */
const RATING_MAP = {
    s: 's', safe: 's',
    q: 'q', questionable: 'q',
    e: 'e', explicit: 'e',
};

/** @type {Record<string, number>} */
const RATING_ORDER = { s: 1, q: 2, e: 3 };

/**
 * Normalizes e621 ratings into 's', 'q', or 'e'.
 * @param {string} r
 * @returns {string}
 */
export function normalizeRating(r) {
    if (!r) return 's';
    const clean = String(r).toLowerCase().trim();
    return RATING_MAP[clean] || clean;
}

export class TermMatcher {
    /**
     * @param {string} rawTerm
     */
    constructor(rawTerm) {
        this.rawTerm = rawTerm.toLowerCase().trim();
        this.isRating = this.rawTerm.startsWith('rating:');
        /** @type {Set<string>} */
        this.allowedRatings = new Set();
        this.hasWildcard = false;
        /** @type {RegExp|null} */
        this.regex = null;

        if (this.isRating) {
            const ratingVal = this.rawTerm.split(':', 2)[1] || '';
            for (const p of ratingVal.split(',')) {
                const clean = p.trim();
                if (clean) this.allowedRatings.add(normalizeRating(clean));
            }
        } else {
            this.hasWildcard = this.rawTerm.includes('*');
            if (this.hasWildcard) {
                const escaped = this.rawTerm
                    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                    .replace(/\*/g, '.*');
                this.regex = new RegExp(`^${escaped}$`, 'i');
            }
        }
    }

    /**
     * @param {Set<string>} tagsSet
     * @param {string} rating
     * @returns {boolean}
     */
    matches(tagsSet, rating) {
        if (this.isRating) return this.allowedRatings.has(normalizeRating(rating));
        if (this.hasWildcard && this.regex) {
            for (const tag of tagsSet) {
                if (this.regex.test(tag)) return true;
            }
            return false;
        }
        return tagsSet.has(this.rawTerm);
    }
}

export class BlacklistRule {
    /**
     * @param {string} line
     */
    constructor(line) {
        this.rawLine = line.trim();
        /** @type {TermMatcher[]} */
        this.positiveTerms = [];
        /** @type {TermMatcher[]} */
        this.negativeTerms = [];
        /** @type {TermMatcher[][]} */
        this.orGroups = [];
        this._parse(line);
    }

    /**
     * @private
     * @param {string} line
     */
    _parse(line) {
        if (line.includes('#')) line = line.split('#')[0];
        line = line.trim();
        if (!line) return;

        /**
         * @param {string} tok
         * @returns {[string, string]}
         */
        const parsePrefix = (tok) => {
            if (tok.startsWith('-')) return ['-', tok.slice(1)];
            if (tok.startsWith('~')) return ['~', tok.slice(1)];
            return ['', tok];
        };

        const tokens = line.match(/-\(\s*[^)]+\s*\)|\(\s*[^)]+\s*\)|[^\s()]+/g) || [];
        /** @type {TermMatcher[]} */
        let standaloneOrGroup = [];

        for (let token of tokens) {
            token = token.trim();
            if (!token) continue;

            if (token.startsWith('-(') && token.endsWith(')')) {
                const inner = token.slice(2, -1).trim();
                for (const itok of inner.split(/\s+/)) {
                    const [, clean] = parsePrefix(itok);
                    if (clean) this.negativeTerms.push(new TermMatcher(clean));
                }
            } else if (token.startsWith('(') && token.endsWith(')')) {
                const inner = token.slice(1, -1).trim();
                const group = [];
                for (const itok of inner.split(/\s+/)) {
                    const [, clean] = parsePrefix(itok);
                    if (clean) group.push(new TermMatcher(clean));
                }
                if (group.length > 0) this.orGroups.push(group);
            } else {
                const [prefix, clean] = parsePrefix(token);
                if (!clean) continue;

                if (prefix === '-') {
                    if (standaloneOrGroup.length > 0) {
                        this.orGroups.push(standaloneOrGroup);
                        standaloneOrGroup = [];
                    }
                    this.negativeTerms.push(new TermMatcher(clean));
                } else if (prefix === '~') {
                    standaloneOrGroup.push(new TermMatcher(clean));
                } else {
                    if (standaloneOrGroup.length > 0) {
                        this.orGroups.push(standaloneOrGroup);
                        standaloneOrGroup = [];
                    }
                    this.positiveTerms.push(new TermMatcher(clean));
                }
            }
        }

        if (standaloneOrGroup.length > 0) {
            this.orGroups.push(standaloneOrGroup);
        }
    }

    isEmpty() {
        return (
            this.positiveTerms.length === 0 &&
            this.negativeTerms.length === 0 &&
            this.orGroups.length === 0
        );
    }

    /**
     * @param {Set<string>} tagsSet
     * @param {string} rating
     * @returns {boolean}
     */
    matches(tagsSet, rating) {
        if (this.isEmpty()) return false;
        const normRating = normalizeRating(rating);

        for (const term of this.positiveTerms) {
            if (!term.matches(tagsSet, normRating)) return false;
        }
        for (const term of this.negativeTerms) {
            if (term.matches(tagsSet, normRating)) return false;
        }
        for (const group of this.orGroups) {
            if (!group.some((term) => term.matches(tagsSet, normRating))) return false;
        }
        return true;
    }
}

export class E621BlacklistEvaluator {
    /**
     * @param {string} blacklistText
     */
    constructor(blacklistText) {
        /** @type {BlacklistRule[]} */
        this.rules = [];
        if (blacklistText) {
            for (const line of blacklistText.split('\n')) {
                const rule = new BlacklistRule(line);
                if (!rule.isEmpty()) {
                    this.rules.push(rule);
                }
            }
        }
    }

    /**
     * @param {Set<string>} tagsSet
     * @param {string} rating
     * @returns {{ isBlacklisted: boolean, matchedRule: string|null }}
     */
    evaluate(tagsSet, rating) {
        const normRating = normalizeRating(rating);
        for (const rule of this.rules) {
            if (rule.matches(tagsSet, normRating)) {
                return { isBlacklisted: true, matchedRule: rule.rawLine };
            }
        }
        return { isBlacklisted: false, matchedRule: null };
    }
}

/**
 * Extracts union of all tags and worst-case canonical rating for a cluster of posts.
 * @param {any[]} clusterPosts
 */
export function getClusterUnionTagsAndRating(clusterPosts) {
    const unionTags = new Set();
    let maxRatingScore = 0;
    let canonicalRating = 's';

    if (!clusterPosts) return { unionTags, canonicalRating };

    for (const post of clusterPosts) {
        const pRating = normalizeRating(post.rating);
        const score = RATING_ORDER[pRating] || 1;
        if (score > maxRatingScore) {
            maxRatingScore = score;
            canonicalRating = pRating;
        }

        if (Array.isArray(post.tags)) {
            for (const tag of post.tags) {
                unionTags.add(tag);
            }
        }
    }

    return { unionTags, canonicalRating };
}

/**
 * Evaluates a cluster against a blacklist evaluator and sets metadata directly.
 * @param {any} cluster
 * @param {E621BlacklistEvaluator} evaluator
 */
export function applyBlacklistToCluster(cluster, evaluator) {
    const { unionTags, canonicalRating } = getClusterUnionTagsAndRating(cluster.posts);
    const { isBlacklisted, matchedRule } = evaluator.evaluate(unionTags, canonicalRating);

    cluster.canonical_rating = canonicalRating;
    cluster.is_blacklisted = isBlacklisted;
    cluster.matched_rule = matchedRule;
}

export class BlacklistManager {
    constructor() {
        this.blacklistText = localStorage.getItem('e621_blacklist') || DEFAULT_BLACKLIST;
        this.isImportingBlacklist = false;
        this.showBlacklistModal = false;
    }

    openModal() {
        this.showBlacklistModal = true;
    }

    closeModal() {
        this.showBlacklistModal = false;
    }

    /**
     * Creates an evaluator using current blacklist text
     * @returns {E621BlacklistEvaluator}
     */
    getEvaluator() {
        return new E621BlacklistEvaluator(this.blacklistText || '');
    }

    /**
     * Saves current blacklist text to localStorage and recalculates cluster blacklist status.
     * @param {Array<any>} [batches] Array of batches to re-evaluate
     * @param {boolean} [silent=false]
     */
    async saveBlacklist(batches = [], silent = false) {
        localStorage.setItem('e621_blacklist', this.blacklistText || '');
        this.showBlacklistModal = false;

        const evaluator = this.getEvaluator();

        if (Array.isArray(batches)) {
            for (const batch of batches) {
                if (!batch.clusters) continue;
                for (const cluster of batch.clusters) {
                    applyBlacklistToCluster(cluster, evaluator);
                    cluster.collapsed = cluster.is_resolved || cluster.is_blacklisted;
                }
            }
        }

        if (!silent) {
            showToast('Blacklist updated.', 'success');
        }
    }

    /**
     * Imports blacklisted tags from the logged-in user's e621 account profile.
     * @param {Array<any>} [batches] Optional array of batches to re-evaluate after import
     */
    async importBlacklist(batches = []) {
        const user = getE621User();
        if (!user) {
            showToast('You must be logged in to import your e621 blacklist.', 'warning');
            return;
        }

        this.isImportingBlacklist = true;

        try {
            const authString = btoa(`${user.username}:${user.apiKey}`);
            const appAuthor = import.meta.env.VITE_E621_APP_AUTHOR || 'anonymous';

            const res = await fetch(`https://e621.net/users/me.json`, {
                headers: {
                    'Authorization': `Basic ${authString}`,
                    'User-Agent': `E621CleanupCoordinator/1.0 (by ${appAuthor})`
                }
            });

            if (!res.ok) {
                throw new Error(`e621 returned status ${res.status}`);
            }

            const userData = await res.json();

            if (userData.blacklisted_tags !== undefined) {
                this.blacklistText = userData.blacklisted_tags;
                await this.saveBlacklist(batches, true);
                showToast('Blacklist imported and saved successfully', 'success');
            } else {
                throw new Error('Could not locate blacklisted tags in profile.');
            }
        } catch (err) {
            console.error('[Blacklist] Import error:', err);
            const message = err instanceof Error ? err.message : String(err);
            showToast(`Import failed: ${message}`, 'error');
        } finally {
            this.isImportingBlacklist = false;
        }
    }
}

// Singleton instance
export const blacklistManager = new BlacklistManager();

/**
 * Helper to get an active E621BlacklistEvaluator anywhere in plain JS modules
 * @returns {E621BlacklistEvaluator}
 */
export function getBlacklistEvaluator() {
    if (window.Alpine?.store('blacklist')) {
        // @ts-expect-error - Alpine's store API returns 'unknown'
        return window.Alpine.store('blacklist').getEvaluator();
    }
    return blacklistManager.getEvaluator();
}

// Register as Alpine Store
document.addEventListener('alpine:init', () => {
    Alpine.store('blacklist', blacklistManager);
});