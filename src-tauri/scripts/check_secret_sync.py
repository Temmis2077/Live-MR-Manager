import os
import sqlite3

env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
if os.path.isfile(env_path):
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

db_candidates = [
    os.path.join(os.environ["LOCALAPPDATA"], identifier, "library.db")
    for identifier in ("com.osw.desktop", "com.autumncolor77.live-mr-manager")
]
db = next((path for path in db_candidates if os.path.isfile(path)), db_candidates[0])
conn = sqlite3.connect(db)
db_secret = conn.execute(
    "SELECT value FROM Settings WHERE key='meloming_client_secret'"
).fetchone()
db_len = len(db_secret[0]) if db_secret else 0
env_len = len(os.environ.get("MELOMING_CLIENT_SECRET", ""))
print("db_secret_set", db_len > 0, "db_len", db_len, "env_len", env_len, "match", db_secret and db_secret[0] == os.environ.get("MELOMING_CLIENT_SECRET", ""))
