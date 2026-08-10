const initSqlJs = require('sql.js');
const fs = require('fs');

(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync('dashboard.db'));
  
  // Update Boobot Prime as lead agent
  db.run("UPDATE agents SET status='active', role='Lead Orchestrator & AI Companion', tasks_completed=50, updated_at=datetime('now') WHERE name='Boobot Prime'");
  
  fs.writeFileSync('dashboard.db', db.export());
  console.log('Boobot Prime updated as Lead Orchestrator');
  
  // Verify
  const res = db.exec("SELECT name, role, status, tasks_completed FROM agents WHERE name='Boobot Prime'");
  console.log(JSON.stringify(res, null, 2));
  db.close();
})();
