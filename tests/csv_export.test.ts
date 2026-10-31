import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDB,DEMO_ORG,OTHER_ORG} from '../src/db';
import {seed} from '../src/seed';
import {reconcile,reviewException,state} from '../src/domain';
import {exceptionQueueCSV} from '../src/csv_export';

test('exception CSV preserves run selection and neutralizes spreadsheet formulas',()=>{
  const db=createDB();seed(db);
  const first=state(db),firstId=first.latest.id;
  const target=first.exceptions[0];
  reviewException(db,target.id,'reviewed','=2+3','+SUM("x")',DEMO_ORG,'CSV Reviewer',target.review_revision);
  const output=exceptionQueueCSV(db,DEMO_ORG,firstId);
  assert.equal(output.count,first.exceptions.length);
  assert.match(output.filename,/^reconciliation-exceptions-.*\.csv$/);
  assert.ok(output.csv.startsWith('"run_id","exception_id","kind"'));
  assert.ok(output.csv.includes("'=2+3"),'Formula-like owner must be neutralized');
  assert.ok(output.csv.includes("'+SUM("),'Formula-like note must be neutralized');
  assert.ok(output.csv.includes('""x""'),'Double quotes must be escaped');
  assert.ok(output.csv.includes('\r\n'),'CSV must have standard CRLF line endings');
  reconcile(db);
  assert.equal(exceptionQueueCSV(db,DEMO_ORG,firstId).count,first.exceptions.length);
  assert.throws(()=>exceptionQueueCSV(db,OTHER_ORG),/No reconciliation run/);
  db.close();
});
