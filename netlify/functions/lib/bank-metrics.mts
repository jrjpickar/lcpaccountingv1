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
// Owner-paid vendor charges. When a partner pays a vendor personally, the
// statement can carry BOTH legs: the vendor charge and an ACH pull that
// records the partner's contribution for it. They are one event: the expense
// counts once, the contribution counts once, and no business cash moved, so
// both legs are kept out of external cash in / out. A pair needs the same
// account, opposite equal amounts, dates within 3 days, and evidence in the
// text (the charge says personal card / paid by, or the pull names the vendor).
export type Pairable = BankTransaction & {category:string;owner?:string;reason?:string;pairId?:string|null;pairPayee?:string;ownerPaid?:boolean;excludeFromCash?:boolean;contribType?:'paid'|'deposited';contribSource?:'auto'|'manual';contribNote?:string};
// A partner's own call on a contribution, saved from the Bills tab:
//   paid      - the money covered a vendor charge; expenseId links that charge
//               (same amount), or null when the charge isn't in Relay (note = vendor)
//   deposited - plain cash into the account; never auto-paired
export type ContribOverride = {type:'paid'|'deposited';expenseId?:string|null;note?:string;by?:string;at?:string};
const NON_EXPENSE=new Set(['Transfer','Owner contribution','Owner distribution','Revenue','Other income']);
export const isExpenseRow=(t:{cents:number;category:string;status:string})=>t.cents<0&&t.status!=='DECLINED'&&!NON_EXPENSE.has(t.category);
const dayNum=(d:string)=>Date.parse(d+'T00:00:00Z')/86400000;
const words=(s:string)=>s.toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>=3);
export function pairOwnerPaid<T extends Pairable>(rows:T[],overrides:Record<string,ContribOverride>={}):T[]{
 const out=rows.map(t=>({...t,pairId:null,ownerPaid:false,excludeFromCash:false}));
 const byId=new Map(out.map(t=>[t.id,t]));
 const contribs=out.filter(t=>t.category==='Owner contribution'&&t.cents>0&&t.status!=='DECLINED');
 const used=new Set<string>();
 const pair=(c:T,e:T,source:'auto'|'manual')=>{
  used.add(e.id);used.add(c.id);
  const id=c.id+'|'+e.id, who=c.owner||e.owner||'';
  Object.assign(c,{pairId:id,pairPayee:e.payee,excludeFromCash:true,contribType:'paid',contribSource:source,reason:(source==='manual'?'Marked owner paid: ':'')+'contribution for '+e.payee+' paid personally'+(who?' by '+who:'')+'; counted once, no business cash moved.'});
  Object.assign(e,{pairId:id,ownerPaid:true,excludeFromCash:true,owner:e.owner||who,reason:'Paid personally'+(who?' by '+who:'')+'; matched to the '+c.date+' contribution. Expense counts once, no business cash moved.'});
 };
 // 1. Partner decisions win.
 for(const c of contribs){
  const o=overrides[c.id];if(!o)continue;
  if(o.type==='deposited'){used.add(c.id);Object.assign(c,{contribType:'deposited',contribSource:'manual',reason:'Marked owner deposited: cash into the account.'});continue;}
  const e=o.expenseId?byId.get(o.expenseId):null;
  if(e&&!used.has(e.id)&&isExpenseRow(e)&&e.cents===-c.cents){pair(c,e,'manual');continue;}
  used.add(c.id);
  Object.assign(c,{contribType:'paid',contribSource:'manual',contribNote:o.note||'',pairPayee:o.note||'Vendor (not in Relay)',reason:'Marked owner paid'+(o.note?' for '+o.note:'')+'; the vendor charge is not in the Relay imports.'});
 }
 // 2. Auto-match the rest: a vendor charge with the opposite equal amount on the
 // same account within 3 days, with evidence in the text.
 for(const c of contribs){
  if(used.has(c.id))continue;
  let best:T|null=null,bestGap=99;
  for(const e of out){
   if(used.has(e.id)||e.cents!==-c.cents||e.account!==c.account||!isExpenseRow(e))continue;
   const gap=Math.abs(dayNum(e.date)-dayNum(c.date));if(gap>3)continue;
   const eText=e.reference+' '+e.description, cText=(c.reference+' '+c.description).toLowerCase();
   const evidence=/personal(ly)? card|paid (personally )?by|paid personally|covered/i.test(eText)||words(e.payee).some(w=>cText.includes(w));
   if(evidence&&gap<bestGap){best=e;bestGap=gap;}
  }
  if(best)pair(c,best,'auto');
  else Object.assign(c,{contribType:'deposited',contribSource:'auto'});
 }
 return out;
}
export const suggestedCategory=(t:BankTransaction)=>classify(t).category;
export function metrics(rows: (BankTransaction & {category: string; excludeFromCash?: boolean})[]) {
 let income=0,otherIncome=0,cost=0,expenses=0,inflow=0,outflow=0,unclassified=0,excluded=0,contributions=0,distributions=0,transferVolume=0;
 const expenseCategories=new Set(['Marketing','Software','Professional fees','Bank fees','Meals','Payroll','Other expense']);
 for(const t of rows){if(t.status!=='SETTLED')continue;
 if(t.category==='Transfer')transferVolume+=Math.abs(t.cents);else if(t.excludeFromCash){}else if(t.cents>0)inflow+=t.cents;else outflow-=t.cents;
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
