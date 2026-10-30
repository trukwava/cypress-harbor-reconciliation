import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDB,DEMO_ORG,one} from '../src/db';
import {seed,generateFixtures} from '../src/seed';
import {addAlias,acceptConflict,commitImport,decideMatch,reconcile,state} from '../src/domain';

test('pending evidence indicator follows audit sequence across imports, decisions, allocations and new runs',()=>{
  const db=createDB();seed(db);
  const original=state(db),firstRun=original.latest.id;
  assert.equal(original.pending_reconciliation,false);
  const f=generateFixtures();
  commitImport(db,{kind:'obligation',filename:'freshness-correction.csv',csv:f.correction,as_of:'2026-10-25',source_system:'MunicipalLedger',currency:'USD'});
  assert.equal(state(db).pending_reconciliation,true);
  assert.ok(state(db).pending_evidence_events>0);
  // Earlier run still reports the original, frozen obligation amount.
  assert.equal(state(db,DEMO_ORG,firstRun).obligations.find((o:any)=>o.source_key==='OBL-001').reported_due_minor,100000);
  reconcile(db);
  assert.equal(state(db).pending_reconciliation,false);

  const conflict=one(db,"SELECT id FROM import_conflicts WHERE org_id=? AND status='pending' LIMIT 1",DEMO_ORG);
  assert.ok(conflict);
  acceptConflict(db,conflict.id,'rejected');
  assert.equal(state(db).pending_reconciliation,true);
  reconcile(db);
  assert.equal(state(db).pending_reconciliation,false);

  addAlias(db,'CHH-P01','Freshness Test Address Alias');
  assert.equal(state(db).pending_reconciliation,true);
  reconcile(db);
  assert.equal(state(db).pending_reconciliation,false);

  const candidate=state(db).candidates.find((c:any)=>c.status==='proposed'&&c.available_payment_minor>0&&c.outstanding_obligation_minor>0);
  assert.ok(candidate);
  decideMatch(db,candidate.id,'accepted','Reviewed source identity',100);
  assert.equal(state(db).pending_reconciliation,true);
  reconcile(db);
  assert.equal(state(db).pending_reconciliation,false);
  db.close();
});
