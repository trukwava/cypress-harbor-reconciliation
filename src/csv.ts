export function parseCSV(text:string): {headers:string[],records:Record<string,string>[],error?:string} {
  if (text.length > 2_000_000) return {headers:[],records:[],error:'CSV exceeds 2 MB limit'};
  const all:string[][]=[];let field='', row:string[]=[], quoted=false;
  const t=text.replace(/^\uFEFF/,'');
  for(let i=0;i<t.length;i++){
    const c=t[i];
    if(quoted){ if(c==='"' && t[i+1]==='"'){field+='"';i++;}else if(c==='"'){quoted=false;}else field+=c; }
    else if(c==='"'){if(field!=='')return {headers:[],records:[],error:`Unexpected quote at character ${i}`};quoted=true;}
    else if(c===','){row.push(field);field='';}
    else if(c==='\n'){row.push(field.replace(/\r$/,''));if(row.some(x=>x!==''))all.push(row);row=[];field='';}
    else field+=c;
  }
  if(quoted)return {headers:[],records:[],error:'Unclosed quoted field'};
  row.push(field.replace(/\r$/,''));if(row.some(x=>x!==''))all.push(row);
  const headers=(all.shift()||[]).map(x=>x.trim());
  if(!headers.length||headers.some(x=>!x))return {headers:[],records:[],error:'CSV requires nonblank headers'};
  if(new Set(headers).size!==headers.length)return {headers,records:[],error:'Duplicate column header'};
  if(all.length>5000)return {headers,records:[],error:'Maximum 5,000 records per report'};
  const records:Record<string,string>[]=[];
  for(let i=0;i<all.length;i++){
    if(all[i].length!==headers.length)return {headers,records:[],error:`Row ${i+2} has ${all[i].length} columns, expected ${headers.length}`};
    const r:Record<string,string>={};headers.forEach((h,j)=>r[h]=all[i][j]);records.push(r);
  }
  return {headers,records};
}
export const required = {
  obligation:['obligation_key','property_ref','invoice_ref','amount','reported_due','due_date','currency'],
  payment:['payment_key','property_ref','invoice_ref','amount','transaction_date','posted_date','currency','type']
};