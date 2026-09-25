import sqlite3, os, hashlib
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
db_rs = open(os.path.join(root, "src-tauri", "src", "db.rs"), encoding="utf-8").read()
i = db_rs.find("fn ssh_assets_migration")
assert i >= 0, "migration fn not found"
seg = db_rs[i:i+2000]
j = seg.find('sql: "') + len('sql: "')
k = seg.find('",', j)
sql = seg[j:k]
print("sql head:", repr(sql[:50]))
print("sql tail:", repr(sql[-50:]))
checksum = hashlib.sha384(sql.encode()).digest()
print("sha384:", checksum.hex())
p = os.path.join(os.environ["APPDATA"], "com.singularity.app", "singularity.db")
con = sqlite3.connect(p)
cur = con.cursor()
row = list(cur.execute("SELECT checksum FROM _sqlx_migrations WHERE version=11"))
print("ledger before:", bytes(row[0][0]).hex())
cur.execute("UPDATE _sqlx_migrations SET checksum=? WHERE version=11", (checksum,))
con.commit()
row2 = list(cur.execute("SELECT checksum FROM _sqlx_migrations WHERE version=11"))[0]
print("ledger after:", bytes(row2[0]).hex())
con.close()
print("OK")