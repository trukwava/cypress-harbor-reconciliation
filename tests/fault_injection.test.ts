import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDB,DEMO_ORG,one,run,rows} from '../src/db';
import {commitImport,reconcile,state} from '../src/domain';
import {seed} from '../src/seed';
import {verifyDatabase} from '../src/backup';

function workspace(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chh-fault-'));
  return {dir,file:path.join(dir,'test.sqlite'),marker:path.join(dir,'crash-marker')};
}
function importCsv(prefix:string){
  return [
    'obligation_key,property_ref,invoice_ref,amount,reported_due,due_date,currency',
    prefix+'-1,CHH-P01,'+prefix+'-A,17.00,17.00,2026-11-02,USD',
    prefix+'-2,CHH-P02,'+prefix+'-B,19.00,19.00,2026-11-02,USD',
    prefix+'-3,CHH-P03,'+prefix+'-C,23.00,23.00,2026-11-02,USD'
  ].join('\n')+'\n';
}
function total(db:any,table:string){
  return one(db,'SELECT COUNT(*) n FROM '+table+' WHERE org_id=?',DEMO_ORG).n as number;
}
function importReport(db:any,prefix:string){
  return commitImport(db,{
    kind:'obligation',filename:prefix+'.csv',csv:importCsv(prefix),
    as_of:'2026-11-02',source_system:prefix==='FAULT-CRASH'?'CrashFixture':'FaultFixture',
    currency:'USD'
  });
}

test('injected failure on second source row rolls back the entire multi-row CSV import, then permits clean retry',()=>{
  const w=workspace(),db=createDB(w.file);
  try{
    seed(db);
    const reportCount=total(db,'source_reports'),rowCount=total(db,'source_rows');
    const oblCount=total(db,'obligations'),batchCount=total(db,'import_batches');
    const auditCount=one(db,"SELECT COUNT(*) n FROM audit_events WHERE org_id=? AND action='import.completed'",DEMO_ORG).n;
    db.exec("CREATE TEMP TRIGGER abort_second_row BEFORE INSERT ON source_rows WHEN NEW.source_key='FAULT-INTERRUPT-2' BEGIN SELECT RAISE(ABORT,'Injected mid-import write failure'); END;");
    assert.throws(()=>importReport(db,'FAULT-INTERRUPT'),/Injected mid-import write failure/);
    assert.equal(total(db,'source_reports'),reportCount);
    assert.equal(total(db,'source_rows'),rowCount);
    assert.equal(total(db,'obligations'),oblCount);
    assert.equal(total(db,'import_batches'),batchCount);
    assert.equal(one(db,"SELECT COUNT(*) n FROM audit_events WHERE org_id=? AND action='import.completed'",DEMO_ORG).n,auditCount);
    assert.equal(one(db,"SELECT COUNT(*) n FROM obligations WHERE source_key LIKE 'FAULT-INTERRUPT-%'").n,0);
    db.exec('DROP TRIGGER abort_second_row');
    const repaired=importReport(db,'FAULT-INTERRUPT');
    assert.equal(repaired.imported,3);
    assert.equal(total(db,'source_reports'),reportCount+1);
    assert.equal(total(db,'obligations'),oblCount+3);
    assert.equal(importReport(db,'FAULT-INTERRUPT').already_imported,true);
    assert.equal(total(db,'import_batches'),batchCount+1);
    assert.equal(total(db,'obligations'),oblCount+3);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
  }finally{db.close();fs.rmSync(w.dir,{recursive:true,force:true});}
});

test('injected snapshot write failure cannot leave a partial reconciliation run or audit event',()=>{
  const w=workspace(),db=createDB(w.file);
  try{
    seed(db);
    const first=state(db),runCount=total(db,'reconciliation_runs');
    const snapshotCount=total(db,'run_snapshots');
    const candidateCount=total(db,'match_candidates');
    const exceptionCount=total(db,'exceptions');
    const completed=one(db,"SELECT COUNT(*) n FROM audit_events WHERE org_id=? AND action='reconciliation.completed'",DEMO_ORG).n;
    db.exec("CREATE TEMP TRIGGER fail_run_snapshot BEFORE INSERT ON run_snapshots BEGIN SELECT RAISE(ABORT,'Injected reconciliation snapshot failure'); END;");
    assert.throws(()=>reconcile(db),/Injected reconciliation snapshot failure/);
    assert.equal(total(db,'reconciliation_runs'),runCount);
    assert.equal(total(db,'run_snapshots'),snapshotCount);
    assert.equal(total(db,'match_candidates'),candidateCount);
    assert.equal(total(db,'exceptions'),exceptionCount);
    assert.equal(one(db,"SELECT COUNT(*) n FROM audit_events WHERE org_id=? AND action='reconciliation.completed'",DEMO_ORG).n,completed);
    assert.equal(state(db).latest.id,first.latest.id);
    db.exec('DROP TRIGGER fail_run_snapshot');
    const recovered=reconcile(db);
    assert.ok(recovered.run_id);
    assert.equal(total(db,'reconciliation_runs'),runCount+1);
    assert.equal(total(db,'run_snapshots'),snapshotCount+1);
    assert.equal(one(db,"SELECT COUNT(*) n FROM audit_events WHERE org_id=? AND action='reconciliation.completed'",DEMO_ORG).n,completed+1);
  }finally{db.close();fs.rmSync(w.dir,{recursive:true,force:true});}
});

test('SIGKILL during second CSV row recovers WAL transaction without partial source or duplicate balances',()=>{
  const w=workspace();
  const beforeDb=createDB(w.file);
  seed(beforeDb);
  const initial=state(beforeDb);
  const counts={
    reports:total(beforeDb,'source_reports'),rows:total(beforeDb,'source_rows'),
    obligations:total(beforeDb,'obligations'),batches:total(beforeDb,'import_batches')
  };
  beforeDb.close();
  try{
    const script=path.join(__dirname,'fixtures','crash_import_worker.js');
    const child=spawnSync(process.execPath,[script,w.file,w.marker],
      {encoding:'utf8',timeout:10000});
    assert.equal(child.error,undefined,String(child.error||''));
    assert.equal(child.signal,'SIGKILL','Unexpected child result: '+child.stderr);
    assert.equal(fs.readFileSync(w.marker,'utf8'),'entered second CSV row');
    const recovered=createDB(w.file);
    try{
      assert.equal(total(recovered,'source_reports'),counts.reports);
      assert.equal(total(recovered,'source_rows'),counts.rows);
      assert.equal(total(recovered,'obligations'),counts.obligations);
      assert.equal(total(recovered,'import_batches'),counts.batches);
      assert.equal(one(recovered,"SELECT COUNT(*) n FROM source_reports WHERE filename='crash-fixture.csv'").n,0);
      assert.equal(one(recovered,"SELECT COUNT(*) n FROM obligations WHERE source_key LIKE 'FAULT-CRASH-%'").n,0);
      assert.equal(state(recovered).latest.id,initial.latest.id);
      assert.equal(state(recovered).metrics.explanatory_outstanding_minor,initial.metrics.explanatory_outstanding_minor);
      assert.equal(recovered.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
      const report=importReport(recovered,'FAULT-CRASH');
      assert.equal(report.imported,3);
      assert.equal(importReport(recovered,'FAULT-CRASH').already_imported,true);
      assert.equal(total(recovered,'obligations'),counts.obligations+3);
      assert.equal(one(recovered,"SELECT COUNT(*) n FROM audit_events WHERE action='import.completed' AND object_id=?",report.report_id).n,1);
    }finally{recovered.close();}
    const verified=verifyDatabase(w.file);
    assert.equal(verified.organizations,2);
  }finally{fs.rmSync(w.dir,{recursive:true,force:true});}
});
