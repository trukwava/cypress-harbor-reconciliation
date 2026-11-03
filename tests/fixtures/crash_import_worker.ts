/**
 * Subprocess-only crash injection: terminate while uncommitted source rows
 * are in flight. Never import into the main test-runner process.
 */
import fs from 'node:fs';
import {createDB} from '../../src/db';
import {commitImport} from '../../src/domain';

const [filename,marker]=process.argv.slice(2);
if(!filename||!marker)throw new Error('Usage: crash_import_worker <dbfile> <marker>');
const db=createDB(filename);
db.function('interrupt_import',()=>{
  fs.writeFileSync(marker,'entered second CSV row');
  process.kill(process.pid,'SIGKILL');
  return null; // Conform to node:sqlite callback's SQL-value type.
});
db.exec("CREATE TEMP TRIGGER crash_during_import BEFORE INSERT ON source_rows WHEN NEW.source_key='FAULT-CRASH-2' BEGIN SELECT interrupt_import(); END;");
const csv=[
  'obligation_key,property_ref,invoice_ref,amount,reported_due,due_date,currency',
  'FAULT-CRASH-1,CHH-P01,FAULT-CRASH-A,17.00,17.00,2026-11-02,USD',
  'FAULT-CRASH-2,CHH-P02,FAULT-CRASH-B,19.00,19.00,2026-11-02,USD',
  'FAULT-CRASH-3,CHH-P03,FAULT-CRASH-C,23.00,23.00,2026-11-02,USD'
].join('\n')+'\n';
commitImport(db,{kind:'obligation',filename:'crash-fixture.csv',csv,
  as_of:'2026-11-02',source_system:'CrashFixture',currency:'USD'});
throw new Error('Crash trigger did not run');
