/**
 * Crash after an allocation and candidate status update but before the
 * match_decisions insert/COMMIT; the entire transaction must roll back.
 */
import fs from 'node:fs';
import {createDB,DEMO_ORG} from '../../src/db';
import {decideMatch} from '../../src/domain';
const [filename,candidateId,marker]=process.argv.slice(2);
if(!filename||!candidateId||!marker)throw new Error('Expected database, candidate and marker');
const db=createDB(filename);
db.function('kill_before_match_decision',()=>{
  fs.writeFileSync(marker,'crashed before match decision');
  process.kill(process.pid,'SIGKILL');
  return null;
});
db.exec("CREATE TEMP TRIGGER kill_match_decision BEFORE INSERT ON match_decisions BEGIN SELECT kill_before_match_decision(); END;");
decideMatch(db,candidateId,'accepted','Crash worker acceptance',100,DEMO_ORG,'crash-worker');
throw new Error('Crash injection did not trigger');
