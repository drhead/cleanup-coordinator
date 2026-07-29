"""E621 tag blacklist parsing and cluster evaluation logic."""

import base64
from fnmatch import fnmatch
import re
from typing import Any
from urllib.parse import unquote

RATING_MAP: dict[str, str] = {
    "s": "s",
    "safe": "s",
    "q": "q",
    "questionable": "q",
    "e": "e",
    "explicit": "e",
}

RATING_ORDER: dict[str, int] = {"e": 3, "q": 2, "s": 1}


class TermMatcher:
    """Matches a single tag term, wildcard pattern, or rating specifier."""

    def __init__(self, raw_term: str) -> None:
        self.raw_term: str = raw_term.lower().strip()
        self.is_rating: bool = self.raw_term.startswith("rating:")
        self.allowed_ratings: set[str] = set()
        self.has_wildcard: bool = False

        if self.is_rating:
            rating_val = self.raw_term.split(":", 1)[1]
            parts = rating_val.split(",")
            self.allowed_ratings = {
                RATING_MAP.get(p.strip(), p.strip()) for p in parts if p.strip()
            }
        else:
            self.has_wildcard = "*" in self.raw_term

    def matches(self, tags: set[str], rating: str) -> bool:
        if self.is_rating:
            return rating in self.allowed_ratings
        if self.has_wildcard:
            return any(fnmatch(t, self.raw_term) for t in tags)
        return self.raw_term in tags


class BlacklistRule:
    """Represents a single parsed line/rule from an e621 blacklist."""

    def __init__(self, line: str) -> None:
        self.raw_line: str = line.strip()
        self.positive_terms: list[TermMatcher] = []
        self.negative_terms: list[TermMatcher] = []
        self.or_groups: list[list[TermMatcher]] = []
        self._parse(line)

    def _parse(self, line: str) -> None:
        if "#" in line:
            line = line.split("#", 1)[0]
        line = line.strip()
        if not line:
            return

        def parse_prefix(tok: str) -> tuple[str, str]:
            if tok.startswith("-"):
                return ("-", tok[1:])
            if tok.startswith("~"):
                return ("~", tok[1:])
            return ("", tok)

        tokens: list[str] = re.findall(
            r"-\(\s*[^)]+\s*\)|\(\s*[^)]+\s*\)|[^\s()]+", line
        )
        standalone_or_group: list[TermMatcher] = []

        for token in tokens:
            token = token.strip()
            if not token:
                continue

            if token.startswith("-(") and token.endswith(")"):
                inner = token[2:-1].strip()
                for itok in inner.split():
                    _, clean = parse_prefix(itok)
                    self.negative_terms.append(TermMatcher(clean))

            elif token.startswith("(") and token.endswith(")"):
                inner = token[1:-1].strip()
                group: list[TermMatcher] = []
                for itok in inner.split():
                    _, clean = parse_prefix(itok)
                    group.append(TermMatcher(clean))
                if group:
                    self.or_groups.append(group)

            else:
                prefix, clean = parse_prefix(token)
                if prefix == "-":
                    if standalone_or_group:
                        self.or_groups.append(standalone_or_group)
                        standalone_or_group = []
                    self.negative_terms.append(TermMatcher(clean))

                elif prefix == "~":
                    standalone_or_group.append(TermMatcher(clean))

                else:
                    if standalone_or_group:
                        self.or_groups.append(standalone_or_group)
                        standalone_or_group = []
                    self.positive_terms.append(TermMatcher(clean))

        if standalone_or_group:
            self.or_groups.append(standalone_or_group)

    def is_empty(self) -> bool:
        return not (
            self.positive_terms or self.negative_terms or self.or_groups
        )

    def matches(self, tags: set[str], rating: str) -> bool:
        if self.is_empty():
            return False

        for term in self.positive_terms:
            if not term.matches(tags, rating):
                return False

        for term in self.negative_terms:
            if term.matches(tags, rating):
                return False

        for group in self.or_groups:
            if not any(term.matches(tags, rating) for term in group):
                return False

        return True


class E621BlacklistEvaluator:
    """Evaluates text/tag rules against target post/cluster metadata."""

    def __init__(self, blacklist_text: str) -> None:
        self.rules: list[BlacklistRule] = []
        for line in blacklist_text.splitlines():
            rule = BlacklistRule(line)
            if not rule.is_empty():
                self.rules.append(rule)

    def evaluate(self, tags: set[str], rating: str) -> tuple[bool, str | None]:
        """Returns (is_blacklisted, matching_rule_line)."""
        for rule in self.rules:
            if rule.matches(tags, rating):
                return True, rule.raw_line
        return False, None


def decode_blacklist_header(header_val: str | None) -> str | None:
    """Decodes a URL-encoded or Base64-encoded blacklist header string."""
    if not header_val:
        return None

    # Try Base64 decoding first
    try:
        return base64.b64decode(header_val).decode("utf-8")
    except Exception:
        pass

    # Fall back to standard URL unquoting
    try:
        return unquote(header_val)
    except Exception:
        return header_val


def get_cluster_union_tags_and_rating(
    cluster_posts: list[dict[str, Any]],
) -> tuple[set[str], str]:
    """Extracts union set of tags and canonical highest rating (e > q > s)."""
    union_tags: set[str] = set()
    max_rating_score = 0
    canonical_rating = "s"

    for post in cluster_posts:
        p_rating = (post.get("rating") or "s").lower()
        score = RATING_ORDER.get(p_rating, 1)
        if score > max_rating_score:
            max_rating_score = score
            canonical_rating = p_rating

        tags_dict: dict[str, list[str]] = post.get("tags_json") or {}

        for cat_tags in tags_dict.values():
            for tag in cat_tags:
                union_tags.add(tag.lower())

    return union_tags, canonical_rating