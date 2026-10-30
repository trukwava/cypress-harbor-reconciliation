import crypto from 'node:crypto';
import {DB,DEMO_ORG,id,now,one,rows,run} from './db';
import {DomainError} from './domain';

export type Role='viewer'|'reviewer'|'admin';
export type Principal={id:string,username:string,role:Role,org_id:string};
const roles:Role[]=['viewer','reviewer','admin'];
const sessionMs=8*60*60*1000;
function hashSecret(secret:string,salt:string):string{return crypto.scryptSync(secret,salt,64,{maxmem:64*1024*1024}).toString('hex');}
function digest(token:string):string{return crypto.createHash('sha256').update(token).digest('hex');}
export function createUser(db:DB,username:string,password:string,role:Role,org_id=DEMO_ORG):Principal{
  const name=String(username).trim().toLowerCase();
  if(!/^[a-z][a-z0-9._-]{2,39}$/.test(name))throw new DomainError('Username must be 3–40 letters, digits, dots, hyphens or underscores');
  if(typeof password!=='string'||password.length<12||password.length>256)throw new DomainError('Password must be 12–256 characters');
  if(!roles.includes(role))throw new DomainError('Invalid role');
  if(!one(db,'SELECT id FROM organizations WHERE id=?',org_id))throw new DomainError('Organization not found',404);
  const salt=crypto.randomBytes(16).toString('hex'),hashed=hashSecret(password,salt),userId=id('user');
  try{run(db,'INSERT INTO local_users (id,org_id,username,role,salt,password_hash,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)',userId,org_id,name,role,salt,hashed,now());}
  catch(e){if(String(e).includes('UNIQUE'))throw new DomainError('Username already exists',409);throw e;}
  return {id:userId,org_id,username:name,role};
}
export function bootstrapAdmin(db:DB):{username:string,password:string}|null{
  if(one(db,'SELECT id FROM local_users WHERE org_id=? AND role=?',DEMO_ORG,'admin'))return null;
  const password=crypto.randomBytes(24).toString('base64url');
  createUser(db,'demo-admin',password,'admin',DEMO_ORG);
  return {username:'demo-admin',password};
}
export function authenticate(db:DB,username:string,password:string):Principal|null{
  const name=String(username||'').trim().toLowerCase();
  if(typeof password!=='string'||password.length>256||name.length>80)return null;
  const user=one(db,'SELECT * FROM local_users WHERE username=?',name);
  const actual=hashSecret(password,user?.salt||'00000000000000000000000000000000');
  const expected=user?.password_hash||'0'.repeat(128);
  const ok=crypto.timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));
  if(!ok||!user||!user.enabled)return null;
  return {id:user.id,org_id:user.org_id,username:user.username,role:user.role};
}
export function issueSession(db:DB,p:Principal):string{
  const token=crypto.randomBytes(32).toString('hex');
  run(db,'INSERT INTO local_sessions (token_hash,user_id,org_id,created_at,expires_at) VALUES (?,?,?,?,?)',digest(token),p.id,p.org_id,now(),new Date(Date.now()+sessionMs).toISOString());
  return token;
}
export function principalFromToken(db:DB,token:string):Principal|null{
  if(!/^[a-f0-9]{64}$/.test(token))return null;
  const p=one(db,`SELECT u.id,u.username,u.role,u.org_id FROM local_sessions s JOIN local_users u ON u.id=s.user_id AND u.org_id=s.org_id JOIN organizations o ON o.id=u.org_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.enabled=1 AND o.is_demo=1`,digest(token),now());
  return p||null;
}
export function revokeSession(db:DB,token:string):void{
  if(/^[a-f0-9]{64}$/.test(token))run(db,'UPDATE local_sessions SET revoked_at=? WHERE token_hash=?',now(),digest(token));
}
export function listUsers(db:DB,org:string){return rows(db,'SELECT id,username,role,enabled,created_at FROM local_users WHERE org_id=? ORDER BY username',org);}
export function requireRole(p:Principal,...accepted:Role[]){if(!accepted.includes(p.role))throw new DomainError('Insufficient role permissions',403);}
