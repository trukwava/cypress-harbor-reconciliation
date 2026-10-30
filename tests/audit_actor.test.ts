import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDB,DEMO_ORG,one} from '../src/db';
import {generateFixtures,seed} from '../src/seed';
import {addAlias,commitImport,reconcile} from '../src/domain';

test('canonical audit events retain the actual actor without synthetic duplicates',()=>{
  const db=createDB();seed(db);
  const f=generateFixtures();
  const result=commitImport(db,{
    kind:'obligation',filename:'audited-correction.csv',csv:f.correction,
    as_of:'2026-10-25',source_system:'MunicipalLedger',currency:'USD'
  },DEMO_ORG,'finance-admin');
  assert.equal(one(db,"SELECT actor FROM audit_events WHERE action='import.completed' AND object_id=?",result.report_id).actor,'finance-admin');

  addAlias(db,'CHH-P01','Audited Alias',DEMO_ORG,'finance-admin');
  assert.equal(one(db,"SELECT actor FROM audit_events WHERE action='property.alias_added' AND object_id=? ORDER BY rowid DESC LIMIT 1",'CHH-P01').actor,'finance-admin');

  const run=reconcile(db,DEMO_ORG,'finance-admin');
  assert.equal(one(db,"SELECT actor FROM audit_events WHERE action='reconciliation.completed' AND object_id=?",run.run_id).actor,'finance-admin');
  assert.equal(one(db,"SELECT COUNT(*) n FROM audit_events WHERE action IN ('actor.import','actor.alias','actor.reconcile')").n,0);
  db.close();
});
