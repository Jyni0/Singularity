
import sqlite3, os, shutil
p = os.path.join(os.environ["APPDATA"], "com.singularity.app", "singularity.db")
shutil.copy2(p, p + ".bak-sshfix")
con = sqlite3.connect(p)
cur = con.cursor()

def cols(table):
    return {r[1] for r in cur.execute(f"PRAGMA table_info({table})")}

# 1. ssh_servers: add host_key if missing
if "host_key" not in cols("ssh_servers"):
    cur.execute("ALTER TABLE ssh_servers ADD COLUMN host_key TEXT NOT NULL DEFAULT ''")
    print("added ssh_servers.host_key")
else:
    print("ssh_servers.host_key already present")

# 2. ssh_keys / ssh_scripts must exist with full shape (recreate if broken)
if "ssh_keys" not in {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
    cur.execute("""CREATE TABLE ssh_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      private_key TEXT NOT NULL DEFAULT '',
      passphrase TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()))""")
    print("created ssh_keys")
else:
    print("ssh_keys cols:", sorted(cols("ssh_keys")))

if "ssh_scripts" not in {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
    cur.execute("""CREATE TABLE ssh_scripts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()))""")
    print("created ssh_scripts")
else:
    print("ssh_scripts cols:", sorted(cols("ssh_scripts")))

# 3. key_id column on ssh_servers
if "key_id" not in cols("ssh_servers"):
    cur.execute("ALTER TABLE ssh_servers ADD COLUMN key_id TEXT NOT NULL DEFAULT ''")
    print("added ssh_servers.key_id")

con.commit()
print("--- final ssh_servers ---")
for row in cur.execute("PRAGMA table_info(ssh_servers)"):
    print(row)
con.close()
