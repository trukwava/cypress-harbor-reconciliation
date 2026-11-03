import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createDB,DEMO_ORG,one} from '../src/db';
import {seed} from '../src/seed';
import {commitImport,decideMatch,reviewException,state} from '../src/domain';
import {createBackup,restoreBackup,verifyBackup} from '../src/backup';

function workspace(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chh-storage-'));
  return {dir,file:path.join(dir,'fault.sqlite'),backup:path.join(dir,'backup.sqlite'),restored:path.join(dir,'recovered.sqlite')};
}
function count(db:any,sql:string,...args:any[]):number{
  return Number(one(db,sql,...args).n);
}
function killWorker(filename:string,...args:string[]){
  const script=path.join(__dirname,'fixtures',filename);
  const child=spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:10000});
  assert.equal(child.error,undefined,String(child.error||''));
  assert.equal(child.signal,'SIGKILL','Expected SIGKILL; exit='+child.status+' stderr='+child.stderr);
}

test('SQLite page-quota exhaustion rolls back a multi-row import and allows a clean retry',()=>{
  const w=workspace(),db=createDB(w.file);
  try {
    seed(db);
    const original={
      reports:count(db,'SELECT COUNT(*) n FROM source_reports WHERE org_id=?',DEMO_ORG),
      rows:count(db,'SELECT COUNT(*) n FROM source_rows WHERE org_id=?',DEMO_ORG),
      obligations:count(db,'SELECT COUNT(*) n FROM obligations WHERE org_id=?',DEMO_ORG),
      audits:count(db,"SELECT COUNT(*) n FROM audit_events WHERE org_id=? AND action='import.completed'",DEMO_ORG)
    };
    const header='obligation_key,property_ref,invoice_ref,amount,reported_due,due_date,currency';
    const entries=Array.from({length:550},(_,i)=>{
      const key='QUOTA-'+String(i).padStart(4,'0');
      return key+',CHH-P01,INVOICE-'+key+',11.00,11.00,2026-11-03,USD';
    });
    const input={
      kind:'obligation' as const, filename:'quota-pressure.csv',
      csv:[header,...entries].join('\n')+'\n',
      as_of:'2026-11-03',source_system:'QuotaProbe',currency:'USD'
    };
    const currentPages=Number((db.prepare('PRAGMA page_count').get() as any).page_count);
    const limit=currentPages+3;
    const effective=Number((db.prepare('PRAGMA max_page_count='+limit).get() as any).max_page_count);
    assert.equal(effective,limit);
    try {
      assert.throws(()=>commitImport(db,input),/database or disk is full|SQLITE_FULL|database is full/i);
    } finally {
      db.exec('PRAGMA max_page_count=1073741823');
    }
    assert.equal(count(db,'SELECT COUNT(*) n FROM source_reports WHERE org_id=?',DEMO_ORG),original.reports);
    assert.equal(count(db,'SELECT COUNT(*) n FROM source_rows WHERE org_id=?',DEMO_ORG),original.rows);
    assert.equal(count(db,'SELECT COUNT(*) n FROM obligations WHERE org_id=?',DEMO_ORG),original.obligations);
    assert.equal(count(db,"SELECT COUNT(*) n FROM audit_events WHERE org_id=? AND action='import.completed'",DEMO_ORG),original.audits);
    assert.equal(count(db,"SELECT COUNT(*) n FROM source_reports WHERE filename='quota-pressure.csv'"),0);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
    const imported=commitImport(db,input);
    assert.equal(imported.imported,550);
    assert.equal(commitImport(db,input).already_imported,true);
    assert.equal(count(db,'SELECT COUNT(*) n FROM obligations WHERE org_id=?',DEMO_ORG),original.obligations+550);
  }finally{db.close();fs.rmSync(w.dir,{recursive:true,force:true});}
});

test('repeated SIGKILL during reviewer audit never commits a partial note or resolution',()=>{
  const w=workspace(),db=createDB(w.file);
  try{
    seed(db);
    const target=state(db).exceptions.find((e:any)=>e.status==='open');
    assert.ok(target);
    const original=count(db,'SELECT COUNT(*) n FROM resolutions WHERE exception_id=?',target.id);
    for(let i=0;i<3;i++){
      const marker=path.join(w.dir,'review-crash-'+i);
      killWorker('crash_review_worker.js',w.file,target.id,marker);
      assert.equal(fs.readFileSync(marker,'utf8'),'crashed during review audit insert');
      const record=one(db,'SELECT status,owner,note,review_revision FROM exceptions WHERE id=?',target.id);
      assert.equal(record.status,'open');
      assert.equal(record.note,'');
      assert.equal(record.review_revision,0);
      assert.equal(count(db,'SELECT COUNT(*) n FROM resolutions WHERE exception_id=?',target.id),original);
      assert.equal(count(db,"SELECT COUNT(*) n FROM audit_events WHERE object_id=? AND action='exception.reviewed'",target.id),0);
    }
    reviewException(db,target.id,'reviewed','Recovery reviewer','Validated after repeated crashes',DEMO_ORG,'reviewer-a',0);
    assert.equal(count(db,'SELECT COUNT(*) n FROM resolutions WHERE exception_id=?',target.id),original+1);
    assert.equal(one(db,'SELECT review_revision FROM exceptions WHERE id=?',target.id).review_revision,1);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
  }finally{db.close();fs.rmSync(w.dir,{recursive:true,force:true});}
});

test('repeated SIGKILL between allocation and decision never double-spends a payment',()=>{
  const w=workspace(),db=createDB(w.file);
  try{
    seed(db);
    const candidate=state(db).candidates.find((c:any)=>c.status==='proposed'&&c.available_payment_minor>=100&&c.outstanding_obligation_minor>=100);
    assert.ok(candidate);
    const originalAlloc=count(db,'SELECT COALESCE(SUM(amount_minor),0) n FROM allocations WHERE payment_id=?',candidate.payment_id);
    for(let i=0;i<3;i++){
      const marker=path.join(w.dir,'match-crash-'+i);
      killWorker('crash_match_worker.js',w.file,candidate.id,marker);
      assert.equal(fs.readFileSync(marker,'utf8'),'crashed before match decision');
      assert.equal(one(db,'SELECT status FROM match_candidates WHERE id=?',candidate.id).status,'proposed');
      assert.equal(count(db,'SELECT COALESCE(SUM(amount_minor),0) n FROM allocations WHERE payment_id=?',candidate.payment_id),originalAlloc);
      assert.equal(count(db,'SELECT COUNT(*) n FROM match_decisions WHERE candidate_id=?',candidate.id),0);
      assert.equal(count(db,"SELECT COUNT(*) n FROM audit_events WHERE action='match.accepted' AND object_id=?",candidate.id),0);
    }
    const committed=decideMatch(db,candidate.id,'accepted','Succeeded after crashes',100,DEMO_ORG,'reviewer-b');
    assert.equal(committed.allocation_minor,100);
    assert.equal(count(db,'SELECT COALESCE(SUM(amount_minor),0) n FROM allocations WHERE payment_id=?',candidate.payment_id),originalAlloc+100);
    assert.equal(count(db,'SELECT COUNT(*) n FROM match_decisions WHERE candidate_id=?',candidate.id),1);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
  }finally{db.close();fs.rmSync(w.dir,{recursive:true,force:true});}
});

test('bad backup manifest metadata and altered frozen evidence prevent restore even when file SHA is recomputed',()=>{
  const w=workspace(),db=createDB(w.file);
  try{
    seed(db);
    const manifest=createBackup(w.file,w.backup);
    const manifestPath=w.backup+'.manifest.json';
    const mismatched={...manifest,verified:{...manifest.verified,allocations:manifest.verified.allocations+1}};
    fs.writeFileSync(manifestPath,JSON.stringify(mismatched));
    assert.throws(()=>restoreBackup(w.backup,w.restored),/Backup counts do not match manifest/);
    assert.equal(fs.existsSync(w.restored),false);
    fs.writeFileSync(manifestPath,JSON.stringify(manifest));
    const backedUp=new DatabaseSync(w.backup);
    try {
      backedUp.exec("UPDATE run_snapshots SET snapshot_json='{}' WHERE run_id=(SELECT run_id FROM run_snapshots LIMIT 1)");
    }finally {backedUp.close();}
    const rewritten={
      ...manifest,
      bytes:fs.statSync(w.backup).size,
      sha256:crypto.createHash('sha256').update(fs.readFileSync(w.backup)).digest('hex')
    };
    fs.writeFileSync(manifestPath,JSON.stringify(rewritten));
    assert.throws(()=>verifyBackup(w.backup),/Frozen run digest mismatch/);
    assert.throws(()=>restoreBackup(w.backup,w.restored),/Frozen run digest mismatch/);
    assert.equal(fs.existsSync(w.restored),false);
  }finally{db.close();fs.rmSync(w.dir,{recursive:true,force:true});}
});
