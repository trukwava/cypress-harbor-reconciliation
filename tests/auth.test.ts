import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createDB,DEMO_ORG,run} from '../src/db';
import {seed,resetDemo} from '../src/seed';
import {bootstrapAdmin,createUser,authenticate,issueSession,principalFromToken,revokeSession} from '../src/auth';
import {state} from '../src/domain';

test('bootstrap creates a unique password once; sessions expire and revoke independently',()=>{
  const db=createDB();seed(db);
  const first=bootstrapAdmin(db);assert.ok(first);assert.equal(first.username,'demo-admin');
  assert.ok(first.password.length>=24);assert.equal(bootstrapAdmin(db),null);
  assert.equal(authenticate(db,'demo-admin','wrong-password'),null);
  const actor=authenticate(db,'demo-admin',first.password);assert.ok(actor);assert.equal(actor.role,'admin');
  const a=issueSession(db,actor),b=issueSession(db,actor);
  assert.equal(principalFromToken(db,a)?.org_id,DEMO_ORG);
  assert.equal(principalFromToken(db,'0'.repeat(64)),null);
  revokeSession(db,a);assert.equal(principalFromToken(db,a),null);
  assert.equal(principalFromToken(db,b)?.username,'demo-admin');
  run(db,'UPDATE local_sessions SET expires_at=? WHERE token_hash=?','2020-01-01T00:00:00.000Z',crypto.createHash('sha256').update(b).digest('hex'));
  assert.equal(principalFromToken(db,b),null);
  db.close();
});

test('reset preserves named local accounts while rebuilding synthetic finance evidence',()=>{
  const db=createDB();seed(db);
  createUser(db,'trial-admin','Trial-Admin-Password-123','admin');
  const actor=authenticate(db,'trial-admin','Trial-Admin-Password-123');assert.ok(actor);
  const token=issueSession(db,actor);
  resetDemo(db);
  assert.equal(state(db).obligations.length,40);
  assert.equal(principalFromToken(db,token)?.username,'trial-admin');
  assert.throws(()=>createUser(db,'trial-admin','Another-Password-123','admin'),/already exists/);
  db.close();
});
