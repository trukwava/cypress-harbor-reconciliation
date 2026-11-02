import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createDB,DEMO_ORG,one,run} from '../src/db';
import {seed} from '../src/seed';
import {authenticate,createUser,issueSession} from '../src/auth';
import {state} from '../src/domain';
import {createBackup,restoreBackup,verifyBackup,verifyDatabase} from '../src/backup';

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chh-recovery-'));
  return {dir,live:path.join(dir,'live.sqlite'),backup:path.join(dir,'backup.sqlite'),restored:path.join(dir,'restored.sqlite')};
}
test('live WAL-mode SQLite backup verifies, retains authentication and restores exact financial history',()=>{
  const x=fixture(),db=createDB(x.live);
  try{
    seed(db);
    const user=createUser(db,'backup-admin','Synthetic-Passphrase-456789','admin');
    issueSession(db,user);
    const before=state(db);
    const metrics=before.metrics;
    // A second connection performs a committed write which need not be
    // checkpointed to the main DB file before VACUUM INTO.
    const writer=createDB(x.live);
    try {run(writer,"INSERT INTO audit_events (id,org_id,action,object_type,object_id,actor,details_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
      'backup-probe',DEMO_ORG,'recovery.probe','organization',DEMO_ORG,'backup-admin','{}',new Date().toISOString());}
    finally{writer.close();}
    const manifest=createBackup(x.live,x.backup);
    assert.equal(manifest.format,'cypress-harbor-sqlite-v1');
    assert.ok(manifest.bytes>0);
    assert.equal(manifest.sha256.length,64);
    assert.equal(manifest.verified.frozen_runs,before.runs.length);
    assert.equal(manifest.verified.source_reports,before.reports.length);
    assert.equal(manifest.verified.users,1);
    assert.equal(verifyBackup(x.backup).sha256,manifest.sha256);
    assert.throws(()=>createBackup(x.live,x.backup),/Refusing to overwrite/);
    assert.throws(()=>restoreBackup(x.backup,x.live),/Refusing to overwrite/);
    const restoredCounts=restoreBackup(x.backup,x.restored);
    assert.deepEqual(restoredCounts,manifest.verified);
    assert.deepEqual(verifyDatabase(x.restored),manifest.verified);
    const restored=createDB(x.restored);
    try{
      const after=state(restored);
      assert.deepEqual(after.metrics,metrics);
      assert.equal(after.latest.id,before.latest.id);
      assert.equal(one(restored,"SELECT COUNT(*) n FROM audit_events WHERE id='backup-probe'").n,1);
      assert.ok(authenticate(restored,'backup-admin','Synthetic-Passphrase-456789'));
      const partial=after.obligations.find((o:any)=>o.source_key==='OBL-001');
      assert.equal(partial.remaining_minor,40000);
      assert.equal(one(restored,'SELECT COUNT(*) n FROM allocations').n,manifest.verified.allocations);
    }finally{restored.close();}
  }finally{db.close();fs.rmSync(x.dir,{recursive:true,force:true});}
});

test('backup fails closed on tampered source evidence and leaves no published artifacts',()=>{
  const x=fixture(),db=createDB(x.live);
  try{
    seed(db);
    const report=one(db,'SELECT id FROM source_reports LIMIT 1');
    run(db,'UPDATE source_reports SET raw_csv=? WHERE id=?','tampered',report.id);
    assert.throws(()=>createBackup(x.live,x.backup),/Source CSV digest mismatch/);
    assert.equal(fs.existsSync(x.backup),false);
    assert.equal(fs.existsSync(x.backup+'.manifest.json'),false);
  }finally{db.close();fs.rmSync(x.dir,{recursive:true,force:true});}
});

test('restore rejects mutated backup bytes, absent manifests and preexisting targets',()=>{
  const x=fixture(),db=createDB(x.live);
  try{
    seed(db);
    createBackup(x.live,x.backup);
    const copied=path.join(x.dir,'unmanifested.sqlite');
    fs.copyFileSync(x.backup,copied);
    assert.throws(()=>restoreBackup(copied,x.restored),/manifest is missing/);
    assert.equal(fs.existsSync(x.restored),false);
    const corrupt=new DatabaseSync(x.backup);
    try{corrupt.exec("UPDATE source_reports SET raw_csv='modified after backup' WHERE id=(SELECT id FROM source_reports LIMIT 1)");}
    finally{corrupt.close();}
    assert.throws(()=>verifyBackup(x.backup),/SHA-256 does not match/);
    assert.throws(()=>restoreBackup(x.backup,x.restored),/SHA-256 does not match/);
    assert.equal(fs.existsSync(x.restored),false);
  }finally{db.close();fs.rmSync(x.dir,{recursive:true,force:true});}
});

test('backup CLI reports usage failure without overwriting existing databases',()=>{
  const x=fixture(),db=createDB(x.live);
  try{
    seed(db);
    const binary=path.resolve(__dirname,'../src/backup.js');
    const command=(...args:string[])=>spawnSync(process.execPath,[binary,...args],{encoding:'utf8'});
    const created=command('backup',x.live,x.backup);
    assert.equal(created.status,0,created.stderr);
    const verify=command('verify',x.backup);
    assert.equal(verify.status,0,verify.stderr);
    assert.equal(JSON.parse(verify.stdout).manifest.filename,'backup.sqlite');
    const restored=command('restore',x.backup,x.restored);
    assert.equal(restored.status,0,restored.stderr);
    const refused=command('restore',x.backup,x.restored);
    assert.equal(refused.status,1);
    assert.match(refused.stderr,/Refusing to overwrite/);
    assert.equal(command('restore',x.backup).status,1);
  }finally{db.close();fs.rmSync(x.dir,{recursive:true,force:true});}
});
