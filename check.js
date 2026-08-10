const db = require('better-sqlite3')('C:/Users/kency/Desktop/OpenHub/dashboard.db');
const rows = db.prepare("SELECT * FROM activity_log WHERE agent_name LIKE '%Income%' OR agent_name LIKE '%Hustle%' ORDER BY timestamp DESC LIMIT 10").all();
console.log(JSON.stringify(rows, null, 2));