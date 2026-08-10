const { initDatabase, getDb } = require('./database.js');
const fs = require('fs');
const path = require('path');

async function clearTasks() {
  await initDatabase();
  const db = getDb();
  
  db.run('DELETE FROM tasks');
  db.run('DELETE FROM task_logs');
  db.run("DELETE FROM sqlite_sequence WHERE name IN ('tasks','task_logs')");
  
  // Force immediate persist
  const data = db.export();
  fs.writeFileSync(path.join(__dirname, 'dashboard.db'), Buffer.from(data));
  
  console.log('Tasks cleared and persisted');
  process.exit(0);
}

clearTasks().catch(e => { console.error(e); process.exit(1); });