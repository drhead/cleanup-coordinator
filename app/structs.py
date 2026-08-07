import msgspec

class PostRelationships(msgspec.Struct):
    parent_id: int | None = None

class PostFlags(msgspec.Struct):
    flagged: bool
    deleted: bool

class PostData(msgspec.Struct):
    id: int
    rating: str
    tags: dict[str, list[str]]
    pools: list[int]
    relationships: PostRelationships
    flags: PostFlags

    def flat_tags(self) -> list[str]:
        """Flattens all category tag lists into a single deduplicated, sorted list."""
        flattened = {
            tag 
            for tag_list in self.tags.values() 
            for tag in tag_list
        }
        return sorted(flattened)

class E621PostFlagItem(msgspec.Struct, kw_only=True):
    """Schema matching array elements returned from e621's /post_flags.json endpoint."""
    id: int
    post_id: int
    is_resolved: bool
    is_deletion: bool