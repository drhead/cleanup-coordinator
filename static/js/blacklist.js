const RATING_MAP = {
    s: 's', safe: 's',
    q: 'q', questionable: 'q',
    e: 'e', explicit: 'e',
};

const RATING_ORDER = { s: 1, q: 2, e: 3 };

function normalizeRating(r) {
    if (!r) return 's';
    const clean = String(r).toLowerCase().trim();
    return RATING_MAP[clean] || clean;
}

class TermMatcher {
    constructor(rawTerm) {
        this.rawTerm = rawTerm.toLowerCase().trim();
        this.isRating = this.rawTerm.startsWith('rating:');
        this.allowedRatings = new Set();
        this.hasWildcard = false;
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

    matches(tagsSet, rating) {
        if (this.isRating) return this.allowedRatings.has(normalizeRating(rating));
        if (this.hasWildcard) {
            for (const tag of tagsSet) {
                if (this.regex.test(tag)) return true;
            }
            return false;
        }
        return tagsSet.has(this.rawTerm);
    }
}

class BlacklistRule {
    constructor(line) {
        this.rawLine = line.trim();
        this.positiveTerms = [];
        this.negativeTerms = [];
        this.orGroups = [];
        this._parse(line);
    }

    _parse(line) {
        if (line.includes('#')) line = line.split('#')[0];
        line = line.trim();
        if (!line) return;

        const parsePrefix = (tok) => {
            if (tok.startsWith('-')) return ['-', tok.slice(1)];
            if (tok.startsWith('~')) return ['~', tok.slice(1)];
            return ['', tok];
        };

        const tokens = line.match(/-\(\s*[^)]+\s*\)|\(\s*[^)]+\s*\)|[^\s()]+/g) || [];
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
    constructor(blacklistText) {
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

        if (post.tags_categorized) {
            if (Array.isArray(post.tags_categorized)) {
                for (const tag of post.tags_categorized) {
                    if (tag) unionTags.add(String(tag).toLowerCase().trim());
                }
            } else if (typeof post.tags_categorized === 'object') {
                for (const category of Object.values(post.tags_categorized)) {
                    if (Array.isArray(category)) {
                        for (const tag of category) {
                            if (tag) unionTags.add(String(tag).toLowerCase().trim());
                        }
                    }
                }
            }
        }
    }

    return { unionTags, canonicalRating };
}

export function applyBlacklistToCluster(cluster, evaluator) {
    const { unionTags, canonicalRating } = getClusterUnionTagsAndRating(cluster.posts);
    const { isBlacklisted, matchedRule } = evaluator.evaluate(unionTags, canonicalRating);

    cluster.canonical_rating = canonicalRating;
    cluster.is_blacklisted = isBlacklisted;
    cluster.matched_rule = matchedRule;
}

export const BlacklistManager = {
    blacklistText: localStorage.getItem('e621_blacklist') || '',
    isImportingBlacklist: false,

    async saveBlacklist(silent = false) {
        localStorage.setItem('e621_blacklist', this.blacklistText);
        this.showBlacklistModal = false;

        const evaluator = new E621BlacklistEvaluator(this.blacklistText || '');
        for (const batch of this.batches) {
            if (!batch.clusters) continue;
            for (const cluster of batch.clusters) {
                applyBlacklistToCluster(cluster, evaluator);
                cluster.collapsed = cluster.is_resolved || cluster.is_blacklisted;
            }
        }

        if (!silent && this.showToast) {
            this.showToast('Blacklist updated.', 'success');
        }
    },

    async importBlacklist() {
        if (!this.e621User) return;
        
        this.isImportingBlacklist = true;
        
        try {
            const authString = btoa(`${this.e621User.username}:${this.e621User.apiKey}`);
            const appAuthor = import.meta.env.VITE_E621_APP_AUTHOR || 'anonymous';
            
            // Fetch the authenticated user's profile which contains their blacklist
            const res = await fetch(`https://e621.net/users/${this.e621User.id}.json`, {
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
                await this.saveBlacklist(true);
                if (this.showToast) {
                    this.showToast('Blacklist imported and saved successfully', 'success');
                }
            } else {
                throw new Error('Could not locate blacklisted tags in profile.');
            }
        } catch (err) {
            console.error('Blacklist import error:', err);
            if (this.showToast) {
                this.showToast(`Import failed: ${err.message}`, 'error');
            }
        } finally {
            this.isImportingBlacklist = false;
        }
    }
};