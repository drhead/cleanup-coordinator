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

class E621PostFlagItem(msgspec.Struct, kw_only=True):
    """Schema matching array elements returned from e621's /post_flags.json endpoint."""
    id: int
    post_id: int
    is_resolved: bool
    is_deletion: bool

class TagsCategorized(msgspec.Struct, kw_only=True, rename="upper", omit_defaults=True):
    artist: list[str] = []
    contributor: list[str] = []
    copyright: list[str] = []
    character: list[str] = []
    species: list[str] = []
    general: list[str] = []
    meta: list[str] = []
    lore: list[str] = []
    invalid: list[str] = []

class ClusterPost(msgspec.Struct, kw_only=True):
    post_id: int
    cluster_id: int
    rating: str = "s"
    pool_ids: list[int] = msgspec.field(default_factory=list[int])
    tags_categorized: TagsCategorized = msgspec.field(default_factory=TagsCategorized)
    is_flagged: bool = False
    is_deleted: bool = False