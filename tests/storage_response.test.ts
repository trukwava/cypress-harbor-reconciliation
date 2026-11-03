import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDB,DEMO_ORG,one} from '../src/db';
import {createUser} from '../src/auth';
import {createApp} from '../src/server';
import {seed} from '../src/seed';
import {addAllocation,state} from '../src/domain';

function scratch(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'chh-storage-response-'));
  return {directory,file:path.join(directory,'storage.sqlite')};
}
function quotaPayload(){
  const header='obligation_key,property_ref,invoice_ref,amount,reported_due,due_date,currency';
  const records=Array.from({length:550},(_,i)=>{
    const key='HTTP-QUOTA-'+String(i).padStart(4,'0');
    return key+',CHH-P01,INV-'+key+',31.00,31.00,2026-11-03,USD';
  });
  return {
    kind:'obligation',filename:'capacity.csv',
    csv:[header,...records].join('\n')+'\n',
    source_system:'CapacityFixture',as_of:'2026-11-03',currency:'USD'
  };
}

test('authenticated HTTP import returns 507 on SQLite storage exhaustion without committing partial data',async()=>{
  const w=scratch(),db=createDB(w.file);
  seed(db);
  createUser(db,'capacity-admin','Synthetic-Capacity-Password-12345','admin');
  const app=createApp(db);
  await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));
  const addr=app.address();
  if(!addr||typeof addr==='string')throw new Error('No local port');
  const base='http://127.0.0.1:'+addr.port;
  try {
    const loggedIn=await fetch(base+'/api/auth/login',{
      method:'POST',headers:{'Content-Type':'application/json',Origin:base},
      body:JSON.stringify({username:'capacity-admin',password:'Synthetic-Capacity-Password-12345'})
    });
    assert.equal(loggedIn.status,200);
    const cookie=(loggedIn.headers.get('set-cookie')||'').split(';')[0];
    assert.ok(cookie.startsWith('chh_session='));
    const original=one(db,'SELECT COUNT(*) n FROM obligations WHERE org_id=?',DEMO_ORG).n;
    const payload=quotaPayload();
    async function sendImport(){
      return fetch(base+'/api/import/commit',{
        method:'POST',
        headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},
        body:JSON.stringify(payload)
      });
    }
    const pages=Number((db.prepare('PRAGMA page_count').get() as any).page_count);
    const actual=Number((db.prepare('PRAGMA max_page_count='+(pages+3)).get() as any).max_page_count);
    assert.equal(actual,pages+3);
    try {
      const rejected=await sendImport();
      assert.equal(rejected.status,507);
      assert.match((await rejected.json() as any).error,/storage capacity/i);
    } finally {
      db.exec('PRAGMA max_page_count=1073741823');
    }
    assert.equal(one(db,'SELECT COUNT(*) n FROM obligations WHERE org_id=?',DEMO_ORG).n,original);
    assert.equal(one(db,"SELECT COUNT(*) n FROM source_reports WHERE filename='capacity.csv'").n,0);
    const accepted=await sendImport();
    assert.equal(accepted.status,200);
    assert.equal((await accepted.json() as any).imported,550);
    const repeat=await sendImport();
    assert.equal(repeat.status,200);
    assert.equal((await repeat.json() as any).already_imported,true);
    assert.equal(one(db,'SELECT COUNT(*) n FROM obligations WHERE org_id=?',DEMO_ORG).n,original+550);
  } finally {
    await new Promise<void>(resolve=>app.close(()=>resolve()));
    db.close();
    fs.rmSync(w.directory,{recursive:true,force:true});
  }
});

test('standalone allocation cannot commit if its audit event fails',()=>{
  const w=scratch(),db=createDB(w.file);
  try {
    seed(db);
    const candidate=state(db).candidates.find((c:any)=>
      c.status==='proposed'&&c.available_payment_minor>=100&&c.outstanding_obligation_minor>=100&&
      one(db,'SELECT COUNT(*) n FROM allocations WHERE payment_id=? AND obligation_id=?',c.payment_id,c.obligation_id).n===0);
    assert.ok(candidate,'seed contains an unmatched candidate');
    const before=one(db,'SELECT COUNT(*) n FROM allocations WHERE org_id=?',DEMO_ORG).n;
    db.exec("CREATE TEMP TRIGGER deny_allocation_audit BEFORE INSERT ON audit_events WHEN NEW.action='allocation.created' BEGIN SELECT RAISE(ABORT,'Injected audit storage failure'); END;");
    assert.throws(()=>addAllocation(db,DEMO_ORG,candidate.payment_id,candidate.obligation_id,100,'Capacity Reviewer'),/Injected audit storage failure/);
    assert.equal(one(db,'SELECT COUNT(*) n FROM allocations WHERE org_id=?',DEMO_ORG).n,before);
    assert.equal(one(db,'SELECT COUNT(*) n FROM allocations WHERE payment_id=? AND obligation_id=?',candidate.payment_id,candidate.obligation_id).n,0);
    db.exec('DROP TRIGGER deny_allocation_audit');
    const allocation=addAllocation(db,DEMO_ORG,candidate.payment_id,candidate.obligation_id,100,'Capacity Reviewer');
    assert.equal(one(db,'SELECT COUNT(*) n FROM allocations WHERE org_id=?',DEMO_ORG).n,before+1);
    assert.equal(one(db,"SELECT COUNT(*) n FROM audit_events WHERE action='allocation.created' AND object_id=?",allocation).n,1);
  }finally{db.close();fs.rmSync(w.directory,{recursive:true,force:true});}
});
