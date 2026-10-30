import {DB,DEMO_ORG,rows,one,run,now,id,sha,transaction} from './db';
import {parseCSV,required} from './csv';
export const RULE_VERSION='CHH-1.0.0';
export type Kind='obligation'|'payment';
export type ReportInput={kind:Kind,filename:string,csv:string,as_of:string,source_system:string,currency:string};
export class DomainError extends Error { constructor(message:string, public status=400){super(message);} }
const dateOK=(s:string)=> /^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().startsWith(s);
export function minor(v:string):number {if(!/^\d{1,10}(\.\d{1,2})?$/.test(v.trim()))throw new DomainError('Money must be nonnegative with at most 2 decimal places');const [a,b='']=v.trim().split('.');const n=Number(a)*100+Number((b+'00').slice(0,2));if(!Number.isSafeInteger(n))throw new DomainError('Money out of range');return n;}
export function dollars(n:number):string {return (n/100).toFixed(2);}
function validateInput(x:ReportInput){
  if(!x||!['obligation','payment'].includes(x.kind))throw new DomainError('Choose a report kind');
  if(!dateOK(x.as_of))throw new DomainError('Report as-of date must be YYYY-MM-DD');
  if(!/^[A-Z]{3}$/.test(x.currency))throw new DomainError('Currency must be a three-letter code');
  if(x.currency!=='USD')throw new DomainError('Initial demo supports USD only; cross-currency aggregation is prohibited');
  if(!/^[A-Za-z0-9_-]{2,40}$/.test(x.source_system))throw new DomainError('Source system must be 2–40 letters/numbers/underscores');
  if(typeof x.csv!=='string'||Buffer.byteLength(x.csv,'utf8')>2_000_000)throw new DomainError('CSV must be at most 2 MB');
  if(typeof x.filename!=='string'||x.filename.length>120)throw new DomainError('Invalid filename');
}
function propResolve(db:DB,org:string,ref:string):{id:string|null,reason:string|null}{
  const val=ref.trim().toLowerCase();
  if(!val)return {id:null,reason:'Missing property reference'};
  const matches=rows(db,`SELECT DISTINCT id FROM (
    SELECT p.id FROM properties p WHERE p.org_id=? AND (lower(p.id)=? OR lower(p.address)=? OR lower(coalesce(p.bbl,''))=?)
    UNION ALL SELECT p.id FROM properties p JOIN external_accounts a ON a.property_id=p.id AND a.org_id=p.org_id WHERE p.org_id=? AND lower(a.account_ref)=?
    UNION ALL SELECT p.id FROM properties p JOIN aliases a ON a.property_id=p.id AND a.org_id=p.org_id WHERE p.org_id=? AND a.reviewed=1 AND lower(a.alias)=?
  )`,org,val,val,val,org,val,org,val);
  if(matches.length===1)return {id:matches[0].id,reason:null};
  return {id:null,reason:matches.length>1?'Ambiguous property identity':'Unmapped property identity'};
}
function normalize(db:DB,org:string,kind:Kind,r:Record<string,string>,currency:string){
  const errs:string[]=[];const key=(kind==='obligation'?r.obligation_key:r.payment_key)||'';
  const property=propResolve(db,org,r.property_ref||'');
  if(property.reason)errs.push(property.reason);
  if(!key.trim()||key.length>120)errs.push('Missing or oversized stable source key');
  if(!r.invoice_ref?.trim())errs.push('Missing invoice reference');
  if(r.currency!==currency)errs.push('Row currency differs from report currency');
  let amount_minor=0,reported_due_minor=0;
  try {amount_minor=minor(r.amount||'');if(amount_minor===0)errs.push('Amount must exceed zero');}catch(e){errs.push('Invalid amount');}
  if(kind==='obligation'){
    try {reported_due_minor=minor(r.reported_due||'');}catch(e){errs.push('Invalid reported_due');}
    if(reported_due_minor>amount_minor)errs.push('Reported due exceeds original obligation');
    if(!dateOK(r.due_date||''))errs.push('Invalid due_date');
  }else{
    if(!dateOK(r.transaction_date||''))errs.push('Invalid transaction_date');
    if(!dateOK(r.posted_date||''))errs.push('Invalid posted_date');
    if(!['payment','credit'].includes(r.type||''))errs.push('Type must be payment or credit');
  }
  const normalized={source_key:key.trim(),property_id:property.id,property_ref:(r.property_ref||'').trim(),invoice_ref:(r.invoice_ref||'').trim(),amount_minor,reported_due_minor,currency:r.currency||'',due_date:r.due_date||'',transaction_date:r.transaction_date||'',posted_date:r.posted_date||'',payment_type:r.type||''};
  return {normalized,error:errs.length?errs.join('; '):null};
}
export function previewImport(db:DB,x:ReportInput,org=DEMO_ORG){
  validateInput(x);const parsed=parseCSV(x.csv);
  if(parsed.error)throw new DomainError(parsed.error);
  const missing=required[x.kind].filter(k=>!parsed.headers.includes(k));if(missing.length)throw new DomainError('Missing CSV columns: '+missing.join(', '));
  return {count:parsed.records.length,columns:parsed.headers,rows:parsed.records.map((raw,i)=>({line:i+2,raw,...normalize(db,org,x.kind,raw,x.currency)})),report:{kind:x.kind,as_of:x.as_of,source_system:x.source_system,currency:x.currency,filename:x.filename}};
}
export function audit(db:DB,org:string,action:string,objType:string,objId:string,details:object={},actor='Demo Reviewer'){
  run(db,'INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?)',id('event'),org,actor,action,objType,objId,JSON.stringify(details),now());
}
export function commitImport(db:DB,x:ReportInput,org=DEMO_ORG){
  const view=previewImport(db,x,org);
  if(!view.count)throw new DomainError('Report has no data rows');
  return transaction(db,()=>{
    const raw_sha=sha(x.csv.replace(/^\uFEFF/,''));
    const existing=one(db,'SELECT id FROM source_reports WHERE org_id=? AND kind=? AND source_system=? AND raw_sha=? AND as_of=?',org,x.kind,x.source_system,raw_sha,x.as_of);
    if(existing)return {report_id:existing.id,already_imported:true,imported:0,duplicates:view.count,errors:0,conflicts:0};
    const report_id=id('report');
    run(db,'INSERT INTO source_reports VALUES (?,?,?,?,?,?,?,?,?,?)',report_id,org,x.kind,x.source_system,x.filename,x.as_of,x.currency,raw_sha,now(),x.csv);
    let imported=0,duplicates=0,errors=0,conflicts=0;
    for(const row of view.rows){
      const r=row.normalized,key=r.source_key,raw_sha=sha(JSON.stringify(r));const rowId=id('srow');
      run(db,'INSERT INTO source_rows VALUES (?,?,?,?,?,?,?,?,?,?)',rowId,org,report_id,row.line,key,x.kind,JSON.stringify(row.raw),JSON.stringify(r),raw_sha,row.error);
      if(row.error){errors++;continue;}
      const table=x.kind==='obligation'?'obligations':'payments';
      const existing=one(db,`SELECT * FROM ${table} WHERE org_id=? AND source_system=? AND source_key=?`,org,x.source_system,key);
      if(existing){if(existing.content_sha===raw_sha){duplicates++;const priorReport=one(db,'SELECT as_of FROM source_reports WHERE id=?',existing.report_id);if(x.as_of>=priorReport.as_of)run(db,`UPDATE ${table} SET report_id=?,source_row_id=? WHERE id=? AND org_id=?`,report_id,rowId,existing.id,org);}else{
        run(db,'INSERT INTO import_conflicts(id,org_id,kind,source_row_id,current_record_id,source_key,created_at) VALUES (?,?,?,?,?,?,?)',id('conflict'),org,x.kind,rowId,existing.id,key,now());conflicts++;
      }continue;}
      if(x.kind==='obligation')run(db,'INSERT INTO obligations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',id('obl'),org,r.property_id,x.source_system,key,r.invoice_ref,r.amount_minor,r.reported_due_minor,r.currency,r.due_date,report_id,rowId,raw_sha);
      else run(db,'INSERT INTO payments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id('pay'),org,r.property_id,x.source_system,key,r.invoice_ref,r.amount_minor,r.currency,r.transaction_date,r.posted_date,r.payment_type,report_id,rowId,raw_sha);
      imported++;
    }
    run(db,'INSERT INTO import_batches VALUES (?,?,?,?,?,?,?,?,?)',id('batch'),org,report_id,now(),view.count,imported,duplicates,errors,conflicts);
    audit(db,org,'import.completed','source_report',report_id,{kind:x.kind,imported,duplicates,errors,conflicts});
    return {report_id,already_imported:false,imported,duplicates,errors,conflicts};
  });
}
export function acceptConflict(db:DB,conflictId:string,decision:'accepted'|'rejected',org=DEMO_ORG,actor='Demo Reviewer'){
  return transaction(db,()=>{
    const c=one(db,'SELECT c.*,r.report_id,r.normalized_json,r.row_fingerprint FROM import_conflicts c JOIN source_rows r ON r.id=c.source_row_id WHERE c.id=? AND c.org_id=?',conflictId,org);
    if(!c)throw new DomainError('Conflict not found',404);if(c.status!=='pending')throw new DomainError('Conflict already decided',409);
    if(decision==='accepted'){
      const n=JSON.parse(c.normalized_json);const table=c.kind==='obligation'?'obligations':'payments';
      const target=one(db,`SELECT * FROM ${table} WHERE id=? AND org_id=?`,c.current_record_id,org);
      if(!target)throw new DomainError('Source record not found',404);
      const total=one(db,`SELECT COALESCE(SUM(amount_minor),0) n FROM allocations WHERE ${c.kind==='obligation'?'obligation_id':'payment_id'}=?`,target.id).n;
      if(n.amount_minor<total)throw new DomainError('Correction would leave allocations exceeding the new amount',409);
      if(n.property_id!==target.property_id&&total>0)throw new DomainError('Cannot change property of an allocated record',409);
      if(c.kind==='obligation')run(db,'UPDATE obligations SET property_id=?,invoice_ref=?,amount_minor=?,reported_due_minor=?,currency=?,due_date=?,report_id=?,source_row_id=?,content_sha=? WHERE id=? AND org_id=?',n.property_id,n.invoice_ref,n.amount_minor,n.reported_due_minor,n.currency,n.due_date,c.report_id,c.source_row_id,c.row_fingerprint,target.id,org);
      else run(db,'UPDATE payments SET property_id=?,invoice_ref=?,amount_minor=?,currency=?,transaction_date=?,posted_date=?,payment_type=?,report_id=?,source_row_id=?,content_sha=? WHERE id=? AND org_id=?',n.property_id,n.invoice_ref,n.amount_minor,n.currency,n.transaction_date,n.posted_date,n.payment_type,c.report_id,c.source_row_id,c.row_fingerprint,target.id,org);
    }
    run(db,'UPDATE import_conflicts SET status=?,decided_at=?,reviewer=? WHERE id=? AND org_id=?',decision,now(),actor,conflictId,org);
    audit(db,org,'conflict.'+decision,'import_conflict',conflictId,{},actor);
    return {id:conflictId,status:decision};
  });
}
function allocations(db:DB,org:string){return rows(db,'SELECT obligation_id,payment_id,amount_minor FROM allocations WHERE org_id=?',org);}
function payments(db:DB,org:string){return rows(db,'SELECT p.*,s.as_of report_as_of FROM payments p JOIN source_reports s ON p.report_id=s.id WHERE p.org_id=? ORDER BY p.source_key',org);}
function obligations(db:DB,org:string){return rows(db,'SELECT o.*,s.as_of report_as_of FROM obligations o JOIN source_reports s ON o.report_id=s.id WHERE o.org_id=? ORDER BY o.source_key',org);}
export function addAllocation(db:DB,org:string,paymentId:string,obligationId:string,amount:number,actor='Demo Reviewer'){
  if(!Number.isSafeInteger(amount)||amount<=0)throw new DomainError('Allocation must be a positive amount in cents');
  const allocId=id('alloc');
  try {run(db,'INSERT INTO allocations VALUES (?,?,?,?,?,?,?)',allocId,org,paymentId,obligationId,amount,now(),actor);}
  catch(e){throw new DomainError(`Allocation rejected: ${(e as Error).message}`,409);}
  audit(db,org,'allocation.created','allocation',allocId,{payment_id:paymentId,obligation_id:obligationId,amount_minor:amount},actor);
  return allocId;
}
function issueKey(type:string,oid?:string,pid?:string,source?:string){return [type,oid||'',pid||'',source||''].join(':');}
export function reconcile(db:DB,org=DEMO_ORG){
  return transaction(db,()=>{
    const obls=obligations(db,org),pays=payments(db,org),allocs=allocations(db,org);
    const runId=id('recon'),asof=new Date().toISOString().slice(0,10);
    run(db,'INSERT INTO reconciliation_runs VALUES (?,?,?,?,?,?,?)',runId,org,RULE_VERSION,now(),asof,obls.length,pays.length);
    const allocByObl=new Map<string,number>(),allocByPay=new Map<string,number>();
    for(const a of allocs){allocByObl.set(a.obligation_id,(allocByObl.get(a.obligation_id)||0)+a.amount_minor);allocByPay.set(a.payment_id,(allocByPay.get(a.payment_id)||0)+a.amount_minor);}
    const registry=rows(db,`SELECT p.*,e.name entity_name,(SELECT group_concat(alias, ', ') FROM aliases a WHERE a.property_id=p.id) aliases,(SELECT group_concat(source_system||': '||account_ref,'; ') FROM external_accounts a WHERE a.property_id=p.id) accounts FROM properties p JOIN entities e ON p.entity_id=e.id WHERE p.org_id=? ORDER BY p.id`,org);
    run(db,'INSERT INTO run_snapshots VALUES (?,?,?)',runId,org,JSON.stringify({obligations:obls,payments:pays,allocations:allocs,properties:registry}));
    const candidates:any[]=[];
    for(const p of pays){for(const o of obls){
      if(p.property_id!==o.property_id||p.currency!==o.currency||p.invoice_ref!==o.invoice_ref)continue;
      if((allocByPay.get(p.id)||0)>=p.amount_minor || (allocByObl.get(o.id)||0)>=o.amount_minor)continue;
      const explicit=p.invoice_ref===o.source_key || p.source_key===o.source_key;
      const basis=explicit?'Exact property and obligation source key':(p.amount_minor===o.amount_minor?'Exact property + invoice reference + amount':'Exact property + invoice reference; differing amounts');
      const evidence_hash=sha(JSON.stringify([p.content_sha,o.content_sha,basis]));
      const prior=one(db,`SELECT c.status FROM match_candidates c JOIN reconciliation_runs r ON c.run_id=r.id
        WHERE c.org_id=? AND c.obligation_id=? AND c.payment_id=? AND c.evidence_hash=? AND c.status IN ('accepted','rejected')
        AND c.run_id<>? ORDER BY r.created_at DESC LIMIT 1`,org,o.id,p.id,evidence_hash,runId);
      const candidate={id:id('candidate'),org_id:org,run_id:runId,obligation_id:o.id,payment_id:p.id,basis,strength:explicit?'explicit':'suggested',evidence_hash,status:prior?.status||'proposed'};
      run(db,'INSERT INTO match_candidates(id,org_id,run_id,obligation_id,payment_id,basis,strength,evidence_hash,status) VALUES (?,?,?,?,?,?,?,?,?)',candidate.id,org,runId,o.id,p.id,candidate.basis,candidate.strength,candidate.evidence_hash,candidate.status);candidates.push(candidate);
    }}
    let issueCount=0;
    const emit=(kind:string,reason:string,amount:number,obligationId?:string,paymentId?:string,sourceRowId?:string,evidenceParts:any[]=[] )=>{
      const key=issueKey(kind,obligationId,paymentId,sourceRowId);
      const basis=sha(JSON.stringify([kind,reason,amount,...evidenceParts]));
      const previous=one(db,'SELECT * FROM exceptions WHERE org_id=? AND issue_key=? ORDER BY created_at DESC LIMIT 1',org,key);
      const unchanged=previous&&previous.basis_hash===basis;
      const status=unchanged?previous.status:'open', owner=previous?.owner||'Unassigned',note=unchanged?previous.note:'';
      const exceptionId=id('exc');
      run(db,'INSERT INTO exceptions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',exceptionId,org,runId,key,kind,obligationId||null,paymentId||null,sourceRowId||null,amount,reason,basis,status,owner,note,previous&&!unchanged&&previous.status==='reviewed'?previous.id:null,now());issueCount++;
    };
    for(const o of obls){
      const allocated=allocByObl.get(o.id)||0, remaining=o.amount_minor-allocated;
      if(allocated>0 && o.reported_due_minor>remaining)emit('paid_elsewhere_still_due',`Source reports ${dollars(o.reported_due_minor)} due; evidenced allocations ${dollars(allocated)}; explanatory remainder ${dollars(remaining)}. Not a confirmed debt.`,o.reported_due_minor-remaining,o.id,undefined,undefined,[o.content_sha,allocated,o.reported_due_minor]);
      else if(allocated>0 && remaining>0)emit('partial_payment',`Payment allocated ${dollars(allocated)} of ${dollars(o.amount_minor)}; explanatory remainder ${dollars(remaining)}.`,remaining,o.id,undefined,undefined,[o.content_sha,allocated]);
      if(Date.parse(asof+'T00:00:00Z')-Date.parse(o.report_as_of+'T00:00:00Z')>30*86400000)emit('stale_source',`Obligation report as-of ${o.report_as_of} is older than 30 days.`,o.reported_due_minor,o.id,undefined,undefined,[o.content_sha,o.report_as_of]);
    }
    for(const p of pays){
      const remaining=p.amount_minor-(allocByPay.get(p.id)||0);
      if(remaining>0&&!candidates.some(c=>c.payment_id===p.id))emit('unmatched_payment',`No eligible invoice candidate for unallocated ${p.payment_type} (${dollars(remaining)}).`,remaining,undefined,p.id,undefined,[p.content_sha,remaining]);
    }
    for(const c of candidates){const o=obls.find(o=>o.id===c.obligation_id),p=pays.find(p=>p.id===c.payment_id);
      if(o.amount_minor!==p.amount_minor)emit('amount_mismatch',`Same property and invoice reference, but obligation ${dollars(o.amount_minor)} and payment ${dollars(p.amount_minor)} differ.`,Math.abs(o.amount_minor-p.amount_minor),o.id,p.id,undefined,[o.content_sha,p.content_sha]);
    }
    const dup=rows(db,'SELECT property_id,invoice_ref,COUNT(*) n FROM obligations WHERE org_id=? GROUP BY property_id,invoice_ref HAVING COUNT(*)>1',org);
    for(const d of dup){for(const o of obls.filter(o=>o.property_id===d.property_id&&o.invoice_ref===d.invoice_ref))emit('duplicate_reference',`Invoice reference ${d.invoice_ref} appears ${d.n} times within the same property.`,o.amount_minor,o.id,undefined,undefined,[o.content_sha,d.n]);}
    const unmapped=rows(db,'SELECT s.* FROM source_rows s JOIN source_reports r ON s.report_id=r.id WHERE s.org_id=? AND s.validation_error LIKE ? AND r.kind IN (?,?)',org,'%property%', 'obligation','payment');
    for(const r of unmapped)emit('uncertain_identity',`Source row ${r.row_index}: ${r.validation_error}. No financial record was created.`,0,undefined,undefined,r.id,[r.row_fingerprint]);
    const conflicts=rows(db,'SELECT c.*,s.row_fingerprint FROM import_conflicts c JOIN source_rows s ON s.id=c.source_row_id WHERE c.org_id=? AND c.status=?',org,'pending');
    for(const c of conflicts)emit('conflicting_source_key',`Source key ${c.source_key} was reused with different contents; correction requires review.`,0,undefined,undefined,c.source_row_id,[c.row_fingerprint]);
    audit(db,org,'reconciliation.completed','reconciliation_run',runId,{rule_version:RULE_VERSION,exceptions:issueCount,candidates:candidates.length});
    return {run_id:runId,exceptions:issueCount,candidates:candidates.length};
  });
}
export function decideMatch(db:DB,candidateId:string,decision:'accepted'|'rejected',note:string,amountMinor:number|undefined,org=DEMO_ORG,actor='Demo Reviewer'){
  return transaction(db,()=>{
    const c=one(db,'SELECT c.*,p.amount_minor pay_amount,o.amount_minor obl_amount FROM match_candidates c JOIN payments p ON c.payment_id=p.id JOIN obligations o ON c.obligation_id=o.id WHERE c.id=? AND c.org_id=?',candidateId,org);
    if(!c)throw new DomainError('Candidate not found',404);
    if(c.status!=='proposed')throw new DomainError('Candidate already decided',409);
    const latest=one(db,'SELECT id FROM reconciliation_runs WHERE org_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',org);
    if(latest?.id!==c.run_id)throw new DomainError('Historical runs are read-only',409);
    const current=one(db,'SELECT o.content_sha ob_sha,p.content_sha pay_sha FROM obligations o JOIN payments p ON p.id=? WHERE o.id=? AND o.org_id=? AND p.org_id=?',c.payment_id,c.obligation_id,org,org);
    if(!current||c.evidence_hash!==sha(JSON.stringify([current.pay_sha,current.ob_sha,c.basis])))throw new DomainError('Candidate evidence changed; rerun reconciliation',409);
    let amount=0;
    if(decision==='accepted'){
      const pAllocated=one(db,'SELECT COALESCE(SUM(amount_minor),0) n FROM allocations WHERE payment_id=?',c.payment_id).n;
      const oAllocated=one(db,'SELECT COALESCE(SUM(amount_minor),0) n FROM allocations WHERE obligation_id=?',c.obligation_id).n;
      amount=amountMinor===undefined?Math.min(c.pay_amount-pAllocated,c.obl_amount-oAllocated):amountMinor;
      if(!Number.isSafeInteger(amount)||amount<=0)throw new DomainError('No unallocated amount remaining',409);
      addAllocation(db,org,c.payment_id,c.obligation_id,amount,actor);
    }
    run(db,'UPDATE match_candidates SET status=? WHERE id=? AND org_id=?',decision,candidateId,org);
    run(db,'INSERT INTO match_decisions VALUES (?,?,?,?,?,?,?,?)',id('decision'),org,candidateId,decision,amount,actor,String(note||'').slice(0,1000),now());
    audit(db,org,'match.'+decision,'match_candidate',candidateId,{allocation_minor:amount},actor);
    return {id:candidateId,decision,allocation_minor:amount};
  });
}
export function reviewException(db:DB,exceptionId:string,status:'open'|'reviewed'|'info_requested',owner:string,note:string,org=DEMO_ORG,actor='Demo Reviewer'){
  return transaction(db,()=>{
    const target=one(db,'SELECT id,run_id FROM exceptions WHERE id=? AND org_id=?',exceptionId,org);
    if(!target)throw new DomainError('Exception not found',404);
    const current=one(db,'SELECT id FROM reconciliation_runs WHERE org_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',org);
    if(target.run_id!==current?.id)throw new DomainError('Historical runs are read-only',409);
    if(owner.length>80||note.length>2000)throw new DomainError('Owner or note too long');
    run(db,'UPDATE exceptions SET status=?,owner=?,note=? WHERE id=? AND org_id=?',status,owner.trim()||'Unassigned',note,exceptionId,org);
    run(db,'INSERT INTO resolutions VALUES (?,?,?,?,?,?,?)',id('resolution'),org,exceptionId,status,actor,note,now());
    audit(db,org,'exception.'+status,'exception',exceptionId,{owner},actor);
    return {id:exceptionId,status};
  });
}
export function addAlias(db:DB,propertyId:string,alias:string,org=DEMO_ORG){
  const p=one(db,'SELECT * FROM properties WHERE id=? AND org_id=?',propertyId,org);
  if(!p)throw new DomainError('Property not found',404);if(!alias.trim()||alias.length>120)throw new DomainError('Invalid alias');
  const matches=propResolve(db,org,alias);
  if(matches.reason==='Ambiguous property identity')throw new DomainError('Alias collides with an ambiguous address',409);
  if(matches.id && matches.id!==propertyId)throw new DomainError('Alias already resolves to another property',409);
  try {run(db,'INSERT INTO aliases VALUES (?,?,?,?,?)',id('alias'),org,propertyId,alias.trim(),1);}catch(e){throw new DomainError('Alias already exists',409);}
  audit(db,org,'property.alias_added','property',propertyId,{alias});return {property_id:propertyId,alias};
}
export function state(db:DB,org=DEMO_ORG,selectedRun?:string){
  const currentRun=one(db,'SELECT * FROM reconciliation_runs WHERE org_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',org);
  const latest=selectedRun?one(db,'SELECT * FROM reconciliation_runs WHERE org_id=? AND id=?',org,selectedRun):currentRun;
  if(selectedRun&&!latest)throw new DomainError('Run not found',404);
  const frozen=latest?one(db,'SELECT snapshot_json FROM run_snapshots WHERE run_id=? AND org_id=?',latest.id,org):null;
  const snap=frozen?JSON.parse(frozen.snapshot_json):null;
  const obls=snap?snap.obligations:obligations(db,org),pays=snap?snap.payments:payments(db,org),allocs=snap?snap.allocations:allocations(db,org);
  const withAlloc=obls.map(o=>({...o,allocated_minor:allocs.filter(a=>a.obligation_id===o.id).reduce((s,a)=>s+a.amount_minor,0),remaining_minor:o.amount_minor-allocs.filter(a=>a.obligation_id===o.id).reduce((s,a)=>s+a.amount_minor,0)}));
  const exc=latest?rows(db,`SELECT e.*,o.invoice_ref,o.source_key obligation_key,o.reported_due_minor,o.amount_minor obligation_amount,o.due_date,o.report_id obligation_report,p.source_key payment_key,p.amount_minor payment_amount,p.report_id payment_report,
  COALESCE(o.currency,p.currency,'USD') currency FROM exceptions e LEFT JOIN obligations o ON o.id=e.obligation_id LEFT JOIN payments p ON p.id=e.payment_id WHERE e.org_id=? AND e.run_id=? ORDER BY CASE e.status WHEN 'open' THEN 0 WHEN 'info_requested' THEN 1 ELSE 2 END,e.kind,e.created_at`,org,latest.id):[];
  const candidates=latest?rows(db,`SELECT c.*,o.invoice_ref,o.source_key obligation_key,o.amount_minor obligation_amount,p.source_key payment_key,p.amount_minor payment_amount,o.currency,
  (p.amount_minor-(SELECT COALESCE(SUM(amount_minor),0) FROM allocations a WHERE a.payment_id=p.id)) available_payment_minor,
  (o.amount_minor-(SELECT COALESCE(SUM(amount_minor),0) FROM allocations a WHERE a.obligation_id=o.id)) outstanding_obligation_minor FROM match_candidates c JOIN payments p ON c.payment_id=p.id JOIN obligations o ON c.obligation_id=o.id WHERE c.org_id=? AND c.run_id=? ORDER BY c.status,c.basis`,org,latest.id):[];
  for(const e of exc){const o=obls.find(o=>o.id===e.obligation_id),p=pays.find(p=>p.id===e.payment_id);if(o){e.obligation_amount=o.amount_minor;e.reported_due_minor=o.reported_due_minor;e.obligation_report=o.report_id;e.due_date=o.due_date;e.currency=o.currency;}if(p){e.payment_amount=p.amount_minor;e.payment_report=p.report_id;e.currency=p.currency;}}
  for(const c of candidates){const o=obls.find(o=>o.id===c.obligation_id),p=pays.find(p=>p.id===c.payment_id);if(o)c.obligation_amount=o.amount_minor;if(p)c.payment_amount=p.amount_minor;}
  const reportRows=rows(db,'SELECT id,kind,filename,as_of,source_system,currency,uploaded_at FROM source_reports WHERE org_id=? ORDER BY uploaded_at DESC',org);
  const conflicts=rows(db,`SELECT c.*,s.raw_json,s.normalized_json FROM import_conflicts c JOIN source_rows s ON s.id=c.source_row_id WHERE c.org_id=? ORDER BY c.created_at DESC`,org);
  const unresolved=rows(db,`SELECT s.id,s.report_id,s.row_index,s.validation_error,s.raw_json FROM source_rows s WHERE s.org_id=? AND s.validation_error IS NOT NULL ORDER BY s.row_index`,org);
  const props=snap?.properties||rows(db,`SELECT p.*,e.name entity_name,(SELECT group_concat(alias, ', ') FROM aliases a WHERE a.property_id=p.id) aliases,(SELECT group_concat(source_system||': '||account_ref,'; ') FROM external_accounts a WHERE a.property_id=p.id) accounts FROM properties p JOIN entities e ON p.entity_id=e.id WHERE p.org_id=? ORDER BY p.id`,org);
  const metrics={original_obligations_minor:withAlloc.reduce((s,o)=>s+o.amount_minor,0),original_source_due_minor:withAlloc.reduce((s,o)=>s+o.reported_due_minor,0),explanatory_outstanding_minor:withAlloc.reduce((s,o)=>s+o.remaining_minor,0),allocated_minor:allocs.reduce((s,a)=>s+a.amount_minor,0),unresolved_exceptions:exc.filter(x=>x.status!=='reviewed').length};
  return {selected_historical:!!(selectedRun && currentRun && selectedRun!==currentRun.id),organization:one(db,'SELECT id,name,is_demo FROM organizations WHERE id=?',org),rule_version:RULE_VERSION,latest, runs:rows(db,'SELECT * FROM reconciliation_runs WHERE org_id=? ORDER BY created_at DESC LIMIT 20',org),metrics,properties:props,reports:reportRows,obligations:withAlloc,payments:pays,allocations:allocs,exceptions:exc,candidates,conflicts,unresolved, audit:rows(db,'SELECT * FROM audit_events WHERE org_id=? ORDER BY created_at DESC LIMIT 40',org)};
}
export function exportPack(db:DB,org=DEMO_ORG,runId?:string){
  const s=state(db,org,runId), reportIds=new Set<string>();for(const o of s.obligations)reportIds.add(o.report_id);for(const p of s.payments)reportIds.add(p.report_id);
  for(const e of s.exceptions){if(e.source_row_id){const r=one(db,'SELECT report_id FROM source_rows WHERE id=? AND org_id=?',e.source_row_id,org);if(r)reportIds.add(r.report_id);}}
  const sourceRows=rows(db,`SELECT s.id,s.report_id,s.row_index,s.kind,s.source_key,s.raw_json,s.normalized_json,s.validation_error FROM source_rows s WHERE s.org_id=?`,org).filter(r=>reportIds.has(r.report_id));
  const sourceReports=rows(db,'SELECT id,kind,filename,as_of,source_system,currency,raw_sha,uploaded_at FROM source_reports WHERE org_id=?',org).filter(r=>reportIds.has(r.id));
  const relevantIds=new Set([s.latest?.id,...sourceReports.map(r=>r.id),...s.exceptions.map(e=>e.id),...s.candidates.map(c=>c.id),...s.allocations.map(a=>a.id)]);
  return {manifest:{generated_at:now(),organization:s.organization.name,mode:'synthetic-demo',rule_version:s.latest?.rule_version||RULE_VERSION,selected_run:s.latest?.id||null,disclaimer:'Reconciled explanatory balances do not alter source balances and do not establish confirmed debt.',allocation_timing:'Totals are frozen at selected reconciliation run; decisions made afterward require another run.'},source_reports:sourceReports,property_registry:s.properties,source_rows:sourceRows.map(r=>({...r,raw:JSON.parse(r.raw_json),normalized:JSON.parse(r.normalized_json)})),original_obligations:s.obligations,original_payments:s.payments,allocations:s.allocations,candidates:s.candidates,exceptions:s.exceptions,resolutions:rows(db,'SELECT * FROM resolutions WHERE org_id=?',org).filter(r=>s.exceptions.some(e=>e.id===r.exception_id)),review_decisions:rows(db,'SELECT * FROM match_decisions WHERE org_id=?',org).filter(d=>s.candidates.some(c=>c.id===d.candidate_id)),metrics:s.metrics,audit_events:rows(db,'SELECT * FROM audit_events WHERE org_id=? ORDER BY created_at DESC',org).filter(e=>relevantIds.has(e.object_id))};
}