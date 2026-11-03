import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDB,DEMO_ORG,one} from '../src/db';
import {seed,resetDemo} from '../src/seed';
import {reviewException,state} from '../src/domain';
import {createUser} from '../src/auth';
import {verifyDatabase} from '../src/backup';

function files(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chh-atomic-reset-'));
  return {dir,file:path.join(dir,'reset.sqlite'),marker:path.join(dir,'reset-marker')};
}
function recordReview(db:any){
  const ex=state(db).exceptions[0];
  reviewException(db,ex.id,'reviewed','Recovery Reviewer','Keep this history after failed reset',DEMO_ORG,'recovery-reviewer',ex.review_revision);
  return ex.id as string;
}
function snapshot(db:any,reviewId:string){
  const stateNow=state(db);
  return {
    runId:stateNow.latest.id,
    sourceCount:stateNow.reports.length,
    obligationCount:stateNow.obligations.length,
    paymentCount:stateNow.payments.length,
    allocationCount:one(db,'SELECT COUNT(*) n FROM allocations WHERE org_id=?',DEMO_ORG).n,
    reviewed:one(db,'SELECT status,owner,note,review_revision FROM exceptions WHERE id=?',reviewId),
    resolutionCount:one(db,'SELECT COUNT(*) n FROM resolutions WHERE exception_id=?',reviewId).n,
    auditCount:one(db,'SELECT COUNT(*) n FROM audit_events WHERE org_id=?',DEMO_ORG).n
  };
}
function same(db:any,reviewId:string,prior:any){
  const after=snapshot(db,reviewId);
  assert.equal(after.runId,prior.runId);
  assert.equal(after.sourceCount,prior.sourceCount);
  assert.equal(after.obligationCount,prior.obligationCount);
  assert.equal(after.paymentCount,prior.paymentCount);
  assert.equal(after.allocationCount,prior.allocationCount);
  assert.equal(after.reviewed.status,'reviewed');
  assert.equal(after.reviewed.owner,'Recovery Reviewer');
  assert.equal(after.reviewed.note,'Keep this history after failed reset');
  assert.equal(after.reviewed.review_revision,1);
  assert.equal(after.resolutionCount,prior.resolutionCount);
  assert.equal(after.auditCount,prior.auditCount);
}
test('failed seed in demo reset restores prior data, reviewer notes and history atomically',()=>{
  const x=files(),db=createDB(x.file);
  try{
    seed(db);
    createUser(db,'reset-admin','Secure-Demo-Passphrase-5678','admin');
    const reviewId=recordReview(db),prior=snapshot(db,reviewId);
    db.exec("CREATE TEMP TRIGGER fail_reseed BEFORE INSERT ON entities WHEN NEW.org_id='"+DEMO_ORG+"' BEGIN SELECT RAISE(ABORT,'Injected reseed failure'); END;");
    assert.throws(()=>resetDemo(db),/Injected reseed failure/);
    same(db,reviewId,prior);
    assert.ok(one(db,"SELECT id FROM local_users WHERE username='reset-admin'"));
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
    db.exec('DROP TRIGGER fail_reseed');
    const result=resetDemo(db);
    assert.equal(result.org,DEMO_ORG);
    const fresh=state(db);
    assert.equal(fresh.obligations.length,40);
    assert.equal(fresh.payments.length,35);
    assert.notEqual(fresh.latest.id,prior.runId);
    assert.equal(one(db,'SELECT COUNT(*) n FROM resolutions WHERE exception_id=?',reviewId).n,0);
    assert.ok(one(db,"SELECT id FROM local_users WHERE username='reset-admin'"));
  }finally{db.close();fs.rmSync(x.dir,{recursive:true,force:true});}
});

test('forced SIGKILL during reseed recovers the original reviewed run instead of an empty tenant',()=>{
  const x=files(),db=createDB(x.file);
  seed(db);
  const reviewId=recordReview(db);
  const prior=snapshot(db,reviewId);
  db.close();
  try{
    const worker=path.join(__dirname,'fixtures','crash_reset_worker.js');
    const killed=spawnSync(process.execPath,[worker,x.file,x.marker],{encoding:'utf8',timeout:10000});
    assert.equal(killed.error,undefined,String(killed.error||''));
    assert.equal(killed.signal,'SIGKILL',killed.stderr);
    assert.equal(fs.readFileSync(x.marker,'utf8'),'reset reached first entity reinsertion');
    const recovered=createDB(x.file);
    try{
      same(recovered,reviewId,prior);
      assert.equal(recovered.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
    }finally{recovered.close();}
    assert.equal(verifyDatabase(x.file).frozen_runs,1);
  }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
});
