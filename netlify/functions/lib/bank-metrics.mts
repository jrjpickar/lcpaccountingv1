import type { BankTransaction } from './bank-csv.mts';
export const categories = ['Uncategorized','Revenue','Other income','Cost of revenue','Marketing','Software','Professional fees','Bank fees','Meals','Payroll','Other expense','Transfer','Owner contribution','Owner distribution'];
export type Classification = {category:string;owner:string;needsReview:boolean;reason:string};
const internalAccounts=new Set(['2910','2911','7503','7510','8661','8662']);
export function classify(t: BankTransaction, sources: Record<string,string> = {}): Classification {
 const result=(category:string,reason:string,owner='',needsReview=false)=>({category,reason,owner,needsReview});
 const namedOwner=/arturo|\bart\b/i.test(t.payee)?'Art':/bryce/i.test(t.payee)?'Bryce':/jesse/i.test(t.payee)?'Jesse':'';
 if(/ACH Pull/i.test(t.reference) && t.cents>0){
  const owner=sources[t.payee] || (/adv plus banking/i.test(t.payee)?'Art':'');
  return result('Owner contribution',owner?'ACH contribution; bank-source owner mapping.':'ACH contribution; confirm who owns this bank source.',owner,!owner);
 }
 if((t.counterpartyAccount && internalAccounts.has(t.counterpartyAccount)) || /transfer/i.test(t.type))return result('Transfer','Movement between supplied Relay accounts; exclude from combined P&L and external cash totals.',namedOwner);
 if(/localcare|dodger city/i.test(t.payee))return result('Transfer','LocalCare / Dodger City movement; counterpart appears in the supplied statements.');
 if(/capital repayment|capital return/i.test(t.reference))return result('Owner distribution','Explicit capital return; exclude from P&L.',namedOwner);
 if(/interest/i.test(t.reference) && t.cents>0)return result('Other income','Relay interest credit.');
 if(t.cents>0 && /golden coast escrow/i.test(t.payee))return result('Revenue','Escrow proceeds provisionally classified as deal revenue. Confirm earned fee versus returned principal or deposit.','',true);
 if(t.cents<0){
  if(/reimbursement for twilio/i.test(t.reference))return result('Marketing','Twilio reimbursement explicitly identified in the reference.','Art');
  if(/ACH Push/i.test(t.reference)&&/arturo/i.test(t.reference))return result('Owner distribution','ACH return to Arturo; confirm whether capital return or business reimbursement.','Art',true);
  if(/payroll/i.test(t.reference)&&namedOwner)return result('Owner distribution',(namedOwner==='Art'?'Art payout equals the $5,148 capital repayment plus $1,429.84 royalty received in account 7503. Confirm royalty treatment.':'Jesse payout follows a mixed acquisition/disposition commission + royalty transfer. The CSV does not separate compensation from distributions.'),namedOwner,true);
  if(/twilio|batchleads/i.test(t.payee))return result('Marketing','Lead-generation / communications vendor.');
  if(/netlify|openai|^make$|google|ionos|slack|highlevel|perplexity/i.test(t.payee))return result('Software','Identifiable software / hosting vendor.');
  if(/attorney/i.test(t.payee))return result('Professional fees','Legal services vendor.');
  if(/banking fees/i.test(t.reference))return result('Bank fees','Relay banking fee.');
  if(/ranchito/i.test(t.payee))return result('Meals','Restaurant merchant; confirm business purpose and tax treatment.','',true);
  if(/ENT PRO/i.test(t.payee))return result('Other expense','Unclear merchant descriptor; confirm expense purpose.','',true);
 }
 return result('Uncategorized','Insufficient detail in statement.','',true);
}
export const suggestedCategory=(t:BankTransaction)=>classify(t).category;
export function metrics(rows: (BankTransaction & {category: string})[]) {
 let income=0,otherIncome=0,cost=0,expenses=0,inflow=0,outflow=0,unclassified=0,excluded=0,contributions=0,distributions=0,transferVolume=0;
 const expenseCategories=new Set(['Marketing','Software','Professional fees','Bank fees','Meals','Payroll','Other expense']);
 for(const t of rows){if(t.status!=='SETTLED')continue;
 if(t.category==='Transfer')transferVolume+=Math.abs(t.cents);else if(t.cents>0)inflow+=t.cents;else outflow-=t.cents;
 if(t.category==='Owner contribution')contributions+=t.cents;
 if(t.category==='Owner distribution')distributions-=t.cents;
 if(t.category==='Revenue')income+=t.cents;
 else if(t.category==='Other income')otherIncome+=t.cents;
 else if(t.category==='Cost of revenue')cost-=t.cents;
 else if(expenseCategories.has(t.category))expenses-=t.cents;
 else if(t.category==='Uncategorized')unclassified++;else excluded++;
 }
 return {income,otherIncome,cost,expenses,grossProfit:income-cost,netProfit:income+otherIncome-cost-expenses,inflow,outflow,netMovement:inflow-outflow,unclassified,excluded,contributions,distributions,transferVolume,count:rows.length};
}
