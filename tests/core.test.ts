import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDB,DEMO_ORG,OTHER_ORG,rows,one,run} from '../src/db';
import {seed,generateFixtures,resetDemo} from '../src/seed';
import {addAllocation,addAlias,acceptConflict,commitImport,decideMatch,DomainError,exportPack,previewImport,reconcile,reviewException,state} from '../src/domain';
function setup(){const db=createDB();seed(db);return db;}

test('seed count, source provenance, 12 properties, 3 entities, partial/credit/stale/ambiguous fixtures',()=>{
  const db=setup(),s=state(db);
  assert.equal(s.properties.length,12);assert.equal(rows(db,'SELECT * FROM entities WHERE org_id=?',DEMO_ORG).length,3);
  assert.equal(s.obligations.length,40);assert.equal(s.payments.length,35);
  assert.ok(s.payments.some(x=>x.payment_type==='credit'));
  assert.ok(s.exceptions.some(x=>x.kind==='stale_source'));
  assert.ok(s.exceptions.some(x=>x.kind==='uncertain_identity'));
  assert.ok(s.unresolved.some(x=>x.validation_error.includes('Ambiguous property identity')));
  assert.ok(s.reports.length>=3);
  db.close();
});

test('exact $1,000 obligation, $600 payment, $400 explanatory remainder; not double-counted',()=>{
  const db=setup(),s=state(db);
  const o=s.obligations.find(x=>x.source_key==='OBL-001');const p=s.payments.find(x=>x.source_key==='PAY-001');
  assert.equal(o.amount_minor,100000);assert.equal(o.reported_due_minor,100000);
  assert.equal(o.allocated_minor,60000);assert.equal(o.remaining_minor,40000);
  assert.equal(p.amount_minor,60000);
  const issue=s.exceptions.find(x=>x.obligation_id===o.id&&x.kind==='paid_elsewhere_still_due');
  assert.ok(issue);assert.equal(issue.amount_minor,60000);assert.match(issue.reason,/Not a confirmed debt/);
  assert.equal(s.metrics.explanatory_outstanding_minor,s.metrics.original_obligations_minor-s.metrics.allocated_minor);
  const pack=exportPack(db);assert.ok(pack.source_rows.some(r=>r.raw.obligation_key==='OBL-001'));
  db.close();
});

test('SQLite prevents double allocation, property/organization crossing, and over-obligation',()=>{
  const db=setup(),o=one(db,'SELECT * FROM obligations WHERE source_key=?','OBL-001'),p=one(db,'SELECT * FROM payments WHERE source_key=?','PAY-001');
  const other=one(db,'SELECT * FROM obligations WHERE source_key=?','OBL-002');
  assert.throws(()=>addAllocation(db,DEMO_ORG,p.id,other.id,1),/cross-property/);
  assert.throws(()=>addAllocation(db,DEMO_ORG,p.id,o.id,60000),/constraint|over-allocation|UNIQUE/);
  assert.throws(()=>run(db,'INSERT INTO allocations VALUES (?,?,?,?,?,?,?)','attack',OTHER_ORG,p.id,o.id,1,new Date().toISOString(),'attack'),/cross-organization/);
  db.close();
});

test('duplicate invoice 101 remains distinct across properties',()=>{
  const db=setup();const a=rows(db,'SELECT property_id FROM obligations WHERE invoice_ref=?','101');
  assert.equal(a.length,2);assert.notEqual(a[0].property_id,a[1].property_id);
  assert.equal(state(db).exceptions.filter(e=>e.kind==='duplicate_reference').length,0);
  db.close();
});

test('repeat import under different filename leaves balances and exception counts unchanged',()=>{
  const db=setup(),before=state(db),f=generateFixtures();
  const output=commitImport(db,{kind:'obligation',filename:'renamed.csv',csv:f.obl,as_of:'2026-10-20',source_system:'MunicipalLedger',currency:'USD'});
  assert.equal(output.already_imported,true);
  const rr=reconcile(db),after=state(db);
  assert.equal(after.obligations.length,before.obligations.length);
  assert.equal(after.metrics.original_source_due_minor,before.metrics.original_source_due_minor);
  assert.equal(rr.exceptions,before.exceptions.length);
  db.close();
});

test('new snapshot with identical records creates evidence but no duplicate obligations',()=>{
  const db=setup(),f=generateFixtures(),before=state(db);
  const result=commitImport(db,{kind:'obligation',filename:'later.csv',csv:f.obl,as_of:'2026-10-24',source_system:'MunicipalLedger',currency:'USD'});
  assert.equal(result.imported,0);assert.equal(result.duplicates,39);assert.equal(result.errors,1);
  const after=state(db);assert.equal(after.obligations.length,before.obligations.length);
  assert.equal(after.metrics.original_obligations_minor,before.metrics.original_obligations_minor);
  db.close();
});

test('corrected reports require explicit approval, then reviewed changed-basis exception reopens',()=>{
  const db=setup(),before=state(db),target=before.exceptions.find(e=>e.kind==='paid_elsewhere_still_due'&&e.obligation_key==='OBL-001');
  assert.ok(target);
  reviewException(db,target.id,'reviewed','Finance Analyst','Checked original discrepancy');
  const unchanged=reconcile(db),same=state(db),sameIssue=same.exceptions.find(e=>e.issue_key===target.issue_key);
  assert.equal(sameIssue.status,'reviewed');assert.equal(sameIssue.owner,'Finance Analyst');
  const f=generateFixtures();const outcome=commitImport(db,{kind:'obligation',filename:'corrected.csv',csv:f.correction,as_of:'2026-10-25',source_system:'MunicipalLedger',currency:'USD'});
  assert.equal(outcome.conflicts,1);
  assert.equal(one(db,'SELECT reported_due_minor FROM obligations WHERE source_key=?','OBL-001').reported_due_minor,100000);
  const conflict=one(db,'SELECT id FROM import_conflicts WHERE org_id=? AND status=?',DEMO_ORG,'pending');
  acceptConflict(db,conflict.id,'accepted');
  assert.equal(one(db,'SELECT reported_due_minor FROM obligations WHERE source_key=?','OBL-001').reported_due_minor,90000);
  reconcile(db);const newest=state(db).exceptions.find(e=>e.issue_key===target.issue_key);
  assert.equal(newest.status,'open');assert.ok(newest.reopened_from);assert.equal(newest.owner,'Finance Analyst');
  assert.notEqual(newest.basis_hash,sameIssue.basis_hash);
  db.close();
});

test('suggestions require exact property; accepting uses constrained allocation and audit',()=>{
  const db=setup(),s=state(db),c=s.candidates.find(c=>c.status==='proposed'&&c.available_payment_minor>0);
  assert.ok(c);
  const before=rows(db,'SELECT * FROM allocations WHERE org_id=?',DEMO_ORG).length;
  decideMatch(db,c.id,'accepted','Checked invoice and property',Math.min(2500,c.available_payment_minor,c.outstanding_obligation_minor));
  assert.equal(rows(db,'SELECT * FROM allocations WHERE org_id=?',DEMO_ORG).length,before+1);
  assert.equal(one(db,'SELECT status FROM match_candidates WHERE id=?',c.id).status,'accepted');
  assert.ok(one(db,'SELECT id FROM audit_events WHERE object_type=? AND object_id=?','match_candidate',c.id));
  assert.throws(()=>decideMatch(db,c.id,'accepted','again',100),/already decided/);
  db.close();
});

test('CSV malformed, identity uncertainty, raw data preservation; alias cannot cross tenant',()=>{
  const db=setup(),f=generateFixtures();
  assert.throws(()=>previewImport(db,{kind:'payment',filename:'mal.csv',csv:f.malformed,as_of:'2026-10-20',source_system:'VendorPayments',currency:'USD'}),/Unclosed quoted field/);
  assert.throws(()=>addAlias(db,'OTHER-P1','Bad alias'),/not found/);
  assert.throws(()=>reviewException(db,'OTHER-EXCEPTION','reviewed','attacker',''),/not found/);
  const p=previewImport(db,{kind:'obligation',filename:'o.csv',csv:f.obl,as_of:'2026-10-20',source_system:'MunicipalLedger',currency:'USD'});
  assert.ok(p.rows.find(r=>r.normalized.source_key==='OBL-AMB')?.error);
  const original=one(db,'SELECT raw_json FROM source_rows WHERE source_key=?','OBL-AMB');assert.match(original.raw_json,/88 Bay Street/);
  db.close();
});

test('demo reset does not touch other organization and restores initial counts',()=>{
  const db=setup();const before=one(db,'SELECT COUNT(*) n FROM properties WHERE org_id=?',OTHER_ORG).n;
  addAlias(db,'CHH-P01','Temporary Reset Alias');
  resetDemo(db);const after=state(db);
  assert.equal(after.obligations.length,40);assert.equal(after.payments.length,35);
  assert.equal(one(db,'SELECT COUNT(*) n FROM properties WHERE org_id=?',OTHER_ORG).n,before);
  assert.equal(rows(db,'SELECT * FROM aliases WHERE alias=?','Temporary Reset Alias').length,0);
  db.close();
});

test('historical run export retains original evidence and balances after correction',()=>{
  const db=setup(),initial=state(db),runId=initial.latest.id;
  const f=generateFixtures();const result=commitImport(db,{kind:'obligation',filename:'corrected.csv',csv:f.correction,as_of:'2026-10-25',source_system:'MunicipalLedger',currency:'USD'});
  assert.equal(result.conflicts,1);const c=one(db,'SELECT id FROM import_conflicts WHERE status=?','pending');acceptConflict(db,c.id,'accepted');
  reconcile(db);const current=state(db),prior=state(db,DEMO_ORG,runId);
  assert.equal(current.obligations.find(o=>o.source_key==='OBL-001').reported_due_minor,90000);
  assert.equal(prior.obligations.find(o=>o.source_key==='OBL-001').reported_due_minor,100000);
  assert.equal(prior.metrics.original_source_due_minor,initial.metrics.original_source_due_minor);
  assert.equal(current.metrics.original_source_due_minor,initial.metrics.original_source_due_minor-10000);
  const pack=exportPack(db,DEMO_ORG,runId);
  assert.equal(pack.manifest.selected_run,runId);
  assert.equal(pack.original_obligations.find(o=>o.source_key==='OBL-001').reported_due_minor,100000);
  assert.equal(pack.metrics.original_source_due_minor,initial.metrics.original_source_due_minor);
  assert.throws(()=>reviewException(db,initial.exceptions[0].id,'reviewed','x','too late'),/Historical runs are read-only/);
  db.close();
});

test('rejected match decision carries into next run if evidence unchanged',()=>{
  const db=setup(),first=state(db),candidate=first.candidates.find(c=>c.status==='proposed');
  decideMatch(db,candidate.id,'rejected','Source does not establish same obligation',undefined);
  reconcile(db);const following=state(db).candidates.find(c=>c.obligation_id===candidate.obligation_id&&c.payment_id===candidate.payment_id);
  assert.ok(following);assert.equal(following.status,'rejected');
  assert.throws(()=>decideMatch(db,candidate.id,'accepted','historical',100),/already decided|Historical runs are read-only/);
  db.close();
});

test('amount mismatch and unmatched payment are visible as separate exception types',()=>{
  const db=setup(),kinds=new Set(state(db).exceptions.map(e=>e.kind));
  assert.ok(kinds.has('amount_mismatch'));
  assert.ok(kinds.has('unmatched_payment'));
  db.close();
});

test('database rejects cross-tenant foreign keys on insert and update, independent of API',()=>{
  const db=setup();
  const otherEntity=one(db,'SELECT id FROM entities WHERE org_id=?',OTHER_ORG);
  const p=one(db,'SELECT id FROM properties WHERE org_id=?',DEMO_ORG);
  const ob=one(db,'SELECT id FROM obligations WHERE org_id=?',DEMO_ORG);
  const otherProp=one(db,'SELECT id FROM properties WHERE org_id=?',OTHER_ORG);
  const report=one(db,'SELECT id FROM source_reports WHERE org_id=? AND kind=?',DEMO_ORG,'obligation');
  const row=one(db,'SELECT id FROM source_rows WHERE report_id=? AND validation_error IS NULL LIMIT 1',report.id);
  assert.throws(()=>run(db,'UPDATE properties SET entity_id=? WHERE id=?',otherEntity.id,p.id),/cross-organization reference/);
  assert.throws(()=>run(db,'INSERT INTO aliases VALUES (?,?,?,?,?)','rogue-alias',DEMO_ORG,otherProp.id,'Rogue',1),/cross-organization reference/);
  assert.throws(()=>run(db,'INSERT INTO external_accounts VALUES (?,?,?,?,?)','rogue-account',DEMO_ORG,otherProp.id,'ExternalSystem','acct-123'),/cross-organization reference/);
  assert.throws(()=>run(db,'UPDATE obligations SET property_id=? WHERE id=?',otherProp.id,ob.id),/cross-organization reference/);
  assert.throws(()=>run(db,'INSERT INTO source_rows VALUES (?,?,?,?,?,?,?,?,?,?)','rogue-row',OTHER_ORG,report.id,999,'rogue','obligation','{}','{}','abc',null),/cross-organization reference/);
  run(db,'INSERT INTO source_reports VALUES (?,?,?,?,?,?,?,?,?,?)','OTHER-R1',OTHER_ORG,'obligation','Outside','other.csv','2026-10-20','USD','otherhash',new Date().toISOString(),'id,value');
  run(db,'INSERT INTO source_rows VALUES (?,?,?,?,?,?,?,?,?,?)','OTHER-ROW',OTHER_ORG,'OTHER-R1',1,'external','obligation','{}','{}','rowhash',null);
  assert.throws(()=>run(db,'UPDATE obligations SET source_row_id=? WHERE id=?','OTHER-ROW',ob.id),/cross-organization reference/);
  const otherRun=one(db,'SELECT id FROM reconciliation_runs WHERE org_id=?',DEMO_ORG);
  assert.throws(()=>run(db,'UPDATE run_snapshots SET org_id=? WHERE run_id=?',OTHER_ORG,otherRun.id),/cross-organization reference/);
  assert.throws(()=>run(db,'INSERT INTO match_decisions VALUES (?,?,?,?,?,?,?,?)','wrong-org-decision',OTHER_ORG,one(db,'SELECT id FROM match_candidates WHERE org_id=?',DEMO_ORG).id,'rejected',0,'bad','bad',new Date().toISOString()),/cross-organization reference/);
  const sample=one(db,'SELECT id FROM exceptions WHERE org_id=?',DEMO_ORG);
  assert.throws(()=>run(db,'INSERT INTO resolutions VALUES (?,?,?,?,?,?,?)','wrong-org-resolution',OTHER_ORG,sample.id,'open','bad','bad',new Date().toISOString()),/cross-organization reference/);
  assert.ok(otherRun.id && row.id);
  db.close();
});


test('historical match candidates retain frozen available amounts after subsequent allocations',()=>{
  const db=setup();
  const before=state(db);
  const candidate=before.candidates.find((c:any)=>c.status==='proposed'&&c.available_payment_minor>0&&c.outstanding_obligation_minor>0);
  assert.ok(candidate,'seed must contain a reviewable match');
  const frozenPayment=candidate.available_payment_minor;
  const frozenObligation=candidate.outstanding_obligation_minor;
  decideMatch(db,candidate.id,'accepted','Matched identifiers and evidence',Math.min(100,frozenPayment,frozenObligation));
  const afterDecision=state(db,DEMO_ORG,before.latest.id);
  const historical=afterDecision.candidates.find((c:any)=>c.id===candidate.id);
  assert.equal(historical.available_payment_minor,frozenPayment);
  assert.equal(historical.outstanding_obligation_minor,frozenObligation);
  reconcile(db);
  const afterNewRun=state(db,DEMO_ORG,before.latest.id);
  const stillHistorical=afterNewRun.candidates.find((c:any)=>c.id===candidate.id);
  assert.equal(stillHistorical.available_payment_minor,frozenPayment);
  assert.equal(stillHistorical.outstanding_obligation_minor,frozenObligation);
  const pack=exportPack(db,DEMO_ORG,before.latest.id);
  const exported=pack.candidates.find((c:any)=>c.id===candidate.id);
  assert.equal(exported.available_payment_minor,frozenPayment);
  assert.equal(exported.outstanding_obligation_minor,frozenObligation);
  db.close();
});
