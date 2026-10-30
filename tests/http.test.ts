import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDB,DEMO_ORG,OTHER_ORG,run} from '../src/db';
import {seed} from '../src/seed';
import {createApp} from '../src/server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

test('HTTP workflow: session, preview errors, report isolation, review, export, reload persistence',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'chh-http-'));const dbfile=path.join(tmp,'data.sqlite');
 const db=createDB(dbfile);seed(db);
 run(db,'INSERT INTO source_reports VALUES (?,?,?,?,?,?,?,?,?,?)','OTHER-R1',OTHER_ORG,'obligation','PrivateSystem','private.csv','2026-10-20','USD','sha-other','2026-10-20T00:00:00Z','secret,private');
 const server=createApp(db);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw Error('No bound address');const port=address.port;const base=`http://127.0.0.1:${port}`;
 try{
  async function localRequestWithHost(hostHeader:string):Promise<number>{
    return new Promise((resolve,reject)=>{
      const request=http.get({hostname:'127.0.0.1',port,path:'/',headers:{Host:hostHeader}},response=>{
        response.resume();response.on('end',()=>resolve(response.statusCode||0));
      });request.on('error',reject);
    });
  }
  assert.equal(await localRequestWithHost('rebinding.attacker.invalid'),403,'DNS-rebinding hostname must not mint a demo session');
  assert.equal(await localRequestWithHost('rebinding.attacker.invalid:4173'),403);
  const initial=await fetch(base+'/api/state');assert.equal(initial.status,401);
  const home=await fetch(base+'/');assert.equal(home.status,200);assert.match(await home.text(),/Cypress Harbor/);
  const cookie=(home.headers.get('set-cookie')||'').split(';')[0];assert.ok(cookie.startsWith('chh_session='));
  async function req(url:string,payload?:any){const r=await fetch(base+url,{headers:{Cookie:cookie,...(payload===undefined?{}:{'Content-Type':'application/json'})},...(payload===undefined?{}:{method:'POST',body:JSON.stringify(payload)})});let data:any=await r.text();try{data=JSON.parse(data)}catch{}return {status:r.status,body:data};}
  const first=await req('/api/state');assert.equal(first.status,200);assert.equal(first.body.obligations.length,40);
  assert.equal((await req('/api/reports/OTHER-R1/raw')).status,404);
  assert.equal((await req('/api/reports/'+encodeURIComponent(first.body.reports[0].id)+'/raw')).status,200);
  assert.equal((await req('/api/aliases',{property_id:'OTHER-P1',alias:'Steal'})).status,404);
  const malformed=await req('/api/import/preview',{kind:'payment',filename:'bad.csv',source_system:'VendorPayments',as_of:'2026-10-20',currency:'USD',csv:'payment_key,property_ref,invoice_ref,amount,transaction_date,posted_date,currency,type\nBAD,P1,12,"unterminated'});
  assert.equal(malformed.status,400);
  const exc=first.body.exceptions.find((e:any)=>e.kind==='paid_elsewhere_still_due');assert.ok(exc);
  const evidence=await req('/api/evidence/'+exc.id);assert.equal(evidence.status,200);assert.ok(evidence.body.evidence.length>=2);
  const reviewed=await req('/api/exceptions/'+exc.id+'/review',{status:'reviewed',owner:'M. Finance',note:'Source needs a corrected due notice'});assert.equal(reviewed.status,200);
  const rr=await req('/api/reconcile',{});assert.equal(rr.status,200);
  const latest=await req('/api/state');const successor=latest.body.exceptions.find((e:any)=>e.issue_key===exc.issue_key);
  assert.equal(successor.status,'reviewed');assert.equal(successor.owner,'M. Finance');
  const pack=await req('/api/export');assert.equal(pack.status,200);
  assert.equal(pack.body.manifest.mode,'synthetic-demo');assert.equal(pack.body.metrics.original_obligations_minor,latest.body.metrics.original_obligations_minor);
  assert.equal(pack.body.manifest.selected_run,latest.body.latest.id);
  assert.ok(pack.body.source_rows.length>40);
  const previous=await req('/api/state?run='+first.body.latest.id);assert.equal(previous.status,200);assert.equal(previous.body.selected_historical,true);
  const badReview=await req('/api/exceptions/'+exc.id+'/review',{status:'open',owner:'x',note:'history write'});assert.equal(badReview.status,409);
  const badOrigin=await fetch(base+'/api/reconcile',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:'http://evil.invalid'},body:'{}'});assert.equal(badOrigin.status,403);
  const nullOrigin=await fetch(base+'/api/reconcile',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:'null'},body:'{}'});assert.equal(nullOrigin.status,403);
  const mismatchedProtocol=await fetch(base+'/api/reconcile',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:base.replace('http:','https:')},body:'{}'});assert.equal(mismatchedProtocol.status,403);
  const matchingOrigin=await fetch(base+'/api/state',{headers:{Cookie:cookie,Origin:base}});assert.equal(matchingOrigin.status,200);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();}
 const reopened=createDB(dbfile);const stored=await Promise.resolve(reopened.prepare('SELECT COUNT(*) n FROM resolutions WHERE org_id=?').get(DEMO_ORG));assert.ok((stored as any).n>0);reopened.close();
 fs.rmSync(tmp,{recursive:true,force:true});
});