import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDB,DEMO_ORG,one} from '../src/db';
import {seed} from '../src/seed';
import {DomainError,reviewException,state} from '../src/domain';

test('stale reviewer submissions cannot overwrite newer exception notes',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chh-review-'));
  const filename=path.join(dir,'review.sqlite');
  const first=createDB(filename);seed(first);
  const second=createDB(filename);
  try{
    const target=state(first).exceptions[0];
    assert.equal(target.review_revision,0);
    const initial=reviewException(first,target.id,'reviewed','Reviewer A','Evidence checked',DEMO_ORG,'analyst-a',0);
    assert.equal(initial.review_revision,1);
    assert.throws(
      ()=>reviewException(second,target.id,'info_requested','Reviewer B','Stale conflicting note',DEMO_ORG,'analyst-b',0),
      (err:any)=>err instanceof DomainError&&err.status===409&&/changed during review/.test(err.message)
    );
    const saved=one(first,'SELECT status,owner,note,review_revision FROM exceptions WHERE id=?',target.id);
    assert.equal(saved.status,'reviewed');
    assert.equal(saved.owner,'Reviewer A');
    assert.equal(saved.note,'Evidence checked');
    assert.equal(saved.review_revision,1);
    assert.equal(one(first,'SELECT COUNT(*) n FROM resolutions WHERE exception_id=?',target.id).n,1);
    assert.equal(one(first,'SELECT COUNT(*) n FROM audit_events WHERE object_id=? AND action=?',target.id,'exception.reviewed').n,1);
    assert.throws(
      ()=>reviewException(second,target.id,'open','No token','Unsafe',DEMO_ORG,'analyst-b'),
      (err:any)=>err instanceof DomainError&&err.status===428
    );
    const subsequent=reviewException(second,target.id,'info_requested','Reviewer B','Fresh follow-up',DEMO_ORG,'analyst-b',1);
    assert.equal(subsequent.review_revision,2);
    assert.equal(one(first,'SELECT COUNT(*) n FROM resolutions WHERE exception_id=?',target.id).n,2);
    assert.equal(one(first,'SELECT note FROM exceptions WHERE id=?',target.id).note,'Fresh follow-up');
  }finally{second.close();first.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('old SQLite databases gain review revisions without losing existing decisions',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chh-review-migration-'));
  const filename=path.join(dir,'legacy.sqlite');
  const db=createDB(filename);seed(db);
  const selected=state(db).exceptions[0];
  const originalCount=one(db,'SELECT COUNT(*) n FROM exceptions').n;
  db.exec('ALTER TABLE exceptions DROP COLUMN review_revision');
  db.close();
  const migrated=createDB(filename);
  try {
    assert.equal(one(migrated,'SELECT COUNT(*) n FROM exceptions').n,originalCount);
    assert.equal(one(migrated,'SELECT review_revision FROM exceptions WHERE id=?',selected.id).review_revision,0);
    const result=reviewException(migrated,selected.id,'reviewed','Migrated Analyst','Verified',DEMO_ORG,'analyst',0);
    assert.equal(result.review_revision,1);
  }finally{migrated.close();fs.rmSync(dir,{recursive:true,force:true});}
});
