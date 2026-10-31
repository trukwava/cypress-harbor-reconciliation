import http,{IncomingMessage,ServerResponse} from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createDB,DB,DEMO_ORG,one,rows,sha,DatabaseBusyError} from './db';
import {seed,resetDemo,writeFixtureFiles} from './seed';
import {addAlias,acceptConflict,commitImport,decideMatch,DomainError,exportPack,previewImport,reconcile,reviewException,state,audit} from './domain';
import {authenticate,bootstrapAdmin,createUser,issueSession,listUsers,principalFromToken,requireRole,revokeSession} from './auth';
import {exceptionQueueCSV} from './csv_export';

const publicDir=path.resolve(__dirname,'../../public');
const fixturesDir=path.resolve(__dirname,'../../fixtures');
const types:Record<string,string>={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.csv':'text/csv; charset=utf-8'};
function send(res:ServerResponse,status:number,payload:any,mime='application/json; charset=utf-8',extra:Record<string,string>={}){
  const data=typeof payload==='string'?payload:JSON.stringify(payload);
  res.writeHead(status,{'Content-Type':mime,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",...extra});res.end(data);
}
// Defense against DNS rebinding: a malicious domain must never be able to
// obtain the local demo cookie, even if DNS later resolves that domain to loopback.
function isLocalHostHeader(value:string|undefined):boolean {
  if(!value || /[\s\/@\\]/.test(value))return false;
  try {
    const u=new URL(`http://${value}/`);
    return ['127.0.0.1','localhost','[::1]'].includes(u.hostname)
      && !u.username && !u.password && u.pathname==='/' && !u.search && !u.hash;
  } catch {return false;}
}
function assertLoopbackRequest(req:IncomingMessage):void {
  const remote=req.socket.remoteAddress;
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote||'') || !isLocalHostHeader(req.headers.host))
    throw new DomainError('This demo accepts requests from localhost only',403);
}
async function body(req:IncomingMessage):Promise<any>{
  if(!(req.headers['content-type']||'').startsWith('application/json'))throw new DomainError('Content-Type must be application/json');
  let size=0,chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>2_500_000)throw new DomainError('Payload exceeds 2.5 MB',413);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new DomainError('Malformed JSON');}
}
export function createApp(db:DB){
  const failedLogins=new Map<string,{count:number,until:number}>();
  return http.createServer(async(req,res)=>{
    try {
      assertLoopbackRequest(req);
      const url=new URL(req.url||'/',`http://${req.headers.host}`);
      const m=req.method||'GET';
      const isApi=url.pathname.startsWith('/api/');
      // Validate the Origin for every state-changing request, including login
      // and user provisioning. The former bypassed the checks in the API router.
      if(isApi && m!=='GET' && req.headers.origin){
        let sameOrigin=false;
        try {sameOrigin=new URL(req.headers.origin).origin===new URL(`http://${req.headers.host}`).origin;}catch{}
        if(!sameOrigin)throw new DomainError('Cross-origin writes denied',403);
      }
      if(isApi){
        const rawCookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('chh_session='));
        const token=rawCookie?.slice('chh_session='.length)||'';
        if(m==='POST'&&url.pathname==='/api/auth/login'){
          const payload=await body(req),username=String(payload?.username||'').trim().toLowerCase();
          const key=(req.socket.remoteAddress||'local')+':'+username;
          const attempt=failedLogins.get(key);
          if(attempt&&attempt.count>=6&&attempt.until>Date.now())throw new DomainError('Too many attempts; try again later',429);
          const identity=authenticate(db,username,String(payload?.password||''));
          if(!identity){
            failedLogins.set(key,{count:(attempt&&attempt.until>Date.now()?attempt.count:0)+1,until:Date.now()+5*60_000});
            throw new DomainError('Invalid username or password',401);
          }
          failedLogins.delete(key);if(token)revokeSession(db,token);
          const issued=issueSession(db,identity);
          return send(res,200,{user:identity},'application/json; charset=utf-8',{'Set-Cookie':'chh_session='+issued+'; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800'});
        }
        const actor=principalFromToken(db,token);
        if(!actor)throw new DomainError('Sign in to access this workspace',401);
        const org=actor.org_id;
        if(m==='GET'&&url.pathname==='/api/auth/me')return send(res,200,{user:actor});
        if(m==='POST'&&url.pathname==='/api/auth/logout'){
          revokeSession(db,token);
          return send(res,200,{logged_out:true},'application/json; charset=utf-8',{'Set-Cookie':'chh_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0'});
        }
        if(m==='GET'&&url.pathname==='/api/users'){requireRole(actor,'admin');return send(res,200,{users:listUsers(db,org)});}
        if(m==='POST'&&url.pathname==='/api/users'){
          requireRole(actor,'admin');const payload=await body(req);
          const user=createUser(db,String(payload?.username||''),String(payload?.password||''),payload?.role,org);
          audit(db,org,'user.created','user',user.id,{role:user.role},actor.username);
          return send(res,201,{user});
        }
        if(m==='GET'&&url.pathname==='/api/state')return send(res,200,state(db,org,url.searchParams.get('run')||undefined));
        if(m==='GET'&&url.pathname==='/api/export/exceptions.csv'){
          const output=exceptionQueueCSV(db,org,url.searchParams.get('run')||undefined);
          return send(res,200,output.csv,'text/csv; charset=utf-8',{'Content-Disposition':`attachment; filename="${output.filename}"`});
        }
        if(m==='GET'&&url.pathname==='/api/export'){
          const p=exportPack(db,org,url.searchParams.get('run')||undefined);
          if(!p.manifest.selected_run)throw new DomainError('No reconciliation run to export',409);
          return send(res,200,JSON.stringify(p,null,2),'application/json; charset=utf-8',{'Content-Disposition':`attachment; filename="reconciliation-${p.manifest.selected_run}.json"`});
        }
        if(m==='GET'&&url.pathname.startsWith('/api/evidence/')){
          const eid=decodeURIComponent(url.pathname.split('/').at(-1)||'');
          const exc=one(db,'SELECT * FROM exceptions WHERE id=? AND org_id=?',eid,org);
          if(!exc)throw new DomainError('Exception not found',404);
          const frozen=one(db,'SELECT snapshot_json,snapshot_sha FROM run_snapshots WHERE run_id=? AND org_id=?',exc.run_id,org);
          if(frozen && (!frozen.snapshot_sha||sha(frozen.snapshot_json)!==frozen.snapshot_sha))throw new DomainError('Frozen reconciliation snapshot failed SHA-256 integrity check',409);
          const snapshot=frozen?JSON.parse(frozen.snapshot_json):null;
          const targetObl=snapshot?.obligations.find((o:any)=>o.id===exc.obligation_id);
          const targetPay=snapshot?.payments.find((p:any)=>p.id===exc.payment_id);
          const ownRows=snapshot?(snapshot.allocations.filter((a:any)=>a.obligation_id===exc.obligation_id).map((a:any)=>{
            const p=snapshot.payments.find((p:any)=>p.id===a.payment_id);
            return {...a,source_row_id:p?.source_row_id};
          })):exc.obligation_id?rows(db,`SELECT a.amount_minor,p.id,p.source_row_id FROM allocations a JOIN payments p ON p.id=a.payment_id WHERE a.obligation_id=? AND a.org_id=?`,exc.obligation_id,org):[];
          const sourceIds=[exc.source_row_id,targetObl?.source_row_id|| (exc.obligation_id?one(db,'SELECT source_row_id FROM obligations WHERE id=? AND org_id=?',exc.obligation_id,org)?.source_row_id:null),targetPay?.source_row_id||(exc.payment_id?one(db,'SELECT source_row_id FROM payments WHERE id=? AND org_id=?',exc.payment_id,org)?.source_row_id:null),...ownRows.map((a:any)=>a.source_row_id)].filter(Boolean);
          const evidence=[...new Set(sourceIds)].map(sourceId=>one(db,'SELECT r.*,s.source_system,s.as_of,s.filename FROM source_rows r JOIN source_reports s ON r.report_id=s.id WHERE r.id=? AND r.org_id=?',sourceId,org)).filter(Boolean).map(r=>({...r,raw:JSON.parse(r.raw_json),normalized:JSON.parse(r.normalized_json)}));
          const appliedRule=one(db,'SELECT rule_version FROM reconciliation_runs WHERE id=? AND org_id=?',exc.run_id,org);
          return send(res,200,{exception:exc,evidence,allocations:ownRows,rule_version:appliedRule?.rule_version});
        }
        if(m==='GET'&&url.pathname.startsWith('/api/reports/')&&url.pathname.endsWith('/raw')){
          const reportId=url.pathname.split('/')[3];const report=one(db,'SELECT filename,raw_csv,raw_sha FROM source_reports WHERE id=? AND org_id=?',reportId,org);
          if(!report)throw new DomainError('Report not found',404);
          if(sha(report.raw_csv.replace(/^\uFEFF/,''))!==report.raw_sha)throw new DomainError('Stored source CSV failed SHA-256 integrity check',409);
          return send(res,200,report.raw_csv,'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="source-report.csv"'});
        }
        if(m==='POST'){
          const payload=await body(req);
          if(url.pathname==='/api/import/preview'){requireRole(actor,'reviewer','admin');return send(res,200,previewImport(db,payload,org));}
          if(url.pathname==='/api/import/commit'){requireRole(actor,'admin');const result=commitImport(db,payload,org,actor.username);return send(res,200,result);}
          if(url.pathname==='/api/reconcile'){requireRole(actor,'admin');const result=reconcile(db,org,actor.username);return send(res,200,result);}
          if(url.pathname==='/api/demo/reset'){requireRole(actor,'admin');if(org!==DEMO_ORG)throw new DomainError('Reset restricted to Cypress Harbor demo',403);const result=resetDemo(db);audit(db,org,'actor.reset','organization',org,{},actor.username);return send(res,200,result);}
          if(url.pathname==='/api/aliases'){requireRole(actor,'admin');const result=addAlias(db,String(payload.property_id||''),String(payload.alias||''),org,actor.username);return send(res,200,result);}
          if(/^\/api\/matches\/[^/]+\/decide$/.test(url.pathname)){
            requireRole(actor,'reviewer','admin');if(!['accepted','rejected'].includes(payload.decision))throw new DomainError('Decision must be accepted or rejected');
            const result=decideMatch(db,url.pathname.split('/')[3],payload.decision,String(payload.note||''),payload.amount_minor,org,actor.username);return send(res,200,result);
          }
          if(/^\/api\/exceptions\/[^/]+\/review$/.test(url.pathname)){
            requireRole(actor,'reviewer','admin');if(!['open','reviewed','info_requested'].includes(payload.status))throw new DomainError('Invalid review state');
            const result=reviewException(db,url.pathname.split('/')[3],payload.status,String(payload.owner||'Unassigned'),String(payload.note||''),org,actor.username,payload.expected_revision);return send(res,200,result);
          }
          if(/^\/api\/conflicts\/[^/]+\/decide$/.test(url.pathname)){
            requireRole(actor,'admin');if(!['accepted','rejected'].includes(payload.decision))throw new DomainError('Invalid conflict decision');
            const result=acceptConflict(db,url.pathname.split('/')[3],payload.decision,org,actor.username);return send(res,200,result);
          }
        }
        throw new DomainError('API route not found',404);
      }
      if(m!=='GET')throw new DomainError('Method not allowed',405);
      const route=url.pathname==='/'?'/index.html':url.pathname;
      const full=path.resolve(publicDir,'.'+route);
      if(!full.startsWith(publicDir+path.sep))throw new DomainError('File not found',404);
      if(fs.existsSync(full)&&fs.statSync(full).isFile()){
        return send(res,200,fs.readFileSync(full).toString('utf8'),types[path.extname(full)]||'text/plain; charset=utf-8');
      }
      if(url.pathname.startsWith('/fixtures/')&&/^[a-z_]+\.csv$/.test(url.pathname.slice(10))){
        const fixture=path.join(fixturesDir,url.pathname.slice(10));if(fs.existsSync(fixture))return send(res,200,fs.readFileSync(fixture).toString('utf8'),'text/csv; charset=utf-8');
      }
      throw new DomainError('Page not found',404);
    } catch(e){const err=e as Error;const code=e instanceof DomainError?e.status:e instanceof DatabaseBusyError?409:500;
      // Never log imported source contents or request payloads.
      if(code===500)console.error('Request failed:',err.message);
      send(res,code,{error:code===500?'Internal error':err.message});
    }
  });
}
if(require.main===module){
  const db=createDB(process.env.DB_PATH||'./data/reconciliation.sqlite');seed(db);
  const provisioned=bootstrapAdmin(db);
  if(!fs.existsSync(path.join(fixturesDir,'obligations_october.csv')))writeFixtureFiles(fixturesDir);
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||4173);
  if(!['127.0.0.1','::1','localhost'].includes(host))throw new Error('Demo mode may bind only to loopback');
  createApp(db).listen(port,host,()=>{
    console.log('Cypress Harbor Reconciliation demo: http://'+host+':'+port);
    if(provisioned)console.log('LOCAL DEMO FIRST-USE LOGIN — username: '+provisioned.username+' password: '+provisioned.password+' (shown only at initial creation; store locally, never commit)');
  });
}