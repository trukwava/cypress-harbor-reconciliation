import fs from 'node:fs';
import path from 'node:path';
import {DB,DEMO_ORG,OTHER_ORG,id,one,rows,run,transaction} from './db';
import {addAllocation,commitImport,reconcile} from './domain';
const addresses=[
  '14 Ocean Avenue, Brooklyn NY 11225','22 Bayview Road, Brooklyn NY 11224',
  '88 Bay Street, Brooklyn NY 11231','88 Bay Street, Brooklyn NY 11231',
  '35 Grand Street, Brooklyn NY 11211','912 Myrtle Avenue, Brooklyn NY 11206',
  '70 Union Street, Brooklyn NY 11231','45 Prospect Place, Brooklyn NY 11217',
  '181 Atlantic Avenue, Brooklyn NY 11201','50 4th Avenue, Brooklyn NY 11217',
  '901 Bedford Avenue, Brooklyn NY 11205','420 East 3rd Street, Brooklyn NY 11218'
];
function csvEscape(v:string|number){let s=String(v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
function csv(header:string[],records:(string|number)[][]){return [header.join(','),...records.map(r=>r.map(csvEscape).join(','))].join('\n')+'\n';}
export function generateFixtures(){
  const oh=['obligation_key','property_ref','invoice_ref','amount','reported_due','due_date','currency'];
  const ph=['payment_key','property_ref','invoice_ref','amount','transaction_date','posted_date','currency','type'];
  const obls:(string|number)[][]=[];
  for(let i=0;i<39;i++){
    const property=`CHH-P${String(i%12+1).padStart(2,'0')}`;
    let invoice=i===0||i===1?'101':String(1000+i);
    const amount=i===0?'1000.00':i===1?'750.00':(350+i*17).toFixed(2);
    obls.push([`OBL-${String(i+1).padStart(3,'0')}`,property,invoice,amount,amount,'2026-10-15','USD']);
  }
  // Duplicate invoice 101, but across different properties (not a conflict).
  obls[1][1]='CHH-P02';
  // One ambiguous physical address is intentionally unresolvable without a stable ID.
  obls.push(['OBL-AMB','88 Bay Street, Brooklyn NY 11231','AMB-1','700.00','700.00','2026-10-15','USD']);
  const pays:(string|number)[][]=[];
  for(let i=0;i<35;i++){
    const property=i===1?'CHH-P02':`CHH-P${String(i%12+1).padStart(2,'0')}`;
    const invoice=i===0||i===1?'101':String(1000+i);
    let amount=i===0?'600.00':i===1?'750.00':(350+i*17).toFixed(2);
    if(i===5)amount='100.00'; // second partial allocation
    if(i===10)amount=(350+i*17+25).toFixed(2); // reviewable amount mismatch
    const type=i===20?'credit':'payment';
    pays.push([`PAY-${String(i+1).padStart(3,'0')}`,property,i===33?'MISSING-INV':invoice,amount,'2026-10-16','2026-10-17','USD',type]);
  }
  const obl=csv(oh,obls),pay=csv(ph,pays);
  const stale=csv(oh,[['OBL-STALE','CHH-P12','HIST-1','250.00','250.00','2026-06-20','USD']]);
  const malformed='payment_key,property_ref,invoice_ref,amount,transaction_date,posted_date,currency,type\nBAD-01,CHH-P01,999,"broken,2026-10-16,2026-10-17,USD,payment\n';
  const correction=csv(oh,[['OBL-001','CHH-P01','101','1000.00','900.00','2026-10-15','USD']]);
  return {obl,pay,stale,malformed,correction};
}
export function writeFixtureFiles(dir:string){const f=generateFixtures();fs.mkdirSync(dir,{recursive:true});
  for(const [name,body] of Object.entries({'obligations_october.csv':f.obl,'payments_october.csv':f.pay,'obligations_stale.csv':f.stale,'malformed_payments.csv':f.malformed,'obligation_correction_requires_review.csv':f.correction}))fs.writeFileSync(path.join(dir,name),body);
}
export function seed(db:DB,force=false){
  if(!force && one(db,'SELECT id FROM organizations WHERE id=?',DEMO_ORG))return;
  transaction(db,()=>{
    run(db,'INSERT OR IGNORE INTO organizations VALUES (?,?,?)',DEMO_ORG,'Cypress Harbor Housing (synthetic)',1);
    run(db,'INSERT OR IGNORE INTO organizations VALUES (?,?,?)',OTHER_ORG,'Other Organization – isolation fixture',1);
    for(let i=0;i<3;i++)run(db,'INSERT INTO entities VALUES (?,?,?)',`CHH-E${i+1}`,DEMO_ORG,`Cypress Harbor Entity ${i+1}`);
    for(let i=0;i<addresses.length;i++){
      const pid=`CHH-P${String(i+1).padStart(2,'0')}`;
      run(db,'INSERT INTO properties VALUES (?,?,?,?,?)',pid,DEMO_ORG,`CHH-E${i%3+1}`,addresses[i],i===2?'300-00001-0003':i===3?'300-00001-0004':null);
      run(db,'INSERT INTO external_accounts VALUES (?,?,?,?,?)',id('account'),DEMO_ORG,pid,'HousingLedger',`ACCT-${i+1}`);
    }
    run(db,'INSERT INTO aliases VALUES (?,?,?,?,?)',id('alias'),DEMO_ORG,'CHH-P01','Ocean House',1);
    run(db,'INSERT INTO aliases VALUES (?,?,?,?,?)',id('alias'),DEMO_ORG,'CHH-P02','Bayview Homes',1);
    run(db,'INSERT OR IGNORE INTO entities VALUES (?,?,?)','OTHER-E1',OTHER_ORG,'Other Entity');
    run(db,'INSERT OR IGNORE INTO properties VALUES (?,?,?,?,?)','OTHER-P1',OTHER_ORG,'OTHER-E1','1 External Road, Brooklyn NY',null);
  });
  const f=generateFixtures();
  commitImport(db,{kind:'obligation',filename:'obligations_october.csv',csv:f.obl,as_of:'2026-10-20',source_system:'MunicipalLedger',currency:'USD'});
  commitImport(db,{kind:'payment',filename:'payments_october.csv',csv:f.pay,as_of:'2026-10-21',source_system:'VendorPayments',currency:'USD'});
  commitImport(db,{kind:'obligation',filename:'obligations_stale.csv',csv:f.stale,as_of:'2026-08-01',source_system:'MunicipalLedger',currency:'USD'});
  const o1=one(db,'SELECT id FROM obligations WHERE source_key=? AND org_id=?','OBL-001',DEMO_ORG);
  const p1=one(db,'SELECT id FROM payments WHERE source_key=? AND org_id=?','PAY-001',DEMO_ORG);
  addAllocation(db,DEMO_ORG,p1.id,o1.id,60000,'Seed fixture');
  const o6=one(db,'SELECT id FROM obligations WHERE source_key=? AND org_id=?','OBL-006',DEMO_ORG);
  const p6=one(db,'SELECT id FROM payments WHERE source_key=? AND org_id=?','PAY-006',DEMO_ORG);
  addAllocation(db,DEMO_ORG,p6.id,o6.id,10000,'Seed fixture');
  // A separate complete allocation illustrates an already-settled item.
  const o2=one(db,'SELECT id FROM obligations WHERE source_key=? AND org_id=?','OBL-002',DEMO_ORG);
  const p2=one(db,'SELECT id FROM payments WHERE source_key=? AND org_id=?','PAY-002',DEMO_ORG);
  addAllocation(db,DEMO_ORG,p2.id,o2.id,75000,'Seed fixture');
  reconcile(db);
}
export function resetDemo(db:DB){
  transaction(db,()=>{
    const tables=['audit_events','resolutions','exceptions','match_decisions','match_candidates','run_snapshots','reconciliation_runs','import_conflicts','allocations','obligations','payments','source_rows','import_batches','source_reports','aliases','external_accounts','properties','entities'];
    for(const t of tables)run(db,`DELETE FROM ${t} WHERE ${t==='organizations'?'id':'org_id'}=?`,DEMO_ORG);
  });
  seed(db,true);
  return {reset:true,org:DEMO_ORG};
}