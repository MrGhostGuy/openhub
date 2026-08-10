const init = require('sql.js');
const fs = require('fs');
init().then(SQL => {
  const db = new SQL.Database(fs.readFileSync('dashboard.db'));
  const r = db.exec("SELECT detail FROM activity_log WHERE category='income' ORDER BY id DESC LIMIT 6");
  if (r[0]) r[0].values.forEach(v => console.log('-', v[0].slice(0, 90)));
  const a = db.exec("SELECT name, role, status FROM agents WHERE name LIKE '%Hustler%' OR name LIKE '%Income%'");
  if (a[0]) { console.log('--- agents ---'); a[0].values.forEach(v => console.log(v[0], '|', v[1], '|', v[2])); }
  else console.log('no hustler agent yet');
});
