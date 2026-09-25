const {DatabaseSync} = require('node:sqlite');
const fs = require('fs');
const src = 'C:/Users/nezuss/AppData/Roaming/com.singularity.app/singularity.db';
const tmp = 'C:/Users/nezuss/AppData/Local/Temp/mig12-test.db';
fs.copyFileSync(src, tmp);
const db = new DatabaseSync(tmp);
try {
  db.exec("ALTER TABLE ssh_servers ADD COLUMN os TEXT NOT NULL DEFAULT '';");
  db.exec("ALTER TABLE ssh_keys ADD COLUMN comment TEXT NOT NULL DEFAULT '';");
  console.log('migration 12 SQL: OK');
  const cols = db.prepare('PRAGMA table_info(ssh_servers)').all().map(c=>c.name);
  console.log('ssh_servers now:', cols.includes('os') ? 'os present' : 'MISSING os');
  const kcols = db.prepare('PRAGMA table_info(ssh_keys)').all().map(c=>c.name);
  console.log('ssh_keys now:', kcols.includes('comment') ? 'comment present' : 'MISSING comment');
} catch (e) {
  console.log('MIGRATION FAILED:', e.message);
} finally {
  db.close();
  fs.unlinkSync(tmp);
}
