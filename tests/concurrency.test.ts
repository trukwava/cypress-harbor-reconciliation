import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createDB,DatabaseBusyError,DEMO_ORG,one,rows} from '../src/db';
import {seed} from '../src/seed';
import {decideMatch,DomainError,state} from '../src/domain';

function workFile(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'chh-concurrent-'));
  return {directory,file:path.join(directory,'race.sqlite')};
}
function candidate(db:any){
  const c=state(db).candidates.find((item:any)=>
    item.status==='proposed'&&item.available_payment_minor>=100&&item.outstanding_obligation_minor>=100);
  assert.ok(c,'seed must contain a candidate with allocatable balance');
  return c;
}
function allocationTotal(db:any,id:string){
  return one(db,'SELECT COALESCE(SUM(amount_minor),0) n FROM allocations WHERE payment_id=?',id).n as number;
}

test('a locked writer produces a retryable conflict without partial allocation or decision',()=>{
  const {directory,file}=workFile();
  const first=createDB(file);seed(first);
  const second=createDB(file);
  second.exec('PRAGMA busy_timeout=0');
  try{
    const c=candidate(first);
    const before=allocationTotal(first,c.payment_id);
    first.exec('BEGIN IMMEDIATE');
    try{
      assert.throws(()=>decideMatch(second,c.id,'accepted','Second reviewer',100,DEMO_ORG,'reviewer-2'),
        (error:any)=>error instanceof DatabaseBusyError&&/retry/.test(error.message));
    }finally{first.exec('ROLLBACK');}
    assert.equal(allocationTotal(first,c.payment_id),before);
    assert.equal(one(first,'SELECT status FROM match_candidates WHERE id=?',c.id).status,'proposed');
    const accepted=decideMatch(second,c.id,'accepted','First completed reviewer',100,DEMO_ORG,'reviewer-2');
    assert.equal(accepted.allocation_minor,100);
    assert.throws(()=>decideMatch(first,c.id,'accepted','Outdated reviewer',100,DEMO_ORG,'reviewer-1'),
      (error:any)=>error instanceof DomainError&&error.status===409);
    assert.equal(allocationTotal(first,c.payment_id),before+100);
    assert.equal(one(first,'SELECT COUNT(*) n FROM match_decisions WHERE candidate_id=?',c.id).n,1);
  }finally{second.close();first.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('two independent workers racing to decide the same candidate can record only one allocation',async()=>{
  const {directory,file}=workFile();
  const db=createDB(file);seed(db);
  const c=candidate(db),before=allocationTotal(db,c.payment_id);
  const script=path.join(__dirname,'fixtures','decision_worker.js');
  const workers=[
    new Worker(script,{workerData:{filename:file,candidateId:c.id,amount:100,org:DEMO_ORG,actor:'finance-reviewer-a'}}),
    new Worker(script,{workerData:{filename:file,candidateId:c.id,amount:100,org:DEMO_ORG,actor:'finance-reviewer-b'}})
  ];
  try {
    await Promise.all(workers.map(w=>new Promise<void>((resolve,reject)=>{
      const ready=(message:any)=>{if(message?.ready){w.off('message',ready);resolve();}};
      w.on('message',ready);w.once('error',reject);
    })));
    const outcomes=workers.map(w=>new Promise<any>((resolve,reject)=>{
      w.once('message',resolve);w.once('error',reject);
    }));
    for(const w of workers)w.postMessage('go');
    const result=await Promise.all(outcomes);
    assert.equal(result.filter(x=>x.ok).length,1,JSON.stringify(result));
    assert.equal(result.filter(x=>!x.ok).length,1,JSON.stringify(result));
    assert.match(result.find(x=>!x.ok).error,/already decided|another reviewer/i);
    assert.equal(allocationTotal(db,c.payment_id),before+100);
    assert.equal(one(db,'SELECT COUNT(*) n FROM match_decisions WHERE candidate_id=?',c.id).n,1);
    assert.equal(rows(db,'SELECT * FROM allocations WHERE payment_id=? AND obligation_id=?',
      c.payment_id,c.obligation_id).length,1);
    assert.equal(one(db,'SELECT status FROM match_candidates WHERE id=?',c.id).status,'accepted');
    assert.equal(one(db,'SELECT COUNT(*) n FROM audit_events WHERE action=? AND object_id=?','match.accepted',c.id).n,1);
  }finally{
    await Promise.all(workers.map(w=>w.terminate()));
    db.close();fs.rmSync(directory,{recursive:true,force:true});
  }
});
