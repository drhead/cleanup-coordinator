from pathlib import Path
import msgspec

SECRETS_PATH = Path("secrets.json")


class Secrets(msgspec.Struct, kw_only=True):
    e621_username: str


secrets = msgspec.json.decode(SECRETS_PATH.read_bytes(), type=Secrets)