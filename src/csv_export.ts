import {DB,DEMO_ORG} from './db';
import {DomainError,dollars,state} from './domain';

// Spreadsheet applications may evaluate cells beginning with =, +, -, @, or
// whitespace followed by these characters. Quote CSV and neutralize formulas.
function csvCell(value:unknown):string {
  const original=String(value??'');
  const safe=/^\s*[=+\-@]/.test(original)?"'"+original:original;
  return '"'+safe.replace(/"/g,'""')+'"';
}

export function exceptionQueueCSV(db:DB,org=DEMO_ORG,runId?:string){
  const snapshot=state(db,org,runId);
  if(!snapshot.latest)throw new DomainError('No reconciliation run to export',409);
  const header=['run_id','exception_id','kind','obligation_key','payment_key','invoice_ref','difference_usd','currency','status','owner','reason','review_note','rule_version'];
  const records=snapshot.exceptions.map(e=>[
    snapshot.latest.id,e.id,e.kind,e.obligation_key,e.payment_key,e.invoice_ref,
    dollars(e.amount_minor),e.currency,e.status,e.owner,e.reason,e.note,
    snapshot.latest.rule_version
  ]);
  const csv=[header,...records].map(record=>record.map(csvCell).join(',')).join('\r\n')+'\r\n';
  const safeId=String(snapshot.latest.id).replace(/[^a-z0-9_-]/gi,'');
  return {filename:'reconciliation-exceptions-'+safeId+'.csv',csv,count:records.length};
}
