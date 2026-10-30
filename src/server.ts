import http,{IncomingMessage,ServerResponse} from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createDB,DB,DEMO_ORG,one,rows} from './db';
import {seed,resetDemo,writeFixtureFiles} from './seed';
import {addAlias,acceptConflict,commitImport,decideMatch,DomainError,exportPack,previewImport,reconcile,reviewException,state} from './domain';

const publicDir=path.resolve(__dirname,'../../public');
const fixturesDir=path.resolve(__dirname,'../../fixtures');
const types:Record<string,string>={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.csv':'text/csv; charset=utf-8'};
function send(res:ServerResponse,status:number,payload:any,mime='application/json; charset=utf-8',extra:Record<string,string>={}){
  const data=typeof payload==='string'?payload:JSON.stringify(payload);
  res.writeHead(status,{'Content-Type':mime,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",...extra});res.end(data);
}
async function body(req:IncomingMessage):Promise<any>{
  if(!(req.headers['content-type']||'').startsWith('application/json'))throw new DomainError('Content-Type must be application/json');
  let size=0,chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>2_500_000)throw new DomainError('Payload exceeds 2.5 MB',413);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new DomainError('Malformed JSON');}
}
export function createApp(db:DB){
  const token=crypto.randomBytes(32).toString('hex');
  return http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url||'/',`http://${req.headers.host||'127.0.0.1'}`);
      const m=req.method||'GET';
      const isApi=url.pathname.startsWith('/api/');
      const cookie=`chh_session=${token}`;
      if(isApi){
        const cookies=(req.headers.cookie||'').split(';').map(x=>x.trim());
        if(!cookies.includes(cookie))throw new DomainError('Session unavailable; reload the demo',401);
        // Loopback demo has a single server-issued session. Organization selection is never client-controlled.
        if(m!=='GET'){
          const origin=req.headers.origin;
          if(origin && new URL(origin).host!==req.headers.host)throw new DomainError('Cross-origin writes denied',403);
        }
        if(m==='GET'&&url.pathname==='/api/state')return send(res,200,state(db,DEMO_ORG,url.searchParams.get('run')||undefined));
        if(m==='GET'&&url.pathname==='/api/export'){
          const p=exportPack(db,DEMO_ORG,url.searchParams.get('run')||undefined);
          if(!p.manifest.selected_run)throw new DomainError('No reconciliation run to export',409);
          return send(res,200,JSON.stringify(p,null,2),'application/json; charset=utf-8',{'Content-Disposition':`attachment; filename="reconciliation-${p.manifest.selected_run}.json"`});
        }
        if(m==='GET'&&url.pathname.startsWith('/api/evidence/')){
          const eid=decodeURIComponent(url.pathname.split('/').at(-1)||'');
          const exc=one(db,'SELECT * FROM exceptions WHERE id=? AND org_id=?',eid,DEMO_ORG);
          if(!exc)throw new DomainError('Exception not found',404);
          const frozen=one(db,'SELECT snapshot_json FROM run_snapshots WHERE run_id=? AND org_id=?',exc.run_id,DEMO_ORG);
          const snapshot=frozen?JSON.parse(frozen.snapshot_json):null;
          const targetObl=snapshot?.obligations.find((o:any)=>o.id===exc.obligation_id);
          const targetPay=snapshot?.payments.find((p:any)=>p.id===exc.payment_id);
          const ownRows=snapshot?(snapshot.allocations.filter((a:any)=>a.obligation_id===exc.obligation_id).map((a:any)=>{
            const p=snapshot.payments.find((p:any)=>p.id===a.payment_id);
            return {...a,source_row_id:p?.source_row_id};
          })):exc.obligation_id?rows(db,`SELECT a.amount_minor,p.id,p.source_row_id FROM allocations a JOIN payments p ON p.id=a.payment_id WHERE a.obligation_id=? AND a.org_id=?`,exc.obligation_id,DEMO_ORG):[];
          const sourceIds=[exc.source_row_id,targetObl?.source_row_id|| (exc.obligation_id?one(db,'SELECT source_row_id FROM obligations WHERE id=? AND org_id=?',exc.obligation_id,DEMO_ORG)?.source_row_id:null),targetPay?.source_row_id||(exc.payment_id?one(db,'SELECT source_row_id FROM payments WHERE id=? AND org_id=?',exc.payment_id,DEMO_ORG)?.source_row_id:null),...ownRows.map((a:any)=>a.source_row_id)].filter(Boolean);
          const evidence=[...new Set(sourceIds)].map(sourceId=>one(db,'SELECT r.*,s.source_system,s.as_of,s.filename FROM source_rows r JOIN source_reports s ON r.report_id=s.id WHERE r.id=? AND r.org_id=?',sourceId,DEMO_ORG)).filter(Boolean).map(r=>({...r,raw:JSON.parse(r.raw_json),normalized:JSON.parse(r.normalized_json)}));
          const appliedRule=one(db,'SELECT rule_version FROM reconciliation_runs WHERE id=? AND org_id=?',exc.run_id,DEMO_ORG);
          return send(res,200,{exception:exc,evidence,allocations:ownRows,rule_version:appliedRule?.rule_version});
        }
        if(m==='GET'&&url.pathname.startsWith('/api/reports/')&&url.pathname.endsWith('/raw')){
          const reportId=url.pathname.split('/')[3];const report=one(db,'SELECT filename,raw_csv FROM source_reports WHERE id=? AND org_id=?',reportId,DEMO_ORG);
          if(!report)throw new DomainError('Report not found',404);
          return send(res,200,report.raw_csv,'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="source-report.csv"'});
        }
        if(m==='POST'){
          const payload=await body(req);
          if(url.pathname==='/api/import/preview')return send(res,200,previewImport(db,payload));
          if(url.pathname==='/api/import/commit')return send(res,200,commitImport(db,payload));
          if(url.pathname==='/api/reconcile')return send(res,200,reconcile(db));
          if(url.pathname==='/api/demo/reset')return send(res,200,resetDemo(db));
          if(url.pathname==='/api/aliases')return send(res,200,addAlias(db,String(payload.property_id||''),String(payload.alias||'')));
          if(/^\/api\/matches\/[^/]+\/decide$/.test(url.pathname)){
            if(!['accepted','rejected'].includes(payload.decision))throw new DomainError('Decision must be accepted or rejected');
            return send(res,200,decideMatch(db,url.pathname.split('/')[3],payload.decision,String(payload.note||''),payload.amount_minor));
          }
          if(/^\/api\/exceptions\/[^/]+\/review$/.test(url.pathname)){
            if(!['open','reviewed','info_requested'].includes(payload.status))throw new DomainError('Invalid review state');
            return send(res,200,reviewException(db,url.pathname.split('/')[3],payload.status,String(payload.owner||'Unassigned'),String(payload.note||'')));
          }
          if(/^\/api\/conflicts\/[^/]+\/decide$/.test(url.pathname)){
            if(!['accepted','rejected'].includes(payload.decision))throw new DomainError('Invalid conflict decision');
            return send(res,200,acceptConflict(db,url.pathname.split('/')[3],payload.decision));
          }
        }
        throw new DomainError('API route not found',404);
      }
      if(m!=='GET')throw new DomainError('Method not allowed',405);
      const route=url.pathname==='/'?'/index.html':url.pathname;
      const full=path.resolve(publicDir,'.'+route);
      if(!full.startsWith(publicDir+path.sep))throw new DomainError('File not found',404);
      if(fs.existsSync(full)&&fs.statSync(full).isFile()){
        const cookieHeader=url.pathname==='/'?{'Set-Cookie':`${cookie}; HttpOnly; SameSite=Strict; Path=/`}:{};
        return send(res,200,fs.readFileSync(full).toString('utf8'),types[path.extname(full)]||'text/plain; charset=utf-8',cookieHeader);
      }
      if(url.pathname.startsWith('/fixtures/')&&/^[a-z_]+\.csv$/.test(url.pathname.slice(10))){
        const fixture=path.join(fixturesDir,url.pathname.slice(10));if(fs.existsSync(fixture))return send(res,200,fs.readFileSync(fixture).toString('utf8'),'text/csv; charset=utf-8');
      }
      throw new DomainError('Page not found',404);
    } catch(e){const err=e as Error;const code=e instanceof DomainError?e.status:500;
      // Never log imported source contents or request payloads.
      if(code===500)console.error('Request failed:',err.message);
      send(res,code,{error:code===500?'Internal error':err.message});
    }
  });
}
if(require.main===module){
  const db=createDB(process.env.DB_PATH||'./data/reconciliation.sqlite');seed(db);
  if(!fs.existsSync(path.join(fixturesDir,'obligations_october.csv')))writeFixtureFiles(fixturesDir);
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||4173);
  if(!['127.0.0.1','::1','localhost'].includes(host))throw new Error('Demo mode may bind only to loopback');
  createApp(db).listen(port,host,()=>console.log(`Cypress Harbor Reconciliation demo: http://${host}:${port}`));
}