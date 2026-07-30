import msgspec
from pydantic import BaseModel

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

class BulkPostContainer(msgspec.Struct):
    posts: list[PostData]

class BlacklistCheckRequest(BaseModel):
    blacklist: str
    batch_id: int

class E621PostFlagItem(msgspec.Struct, kw_only=True):
    """Schema matching array elements returned from e621's /post_flags.json endpoint."""
    id: int
    post_id: int
    is_resolved: bool
    is_deletion: bool

flag_decoder = msgspec.json.Decoder(type=list[E621PostFlagItem])