/**
 * Crash precisely after exception update and resolution insertion but before
 * the final audit insert and transaction COMMIT.
 * This file is run only in an isolated subprocess.
 */
import fs from 'node:fs';
import {createDB,DEMO_ORG} from '../../src/db';
import {reviewException} from '../../src/domain';

const [filename,exceptionId,marker]=process.argv.slice(2);
if(!filename||!exceptionId||!marker)throw new Error('Expected database, exception and marker');
const db=createDB(filename);
db.function('kill_during_review_audit',()=>{
  fs.writeFileSync(marker,'crashed during review audit insert');
  process.kill(process.pid,'SIGKILL');
  return null;
});
// Created per connection: no modification to the real shared schema.
db.exec("CREATE TEMP TRIGGER kill_review_audit BEFORE INSERT ON audit_events WHEN NEW.object_type='exception' AND NEW.action='exception.reviewed' BEGIN SELECT kill_during_review_audit(); END;");
reviewException(db,exceptionId,'reviewed','Crash Worker',
  'This in-progress note must not survive',DEMO_ORG,'crash-worker',0);
throw new Error('Crash injection did not trigger');
