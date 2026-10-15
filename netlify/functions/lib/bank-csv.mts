import { createHash } from 'node:crypto';
export type BankTransaction = { id: string; account: string; counterpartyAccount?: string; date: string; payee: string; type: string; description: string; reference: string; status: string; cents: number; currency: string; balanceCents: number; source: string };
export function csvRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i=0;i<text.length;i++) { const c=text[i];
    if(c==='"') { if(quoted && text[i+1]==='"'){cell+='"';i++;} else if(quoted || !cell) quoted=!quoted; else throw new Error('Unexpected quote in CSV'); }
    else if(!quoted && (c===',' || c==='\n' || c==='\r')) { row.push(cell);cell='';if(c!==','){if(row.some(x=>x.trim()))rows.push(row);row=[];if(c==='\r' && text[i+1]==='\n')i++;} }
    else cell+=c;
  }
  if(quoted)throw new Error('Unclosed CSV quote');
  row.push(cell);if(row.some(x=>x.trim()))rows.push(row);return rows;
}
function cents(value: string): number { const v=value.trim().replace(/[$,]/g,'');if(!/^[+-]?\d+(\.\d{1,2})?$/.test(v))throw new Error('Invalid money value'); const n=Math.round(Number(v)*100);if(!Number.isSafeInteger(n))throw new Error('Amount too large');return n; }
export function parseBankCSV(text: string, source: string, accountOverride=''): BankTransaction[] {
  const rows=csvRows(text), headers=rows.shift()?.map(x=>x.trim());
  const expected=['Date','Payee','Account #','Transaction Type','Description','Reference','Status','Amount','Currency','Balance'];
  if(!headers || expected.some(x=>!headers.includes(x)))throw new Error('Expected a Relay statement CSV with Date, Payee, Account #, Transaction Type, Description, Reference, Status, Amount, Currency, Balance columns');
  // Account # in a Relay row is the counterparty, NOT the statement account.
  const account=source.match(/#(\d+)\.csv$/i)?.[1] || accountOverride.trim();
  if(!/^\d{4,17}$/.test(account))throw new Error('Keep the Relay filename with #account.csv, or enter the statement account number (4–17 digits)');
  const seen=new Map<string,number>();
  return rows.map((cells,i)=>{ try {
    if(cells.length!==headers.length)throw new Error('Column count mismatch');
    const row=Object.fromEntries(headers.map((h,j)=>[h,cells[j].trim()]));
    const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(row.Date);if(!m)throw new Error('Invalid date');
    const date=`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
    if(new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw new Error('Invalid date');
    if(!/^[A-Z]{3}$/.test(row.Currency))throw new Error('Invalid currency');
    const item={account,date,payee:row.Payee,type:row['Transaction Type'],description:row.Description,reference:row.Reference,status:row.Status,cents:cents(row.Amount),currency:row.Currency,balanceCents:cents(row.Balance)};
    const canonical=JSON.stringify({...item,counterparty:row['Account #']});const ordinal=(seen.get(canonical)||0)+1;seen.set(canonical,ordinal);
    return {id:createHash('sha256').update(canonical+'|'+ordinal).digest('hex'),...item,counterpartyAccount:row['Account #'],source};
  }catch(e:any){throw new Error(`${source}, row ${i+2}: ${e.message}`);} });
}
