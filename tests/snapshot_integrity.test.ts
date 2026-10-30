import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDB,DEMO_ORG,one,run,sha} from '../src/db';
import {seed} from '../src/seed';
import {exportPack,state} from '../src/domain';

test('frozen reconciliation snapshots are verified before viewing or exporting',()=>{
  const db=createDB();seed(db);
  const latest=state(db).latest;
  const stored=one(db,'SELECT snapshot_json,snapshot_sha FROM run_snapshots WHERE run_id=?',latest.id);
  assert.equal(stored.snapshot_sha,sha(stored.snapshot_json));
  assert.equal(exportPack(db).manifest.run_snapshot_integrity,'SHA-256 verified at read');
  run(db,'UPDATE run_snapshots SET snapshot_json=? WHERE run_id=?','{"obligations":[]}',latest.id);
  assert.throws(()=>state(db,DEMO_ORG,latest.id),/snapshot failed SHA-256 integrity/);
  assert.throws(()=>exportPack(db,DEMO_ORG,latest.id),/snapshot failed SHA-256 integrity/);
  db.close();
});

test('legacy demo snapshots receive a one-time checksum baseline, never a silent rehash',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chh-snapshot-migration-'));
  const file=path.join(dir,'legacy.sqlite');
  const legacy=new DatabaseSync(file);
  legacy.exec(
    "CREATE TABLE organizations (id TEXT PRIMARY KEY,name TEXT NOT NULL,is_demo INTEGER NOT NULL);"+
    "INSERT INTO organizations VALUES ('org-cypress','Legacy Cypress',1);"+
    "CREATE TABLE reconciliation_runs (id TEXT PRIMARY KEY,org_id TEXT NOT NULL,rule_version TEXT NOT NULL,created_at TEXT NOT NULL,as_of TEXT NOT NULL,obligation_count INTEGER NOT NULL,payment_count INTEGER NOT NULL);"+
    "INSERT INTO reconciliation_runs VALUES ('legacy-run','org-cypress','CHH-1.0.0','2026-10-20T00:00:00Z','2026-10-20',0,0);"+
    "CREATE TABLE run_snapshots (run_id TEXT PRIMARY KEY,org_id TEXT NOT NULL,snapshot_json TEXT NOT NULL);"+
    "INSERT INTO run_snapshots VALUES ('legacy-run','org-cypress','{}');"
  );
  legacy.close();
  let db=createDB(file);
  const baseline=one(db,"SELECT snapshot_json,snapshot_sha FROM run_snapshots WHERE run_id='legacy-run'");
  assert.equal(baseline.snapshot_sha,sha(baseline.snapshot_json));
  run(db,"UPDATE run_snapshots SET snapshot_sha=NULL WHERE run_id='legacy-run'");
  db.close();
  db=createDB(file);
  assert.equal(one(db,"SELECT snapshot_sha FROM run_snapshots WHERE run_id='legacy-run'").snapshot_sha,null);
  assert.throws(()=>state(db,DEMO_ORG,'legacy-run'),/snapshot failed SHA-256 integrity/);
  db.close();
  fs.rmSync(dir,{recursive:true,force:true});
});
