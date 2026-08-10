const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, 'dashboard.db');
(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_PATH));
  db.run('UPDATE businesses SET revenue=0, expenses=0, customers=0, sessions=0');
  db.run("DELETE FROM metric_snapshots");
  db.run("DELETE FROM business_events WHERE event_type IN ('sale','lead','content')");
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  console.log('cleaned fake financial data');
})();
