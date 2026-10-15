import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBankCSV } from '../netlify/functions/lib/bank-csv.mts';
import { metrics } from '../netlify/functions/lib/bank-metrics.mts';
import { seed } from '../netlify/functions/lib/bank-seed.mts';
import handler from '../netlify/functions/bank-transactions.mts';
import { signSession, OWNER_EMAIL } from '../netlify/shared/auth.ts';
process.env.LEDGER_PASSWORD='test-password-long';
const header='Date,Payee,Account #,Transaction Type,Description,Reference,Status,Amount,Currency,Balance\r\n';
const csv=header+'10/14/2026,"A, B",2910,Spend,"two\nlines","quote ""test""",SETTLED,-10.05,USD,100.00\r\n';
test('Relay parser handles quoted fields, dates, amounts and statement account',()=>{
 const [t]=parseBankCSV('\uFEFF'+csv,'Relay #8661.csv');assert.equal(t.payee,'A, B');assert.equal(t.description,'two\nlines');assert.equal(t.reference,'quote "test"');assert.equal(t.cents,-1005);assert.equal(t.account,'8661');assert.equal(t.date,'2026-10-14');
 assert.deepEqual(parseBankCSV(header,'Relay #8662.csv'),[]);
 assert.throws(()=>parseBankCSV(csv.replace('10/14/2026','2/30/2026'),'Relay #8661.csv'));
 assert.throws(()=>parseBankCSV(csv.replace('-10.05','garbage'),'Relay #8661.csv'));
 assert.throws(()=>parseBankCSV(csv,'renamed.csv'));
 assert.throws(()=>parseBankCSV('Date,Amount\n10/14/2026,1','Relay #8661.csv'));
 assert.equal(parseBankCSV(csv,'renamed.csv','8661')[0].id,t.id);
});
test('both archives are included; identities retain distinct equal-amount rows',()=>{
 assert.equal(seed.length,183);assert.equal(new Set(seed.map(t=>t.id)).size,183);
 assert.equal(parseBankCSV(csv+csv.split('\r\n').slice(1).join('\r\n'),'Relay #8661.csv').length,2);
});
test('P&L excludes transfers, capital and uncategorized; refunds reduce expenses',()=>{
 const t=seed[0];const rows=[['Revenue',10000],['Other income',100],['Cost of revenue',-2000],['Software',-500],['Software',100],['Transfer',50000],['Owner contribution',10000],['Owner distribution',-3000],['Uncategorized',7000]].map(([category,cents])=>({...t,category:String(category),cents:Number(cents)}));
 const m=metrics(rows);assert.equal(m.grossProfit,8000);assert.equal(m.netProfit,7700);assert.equal(m.expenses,400);assert.equal(m.unclassified,1);assert.equal(m.excluded,3);
});
test('bank endpoint enforces auth, validates preview, imports idempotently and saves categories',async()=>{
 assert.equal((await handler(new Request('https://test/api/bank-transactions'))).status,401);
 const {token}=await signSession({id:'owner',email:OWNER_EMAIL,name:'Owner'},'pin');
 const req=(body?:any)=>new Request('https://test/api/bank-transactions',{method:body?'POST':'GET',headers:{'x-ledger-auth':token},...(body?{body:JSON.stringify(body)}:{})});
 const initial=await (await handler(req())).json();assert.equal(initial.rows.length,183);
 const files=[{name:'Relay #8661.csv',text:csv}];
 let p=await (await handler(req({action:'preview',files}))).json();assert.equal(p.added,1);
 assert.equal((await (await handler(req())).json()).rows.length,183);
 let r=await (await handler(req({action:'import',files}))).json();assert.equal(r.added,1);
 r=await (await handler(req({action:'import',files}))).json();assert.equal(r.added,0);assert.equal(r.duplicates,1);
 const id=p.sample[0].id;assert.equal((await handler(req({action:'categorize',ids:[id],category:'Software'}))).status,200);
 assert.equal((await (await handler(req())).json()).rows.find((t:any)=>t.id===id).reviewed,true);
 assert.equal((await handler(req({action:'categorize',ids:[id],category:'bogus'}))).status,400);
 assert.equal((await handler(req({action:'import',files:[{name:'Relay #8661.csv',text:'bad'}]}))).status,400);
});
