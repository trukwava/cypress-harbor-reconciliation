/**
 * A consistent SQLite/WAL backup, verifier and non-overwriting restore tool.
 * Run: node dist/src/backup.js backup <live.sqlite> <snapshot.sqlite>
 *      node dist/src/backup.js verify <snapshot.sqlite>
 *      node dist/src/backup.js restore <snapshot.sqlite> <new.sqlite>
 */
import {DatabaseSync} from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type Counts={organizations:number,source_reports:number,frozen_runs:number,allocations:number,users:number};
export type BackupManifest={format:'cypress-harbor-sqlite-v1',created_at:string,filename:string,bytes:number,sha256:string,verified:Counts};

function existingFile(file:string):string {
  const resolved=path.resolve(file);
  if(!fs.existsSync(resolved)||!fs.statSync(resolved).isFile())throw new Error('Database file does not exist: '+resolved);
  return resolved;
}
function digestFile(file:string):string {
  const digest=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.allocUnsafe(1024*1024);
  try {while(true){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;digest.update(buffer.subarray(0,n));}}
  finally{fs.closeSync(fd);}
  return digest.digest('hex');
}
function count(db:DatabaseSync,sql:string):number {
  const row=db.prepare(sql).get() as Record<string,number>;
  return Number(Object.values(row)[0]);
}
/** Read-only validation: does not create accounts, initialize data or run migrations. */
export function verifyDatabase(file:string):Counts {
  const db=new DatabaseSync(existingFile(file),{readOnly:true});
  try{
    const check=db.prepare('PRAGMA integrity_check').all() as Record<string,string>[];
    if(check.length!==1||Object.values(check[0])[0]!=='ok')throw new Error('SQLite integrity_check failed');
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('SQLite foreign_key_check failed');
    const required=['organizations','source_reports','run_snapshots','allocations','payments','obligations','local_users','reconciliation_runs'];
    const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
    for(const name of required)if(!tables.has(name))throw new Error('Missing expected SQLite table: '+name);
    const reports=db.prepare('SELECT id,raw_csv,raw_sha FROM source_reports').all() as {id:string,raw_csv:string,raw_sha:string}[];
    for(const row of reports){
      if(crypto.createHash('sha256').update(row.raw_csv.replace(/^\uFEFF/,'')).digest('hex')!==row.raw_sha)
        throw new Error('Source CSV digest mismatch: '+row.id);
    }
    const snaps=db.prepare('SELECT run_id,snapshot_json,snapshot_sha FROM run_snapshots').all() as {run_id:string,snapshot_json:string,snapshot_sha:string|null}[];
    for(const row of snaps){
      if(!row.snapshot_sha||crypto.createHash('sha256').update(row.snapshot_json).digest('hex')!==row.snapshot_sha)
        throw new Error('Frozen run digest mismatch: '+row.run_id);
      let parsed:any;
      try {parsed=JSON.parse(row.snapshot_json);}catch{throw new Error('Malformed frozen snapshot: '+row.run_id);}
      if(!Array.isArray(parsed.obligations)||!Array.isArray(parsed.payments)||!Array.isArray(parsed.allocations)||!Array.isArray(parsed.properties))
        throw new Error('Missing frozen evidence arrays: '+row.run_id);
    }
    const mismatches=count(db,'SELECT COUNT(*) FROM allocations a JOIN payments p ON p.id=a.payment_id JOIN obligations o ON o.id=a.obligation_id WHERE p.org_id<>a.org_id OR o.org_id<>a.org_id OR p.property_id<>o.property_id OR p.currency<>o.currency');
    const excessPayments=count(db,'SELECT COUNT(*) FROM payments p WHERE (SELECT COALESCE(SUM(a.amount_minor),0) FROM allocations a WHERE a.payment_id=p.id)>p.amount_minor');
    const excessObligations=count(db,'SELECT COUNT(*) FROM obligations o WHERE (SELECT COALESCE(SUM(a.amount_minor),0) FROM allocations a WHERE a.obligation_id=o.id)>o.amount_minor');
    if(mismatches||excessPayments||excessObligations)throw new Error('Inconsistent or excessive allocations');
    return {organizations:count(db,'SELECT COUNT(*) FROM organizations'),source_reports:reports.length,frozen_runs:snaps.length,allocations:count(db,'SELECT COUNT(*) FROM allocations'),users:count(db,'SELECT COUNT(*) FROM local_users')};
  }finally{db.close();}
}
export function verifyBackup(file:string):{sha256:string,verified:Counts,manifest:BackupManifest}{
  const source=existingFile(file),sidecar=source+'.manifest.json';
  if(!fs.existsSync(sidecar))throw new Error('Backup manifest is missing');
  const manifest=JSON.parse(fs.readFileSync(sidecar,'utf8')) as BackupManifest;
  if(manifest.format!=='cypress-harbor-sqlite-v1'||manifest.filename!==path.basename(source))
    throw new Error('Unrecognized backup manifest');
  if(!Number.isSafeInteger(manifest.bytes)||fs.statSync(source).size!==manifest.bytes)
    throw new Error('Backup size does not match manifest');
  const sha256=digestFile(source);
  if(sha256!==manifest.sha256)throw new Error('Backup SHA-256 does not match manifest');
  const verified=verifyDatabase(source);
  if(JSON.stringify(verified)!==JSON.stringify(manifest.verified))
    throw new Error('Backup counts do not match manifest');
  return {sha256,verified,manifest};
}
function newPath(source:string,target:string):string {
  const dst=path.resolve(target);
  if(path.resolve(source)===dst)throw new Error('Source and destination must differ');
  if(fs.existsSync(dst))throw new Error('Refusing to overwrite existing file: '+dst);
  fs.mkdirSync(path.dirname(dst),{recursive:true,mode:0o700});
  return dst;
}
function seal(file:string):void {
  fs.chmodSync(file,0o600);
  const fd=fs.openSync(file,'r');
  try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
/** VACUUM INTO produces a consistent live backup, unlike copying a WAL-mode .sqlite alone. */
export function createBackup(source:string,destination:string):BackupManifest {
  const src=existingFile(source),dst=newPath(src,destination),sidecar=dst+'.manifest.json';
  if(fs.existsSync(sidecar))throw new Error('Backup manifest already exists');
  const stage=dst+'.pending-'+crypto.randomUUID();
  try{
    const live=new DatabaseSync(src,{readOnly:true});
    try {live.exec("VACUUM INTO '"+stage.replace(/'/g,"''")+"'");}
    finally{live.close();}
    seal(stage);
    const verified=verifyDatabase(stage);
    const manifest:BackupManifest={format:'cypress-harbor-sqlite-v1',created_at:new Date().toISOString(),filename:path.basename(dst),bytes:fs.statSync(stage).size,sha256:digestFile(stage),verified};
    // Link, rather than rename over an existing name, for atomic no-overwrite publishing.
    fs.linkSync(stage,dst);
    try {
      fs.writeFileSync(sidecar,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
      seal(sidecar);
    }catch(error){fs.unlinkSync(dst);throw error;}
    return manifest;
  }finally{if(fs.existsSync(stage))fs.unlinkSync(stage);}
}
/** Requires matching checksum sidecar; creates a NEW database path only. */
export function restoreBackup(source:string,destination:string):Counts {
  const src=existingFile(source),dst=newPath(src,destination);
  const verified=verifyBackup(src);
  const stage=dst+'.pending-'+crypto.randomUUID();
  try{
    fs.copyFileSync(src,stage,fs.constants.COPYFILE_EXCL);
    seal(stage);
    if(digestFile(stage)!==verified.sha256)throw new Error('Restored bytes differ from source');
    verifyDatabase(stage);
    fs.linkSync(stage,dst); // Refuse overwriting an active database.
    return verified.verified;
  }finally{if(fs.existsSync(stage))fs.unlinkSync(stage);}
}
function main(){
  const [operation,src,dst,...extra]=process.argv.slice(2);
  if(extra.length||!src||!['backup','verify','restore'].includes(operation)||
      (operation==='verify'?Boolean(dst):!dst))
    throw new Error('Usage: node dist/src/backup.js backup <live.sqlite> <backup.sqlite> | verify <backup.sqlite> | restore <backup.sqlite> <new.sqlite>');
  if(operation==='backup'){
    const manifest=createBackup(src,dst);
    console.log(JSON.stringify({operation,path:path.resolve(dst),manifest},null,2));
  }else if(operation==='verify'){
    console.log(JSON.stringify({operation,path:path.resolve(src),...verifyBackup(src)},null,2));
  }else{
    const verified=restoreBackup(src,dst);
    console.log(JSON.stringify({operation,path:path.resolve(dst),verified},null,2));
  }
}
if(require.main===module){
  try{main();}catch(error){console.error('Backup operation refused:',(error as Error).message);process.exitCode=1;}
}
