/** Kill a subprocess after old demo records have been deleted in the reset
 * transaction but before the seed has been committed. */
import fs from 'node:fs';
import {createDB,DEMO_ORG} from '../../src/db';
import {resetDemo} from '../../src/seed';
const [file,marker]=process.argv.slice(2);
if(!file||!marker)throw new Error('Usage: crash_reset_worker <dbfile> <marker>');
const db=createDB(file);
db.function('interrupt_reset',()=>{
  fs.writeFileSync(marker,'reset reached first entity reinsertion');
  process.kill(process.pid,'SIGKILL');
  return null;
});
db.exec("CREATE TEMP TRIGGER crash_demo_reset BEFORE INSERT ON entities WHEN NEW.org_id='"+DEMO_ORG+"' BEGIN SELECT interrupt_reset(); END;");
resetDemo(db);
throw new Error('Expected SIGKILL not observed');
